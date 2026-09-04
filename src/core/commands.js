/**
 * Core commands — send commands to devices
 *
 * Commands are queued and delivered via heartbeat or WSS push.
 * Auth-agnostic: receives already-validated deviceId.
 */

import * as db from './queries.js';

/**
 * Queue a command for a device.
 * @param {string} deviceId - Target device UUID
 * @param {string} command - Command name (e.g., "set_brightness")
 * @param {object} payload - Command parameters
 * @returns {{ success: boolean, commandId?: number }}
 */
export async function sendCommand(deviceId, command, payload = {}) {
  if (!command || typeof command !== 'string') {
    return { success: false, error: 'Missing command name' };
  }

  const result = await db.createCommand(deviceId, command, payload);
  return { success: true, commandId: result.id };
}

/**
 * Get pending commands for a device (without marking delivered).
 * Used for status display in portal.
 */
export async function getPending(deviceId) {
  return await db.getPendingCommands(deviceId);
}
