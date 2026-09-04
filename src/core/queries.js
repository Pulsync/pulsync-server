/**
 * Core database queries — device protocol layer
 *
 * Auth-agnostic: receives already-validated device IDs.
 * No tenant logic here — that's in hosted/.
 */

import { query } from '../db/connection.js';

/* ---------- Devices ---------- */

export async function findDeviceByToken(token) {
  const { rows } = await query(
    'SELECT id, pairing_code, token, name, tags, fw_version, last_seen, metadata FROM devices WHERE token = $1',
    [token]
  );
  return rows[0] || null;
}

export async function findDeviceByPairingCode(code) {
  const { rows } = await query(
    'SELECT id, pairing_code, token, enrolled_at FROM devices WHERE pairing_code = $1',
    [code]
  );
  return rows[0] || null;
}

export async function findDeviceById(id) {
  const { rows } = await query(
    'SELECT * FROM devices WHERE id = $1',
    [id]
  );
  return rows[0] || null;
}

export async function enrollDevice(deviceId, token) {
  const { rows } = await query(
    `UPDATE devices SET token = $2, enrolled_at = NOW() WHERE id = $1 RETURNING id, token`,
    [deviceId, token]
  );
  return rows[0] || null;
}

export async function updateDeviceMac(deviceId, macAddress) {
  await query(
    `UPDATE devices SET mac_address = $2 WHERE id = $1`,
    [deviceId, macAddress]
  );
}

export async function updateDeviceName(deviceId, name) {
  await query(
    `UPDATE devices SET name = $2 WHERE id = $1`,
    [deviceId, name]
  );
}

export async function findDeviceByMac(macAddress) {
  const { rows } = await query(
    'SELECT id, pairing_code, token, mac_address FROM devices WHERE mac_address = $1',
    [macAddress]
  );
  return rows[0] || null;
}

export async function updateDeviceHeartbeat(deviceId, { fwVersion, ip }) {
  await query(
    `UPDATE devices SET last_seen = NOW(), fw_version = COALESCE($2, fw_version), last_ip = $3 WHERE id = $1`,
    [deviceId, fwVersion || null, ip || null]
  );
}

export async function createDevice(pairingCode, name) {
  const { rows } = await query(
    `INSERT INTO devices (pairing_code, name) VALUES ($1, $2) RETURNING id, pairing_code`,
    [pairingCode, name || null]
  );
  return rows[0];
}

export async function listDevices() {
  const { rows } = await query(
    'SELECT id, name, pairing_code, token IS NOT NULL as enrolled, fw_version, last_seen, tags FROM devices ORDER BY created_at DESC'
  );
  return rows;
}

/* ---------- Config-portal password (device gate) ---------- */

/**
 * Persist the config-portal password + its hash for a device.
 * Plaintext is kept for dashboard reveal; the hash is what's sent to the device.
 */
export async function setDeviceConfigPassword(deviceId, password, hash) {
  await query(
    'UPDATE devices SET config_password = $2, config_password_hash = $3 WHERE id = $1',
    [deviceId, password, hash]
  );
}

/**
 * Read a device's config-portal password (plaintext) + hash.
 * @returns {{ config_password: string|null, config_password_hash: string|null } | null}
 */
export async function getDeviceConfigPassword(deviceId) {
  const { rows } = await query(
    'SELECT config_password, config_password_hash FROM devices WHERE id = $1',
    [deviceId]
  );
  return rows[0] || null;
}

/* ---------- Telemetry ---------- */

export async function insertDataPoint(deviceId, payload) {
  await query(
    'INSERT INTO data_points (device_id, payload) VALUES ($1, $2)',
    [deviceId, JSON.stringify(payload)]
  );
}

export async function getDataPoints(deviceId, { limit = 100, since = null } = {}) {
  let sql = 'SELECT payload, received_at FROM data_points WHERE device_id = $1';
  const params = [deviceId];

  if (since) {
    sql += ' AND received_at >= $2';
    params.push(since);
  }

  sql += ' ORDER BY received_at DESC LIMIT $' + (params.length + 1);
  params.push(limit);

  const { rows } = await query(sql, params);
  return rows;
}

/* ---------- Config ---------- */

export async function getDeviceConfigs(deviceId) {
  const { rows } = await query(
    'SELECT key, value FROM device_configs WHERE device_id = $1',
    [deviceId]
  );
  // Return as object { key: value, ... }
  const config = {};
  for (const row of rows) {
    config[row.key] = row.value;
  }
  return config;
}

export async function setDeviceConfig(deviceId, key, value) {
  await query(
    `INSERT INTO device_configs (device_id, key, value, updated_at) 
     VALUES ($1, $2, $3, NOW()) 
     ON CONFLICT (device_id, key) DO UPDATE SET value = $3, updated_at = NOW()`,
    [deviceId, key, String(value)]
  );
}

/* ---------- Commands ---------- */

export async function getPendingCommands(deviceId) {
  const { rows } = await query(
    `SELECT id, command, payload FROM commands 
     WHERE device_id = $1 AND delivered_at IS NULL 
     ORDER BY created_at ASC LIMIT 10`,
    [deviceId]
  );
  return rows;
}

export async function markCommandDelivered(commandId) {
  await query(
    'UPDATE commands SET delivered_at = NOW() WHERE id = $1',
    [commandId]
  );
}

export async function createCommand(deviceId, command, payload) {
  const { rows } = await query(
    `INSERT INTO commands (device_id, command, payload) VALUES ($1, $2, $3) RETURNING id`,
    [deviceId, command, JSON.stringify(payload || {})]
  );
  return rows[0];
}

/* ---------- Firmware / OTA ---------- */

export async function getActiveFirmware() {
  const { rows } = await query(
    'SELECT id, version, filename, size_bytes FROM firmware WHERE is_active = true ORDER BY uploaded_at DESC LIMIT 1'
  );
  return rows[0] || null;
}

export async function insertFirmware(version, filename, sizeBytes, checksum) {
  const { rows } = await query(
    `INSERT INTO firmware (version, filename, size_bytes, checksum) VALUES ($1, $2, $3, $4) RETURNING id, version`,
    [version, filename, sizeBytes, checksum]
  );
  return rows[0];
}

export async function activateFirmware(firmwareId) {
  // Deactivate all, then activate the target
  await query('UPDATE firmware SET is_active = false WHERE is_active = true');
  await query('UPDATE firmware SET is_active = true WHERE id = $1', [firmwareId]);
}

export async function listFirmware() {
  const { rows } = await query(
    'SELECT id, version, filename, size_bytes, is_active, uploaded_at FROM firmware ORDER BY uploaded_at DESC'
  );
  return rows;
}

export async function findFirmwareById(firmwareId) {
  const { rows } = await query(
    'SELECT id, version, filename, size_bytes FROM firmware WHERE id = $1',
    [firmwareId]
  );
  return rows[0] || null;
}


/* ---------- Per-device firmware assignments (free-tier OTA targeting) ---------- */

/**
 * Attach a firmware build to a specific device. One assignment per device —
 * re-attaching replaces the previous assignment.
 */
export async function assignFirmwareToDevice(deviceId, firmwareId) {
  // Note: assigned_at intentionally left unchanged on re-attach to stay
  // portable across PG (NOW()) and SQLite (datetime('now')).
  await query(
    `INSERT INTO firmware_assignments (device_id, firmware_id)
     VALUES ($1, $2)
     ON CONFLICT (device_id) DO UPDATE SET firmware_id = $2`,
    [deviceId, firmwareId]
  );
}

/**
 * Remove a device's firmware assignment (device stays on its current firmware).
 */
export async function detachDeviceFirmware(deviceId) {
  await query('DELETE FROM firmware_assignments WHERE device_id = $1', [deviceId]);
}

/**
 * Get the firmware currently assigned to a device (or null).
 * Returns the joined firmware fields needed to build an OTA offer.
 */
export async function getDeviceFirmware(deviceId) {
  const { rows } = await query(
    `SELECT f.id, f.version, f.filename, f.size_bytes, f.checksum
     FROM firmware_assignments fa
     JOIN firmware f ON f.id = fa.firmware_id
     WHERE fa.device_id = $1`,
    [deviceId]
  );
  return rows[0] || null;
}


/* ---------- Fleet Codes ---------- */

export async function findFleetCode(code) {
  const { rows } = await query(
    'SELECT id, code, name, max_devices, enrolled_count, mac_allowlist, is_active FROM fleet_codes WHERE code = $1',
    [code]
  );
  return rows[0] || null;
}

export async function createFleetCode(code, name, maxDevices) {
  const { rows } = await query(
    `INSERT INTO fleet_codes (code, name, max_devices) VALUES ($1, $2, $3) RETURNING id, code`,
    [code, name || null, maxDevices || 0]
  );
  return rows[0];
}

export async function incrementFleetCount(fleetId) {
  await query(
    'UPDATE fleet_codes SET enrolled_count = enrolled_count + 1 WHERE id = $1',
    [fleetId]
  );
}

export async function createDeviceFromFleet(fleetId, macAddress, name) {
  const pairingCode = null; // fleet devices don't have individual pairing codes
  const { rows } = await query(
    `INSERT INTO devices (name, mac_address, fleet_code_id) VALUES ($1, $2, $3) RETURNING id`,
    [name || null, macAddress, fleetId]
  );
  return rows[0];
}

export async function listFleetCodes() {
  const { rows } = await query(
    'SELECT id, code, name, max_devices, enrolled_count, is_active, created_at FROM fleet_codes ORDER BY created_at DESC'
  );
  return rows;
}
