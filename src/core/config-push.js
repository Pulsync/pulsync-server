/**
 * Core config-push — remote configuration management
 *
 * Push key-value config to devices.
 * Config is delivered via heartbeat response or WSS push.
 */

import * as db from './queries.js';

/**
 * Set a config value for a device.
 * @param {string} deviceId - Target device UUID
 * @param {string} key - Config key
 * @param {string} value - Config value (string representation)
 */
export async function setConfig(deviceId, key, value) {
  if (!key || typeof key !== 'string') {
    return { success: false, error: 'Missing config key' };
  }

  await db.setDeviceConfig(deviceId, key, String(value));
  console.log(`[CONFIG] ${deviceId}: ${key} = ${value}`);
  return { success: true };
}

/**
 * Set multiple config values at once.
 * @param {string} deviceId - Target device UUID
 * @param {object} configs - { key: value, ... }
 */
export async function setConfigs(deviceId, configs) {
  if (!configs || typeof configs !== 'object') {
    return { success: false, error: 'Invalid config object' };
  }

  for (const [key, value] of Object.entries(configs)) {
    await db.setDeviceConfig(deviceId, key, String(value));
  }

  return { success: true, count: Object.keys(configs).length };
}

/**
 * Get all config values for a device.
 * @param {string} deviceId - Device UUID
 * @returns {object} Key-value config object
 */
export async function getConfigs(deviceId) {
  return await db.getDeviceConfigs(deviceId);
}
