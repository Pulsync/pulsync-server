/**
 * Core heartbeat — process device check-in
 *
 * Receives device status, returns config + OTA + commands.
 * Auth-agnostic: receives already-validated deviceId.
 */

import * as db from './queries.js';
import { getBaseUrl } from './base-url.js';
import { getMqttUrl } from './mqtt-endpoint.js';
import { notifyOTA } from './frontend-ws.js';
import { signOtaOffer, OTA_SIG_ALG } from './device-signing.js';

/**
 * Process a heartbeat from a device.
 * @param {string} deviceId - UUID of the device
 * @param {object} payload - { uptime, free_heap, fw_version, rssi }
 * @param {object} options - { ip } from request context
 * @returns {object} Response for the device
 */
export async function processHeartbeat(deviceId, payload = {}, options = {}) {
  const { fw_version, uptime, free_heap, rssi } = payload;

  // Capture the previously-recorded firmware version so we can detect an OTA
  // that completed (device rebooted into new firmware and now reports it).
  let prevFwVersion = null;
  let deviceToken = null;
  try {
    const existing = await db.findDeviceById(deviceId);
    prevFwVersion = existing ? existing.fw_version : null;
    deviceToken = existing ? existing.token : null;
  } catch { /* non-fatal */ }

  // Update last_seen and firmware version
  await db.updateDeviceHeartbeat(deviceId, {
    fwVersion: fw_version || null,
    ip: options.ip || null,
  });

  // Detect a completed OTA: fw_version changed from what we last saw.
  if (fw_version && prevFwVersion && fw_version !== prevFwVersion) {
    notifyOTA(deviceId, 'updated', fw_version);
  }

  // Build response
  const response = {};

  // Advertise the current MQTT endpoint. The device compares it against what
  // it's using and only reconnects if it changed (broker moved/migrated).
  const mqttUrl = getMqttUrl();
  if (mqttUrl) response.mqtt_url = mqttUrl;

  // Advertise the current config-portal password hash. The device compares it
  // against its stored hash and updates NVS if it changed (regeneration from
  // the dashboard rotates it — old password stops working). Same channel as
  // mqtt_url/token rotation; device stores the hash only, never the plaintext.
  try {
    const pw = await db.getDeviceConfigPassword(deviceId);
    if (pw && pw.config_password_hash) {
      response.config_pw_hash = pw.config_password_hash;
    }
  } catch { /* non-fatal — older rows may predate the column */ }

  // Attach config if there are any configured values
  const config = await db.getDeviceConfigs(deviceId);
  if (Object.keys(config).length > 0) {
    response.config = config;
  }

  // Check for OTA update — per-device assignment (free-tier targeting).
  // A firmware is offered only to devices it has been explicitly attached to.
  // "Attach" is deliberate, so we offer whenever the assigned version differs
  // from what the device reports (string inequality) — this intentionally
  // supports downgrades / rollback-by-attach, not just upgrades.
  const assignedFirmware = await db.getDeviceFirmware(deviceId);
  if (assignedFirmware && fw_version && assignedFirmware.version !== fw_version) {
    // The device's esp_https_ota client needs an ABSOLUTE URL — build it from the
    // server's public base URL (set at startup). Fall back to a relative path only
    // if the base URL is somehow unset (device won't be able to fetch it, but at
    // least the offer is well-formed for HTTP clients that can resolve it).
    const base = getBaseUrl();
    const path = `/api/device/fw-bin/${assignedFirmware.filename}`;
    const ota_url = base ? `${base}${path}` : path;
    const checksum = assignedFirmware.checksum || '';
    const size = assignedFirmware.size_bytes;

    response.ota = {
      ota_version: assignedFirmware.version,
      ota_url,
      size,
      checksum,      // sha256 hex of the .bin — device verifies the download
      sig_alg: OTA_SIG_ALG,
    };

    // Sign the offer so the device can authenticate the SERVER (not just the
    // transport). Key is derived from the device token; a MITM without the
    // token cannot forge a valid signature. Signed fields must match the
    // device's canonical reconstruction exactly (version, url, checksum, size).
    if (deviceToken) {
      response.ota.sig = signOtaOffer(deviceToken, {
        version: assignedFirmware.version,
        url: ota_url,
        checksum,
        size,
      });
    } else {
      console.warn(`[OTA] No token for device ${deviceId}; offer will be unsigned (device may reject).`);
    }

    console.log(`[OTA] Offer → device ${deviceId}: v${fw_version} → v${assignedFirmware.version} (${ota_url})`);
    notifyOTA(deviceId, 'offered', assignedFirmware.version);
  }

  // Get pending commands
  const commands = await db.getPendingCommands(deviceId);
  if (commands.length > 0) {
    response.commands = commands.map(c => ({
      id: c.id,
      command: c.command,
      payload: c.payload,
    }));

    // Mark commands as delivered
    for (const cmd of commands) {
      await db.markCommandDelivered(cmd.id);
    }
  }

  return response;
}
