/**
 * Core telemetry — ingest device data
 *
 * Receives data points from devices, stores in DB.
 * Auth-agnostic: receives already-validated deviceId.
 */

import * as db from './queries.js';

/**
 * Ingest telemetry data from a device.
 * @param {string} deviceId - UUID of the device
 * @param {object} payload - Key-value telemetry data (e.g., { temperature: 25.3, humidity: 60 })
 * @returns {{ success: boolean }}
 */
export async function ingestData(deviceId, payload) {
  if (!payload || typeof payload !== 'object') {
    return { success: false, error: 'Invalid payload' };
  }

  await db.insertDataPoint(deviceId, payload);
  return { success: true };
}

/**
 * Query telemetry data for a device.
 * @param {string} deviceId - UUID of the device
 * @param {object} options - { limit, since }
 * @returns {Array} Data points
 */
export async function queryData(deviceId, options = {}) {
  const rows = await db.getDataPoints(deviceId, options);
  return rows.map(r => ({
    data: r.payload,
    timestamp: r.received_at,
  }));
}
