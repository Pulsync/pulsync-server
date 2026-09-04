/**
 * Standalone auth — simple token verification
 *
 * Two modes:
 *   1. DEVICE_SECRET env var set → all devices use this shared secret
 *   2. No DEVICE_SECRET → per-device tokens via enrollment (pairing codes)
 *
 * Middleware extracts X-Device-Token header and validates.
 */

import { findDeviceByToken } from '../core/queries.js';

const DEVICE_SECRET = process.env.DEVICE_SECRET || '';

/**
 * Authenticate a device token.
 * @param {string} token - The token from X-Device-Token header
 * @returns {object|null} Device object or null if invalid
 */
export async function authenticateDevice(token) {
  if (!token) return null;

  // Mode 1: Shared secret (all devices use same token)
  if (DEVICE_SECRET && token === DEVICE_SECRET) {
    // For shared-secret mode, we need a device ID from the request body
    // Return a sentinel object — the route handler will extract deviceId from payload
    return { id: '__shared_secret__', mode: 'shared' };
  }

  // Mode 2: Per-device token (from enrollment)
  const device = await findDeviceByToken(token);
  if (device) {
    return { id: device.id, mode: 'enrolled', ...device };
  }

  return null;
}

/**
 * Express middleware for device auth.
 * Sets req.device if authenticated, returns 401 otherwise.
 */
export function deviceAuthMiddleware(req, res, next) {
  const token = req.headers['x-device-token'];

  if (!token) {
    console.log('[AUTH] Missing X-Device-Token header');
    return res.status(401).json({ error: 'Missing X-Device-Token header' });
  }

  authenticateDevice(token).then(device => {
    if (!device) {
      console.log('[AUTH] Invalid device token (rejected)');
      return res.status(401).json({ error: 'Invalid token' });
    }
    req.device = device;
    next();
  }).catch(err => {
    console.error('[AUTH] Error:', err.message);
    res.status(500).json({ error: 'Auth error' });
  });
}
