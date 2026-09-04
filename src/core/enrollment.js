/**
 * Core enrollment — pairing code → device token
 *
 * Auth-agnostic: this is the pure device protocol.
 * The calling layer (hosted or standalone) handles access control.
 */

import crypto from 'node:crypto';
import * as db from './queries.js';
import { getMqttUrl } from './mqtt-endpoint.js';
import { newConfigPassword } from './config-password.js';

/**
 * Generate a secure device token.
 */
function generateToken() {
  return 'pst_' + crypto.randomBytes(32).toString('hex');
}

/**
 * Process a device enrollment request.
 * Handles both PUL- (single device) and PLF- (fleet) codes.
 * @param {string} pairingCode - Pairing code from device
 * @param {object} meta - { fw_version, mac_address, device_name }
 * @returns {{ success: boolean, token?: string, error?: string }}
 */
export async function processEnrollment(pairingCode, meta = {}) {
  if (!pairingCode || typeof pairingCode !== 'string') {
    return { success: false, error: 'Missing pairing code' };
  }

  const code = pairingCode.trim();

  // Route based on prefix
  const result = code.startsWith('PLF-')
    ? await processFleetEnrollment(code, meta)
    : await processDeviceEnrollment(code, meta);

  // On success, tell the device where the MQTT broker lives so it doesn't have
  // to derive it from the HTTP host (which may differ, esp. in hosted mode).
  if (result && result.success) {
    const mqttUrl = getMqttUrl();
    if (mqttUrl) result.mqtt_url = mqttUrl;
  }

  return result;
}

/**
 * Single-device enrollment (PUL- codes).
 */
async function processDeviceEnrollment(pairingCode, meta) {
  const device = await db.findDeviceByPairingCode(pairingCode);
  if (!device) {
    return { success: false, error: 'Invalid pairing code' };
  }

  // Already enrolled — return existing token + config password hash.
  if (device.token) {
    const hash = await ensureConfigPassword(device.id);
    return { success: true, token: device.token, config_pw_hash: hash };
  }

  const token = generateToken();
  const enrolled = await db.enrollDevice(device.id, token);
  if (!enrolled) {
    return { success: false, error: 'Enrollment failed' };
  }

  // Update metadata
  if (meta.mac_address) await db.updateDeviceMac(device.id, meta.mac_address);
  if (meta.fw_version) await db.updateDeviceHeartbeat(device.id, { fwVersion: meta.fw_version });
  if (meta.device_name) await db.updateDeviceName(device.id, meta.device_name);

  // Generate the config-portal password now that the device is enrolled. The
  // device stores the hash; the plaintext stays server-side for reveal.
  const hash = await ensureConfigPassword(device.id);

  console.log(`[ENROLL] Device ${device.id} enrolled (code: ${pairingCode}, mac: ${meta.mac_address || 'n/a'})`);
  return { success: true, token, config_pw_hash: hash };
}

/**
 * Ensure a device has a config-portal password. Generates one if missing.
 * Returns the current password hash (to hand to the device).
 */
async function ensureConfigPassword(deviceId) {
  const existing = await db.getDeviceConfigPassword(deviceId);
  if (existing && existing.config_password_hash) {
    return existing.config_password_hash;
  }
  const { password, hash } = newConfigPassword();
  await db.setDeviceConfigPassword(deviceId, password, hash);
  console.log(`[ENROLL] Generated config-portal password for device ${deviceId}`);
  return hash;
}

/**
 * Fleet enrollment (PLF- codes).
 * One code, many devices. Each device identified by MAC.
 */
async function processFleetEnrollment(fleetCode, meta) {
  const fleet = await db.findFleetCode(fleetCode);
  if (!fleet) {
    return { success: false, error: 'Invalid fleet code' };
  }

  if (!fleet.is_active) {
    return { success: false, error: 'Fleet code is deactivated' };
  }

  if (!meta.mac_address) {
    return { success: false, error: 'MAC address required for fleet enrollment' };
  }

  // Check max device limit
  if (fleet.max_devices > 0 && fleet.enrolled_count >= fleet.max_devices) {
    return { success: false, error: 'Fleet device limit reached' };
  }

  // Check MAC allowlist (if configured)
  const allowlist = fleet.mac_allowlist || [];
  if (allowlist.length > 0 && !allowlist.includes(meta.mac_address)) {
    return { success: false, error: 'MAC address not in allowlist' };
  }

  // Check if this MAC already enrolled under this fleet
  const existing = await db.findDeviceByMac(meta.mac_address);
  if (existing && existing.token) {
    const hash = await ensureConfigPassword(existing.id);
    return { success: true, token: existing.token, config_pw_hash: hash };
  }

  // Create new device under this fleet
  const deviceName = meta.device_name || `Device-${meta.mac_address.slice(-5).replace(':', '')}`;
  const device = await db.createDeviceFromFleet(fleet.id, meta.mac_address, deviceName);

  // Generate and assign token
  const token = generateToken();
  await db.enrollDevice(device.id, token);
  await db.incrementFleetCount(fleet.id);

  if (meta.fw_version) {
    await db.updateDeviceHeartbeat(device.id, { fwVersion: meta.fw_version });
  }

  const hash = await ensureConfigPassword(device.id);

  console.log(`[ENROLL] Fleet device ${device.id} enrolled (fleet: ${fleetCode}, mac: ${meta.mac_address})`);
  return { success: true, token, config_pw_hash: hash };
}

/**
 * Regenerate a device's config-portal password. Returns the new plaintext (for
 * an immediate dashboard reveal) and its hash. The new hash reaches the device
 * on its next heartbeat; the old password stops working once the device stores
 * it. Intended for the dashboard "regenerate" action (behind admin login).
 * @param {string} deviceId
 * @returns {{ password: string, hash: string }}
 */
export async function regenerateDeviceConfigPassword(deviceId) {
  const { password, hash } = newConfigPassword();
  await db.setDeviceConfigPassword(deviceId, password, hash);
  console.log(`[CONFIG-PW] Regenerated config-portal password for device ${deviceId}`);
  return { password, hash };
}

/**
 * Generate a new pairing code (for portal/API use).
 * @param {string} name - Optional device name
 * @returns {{ pairingCode: string, deviceId: string }}
 */
export async function createPairingCode(name = null) {
  // Generate PUL-XXXXXX format
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = 'PUL-';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  const device = await db.createDevice(code, name);
  console.log(`[ENROLL] Pairing code created: ${code} (device: ${device.id})`);
  return { pairingCode: code, deviceId: device.id };
}

/**
 * Generate a new fleet code.
 * @param {string} name - Fleet/project name
 * @param {number} maxDevices - Max devices (0 = unlimited)
 * @returns {{ fleetCode: string, fleetId: number }}
 */
export async function createFleetCode(name = null, maxDevices = 0) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = 'PLF-';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  const fleet = await db.createFleetCode(code, name, maxDevices);
  console.log(`[ENROLL] Fleet code created: ${code} (max: ${maxDevices || 'unlimited'})`);
  return { fleetCode: code, fleetId: fleet.id };
}
