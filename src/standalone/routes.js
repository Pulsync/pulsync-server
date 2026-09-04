/**
 * Standalone REST routes — device-facing endpoints
 *
 * Minimal API surface for self-hosted deployments:
 *   - POST /enroll       (claim pairing code, get token)
 *   - POST /heartbeat    (periodic check-in)
 *   - POST /data         (send telemetry)
 *   - GET  /devices      (list devices — admin)
 *   - POST /devices      (create pairing code — admin)
 *   - POST /command/:id  (send command to device — admin)
 *   - PUT  /config/:id   (push config to device — admin)
 */

import { Router, raw } from 'express';
import { deviceAuthMiddleware } from './auth.js';
import { uploadFirmware, activateFirmware, listFirmware, getActive } from '../core/ota.js';
import { processEnrollment, createPairingCode, createFleetCode,
         regenerateDeviceConfigPassword } from '../core/enrollment.js';
import { processHeartbeat } from '../core/heartbeat.js';
import { ingestData, queryData } from '../core/telemetry.js';
import { sendCommand } from '../core/commands.js';
import { setConfig, setConfigs, getConfigs } from '../core/config-push.js';
import { listDevices, findDeviceById, listFleetCodes,
         assignFirmwareToDevice, detachDeviceFirmware, getDeviceFirmware,
         findFirmwareById, getDeviceConfigPassword } from '../core/queries.js';
import { isDeviceConnected, getConnectionCount } from '../core/device-ws.js';
import { publishCommand as mqttPublishCommand } from '../core/mqtt-embedded.js';
import { notifyData, notifyHeartbeat, notifyEnrolled, notifyCommand } from '../core/frontend-ws.js';
import { adminAuthMiddleware, isAdminEnabled, isAuthed, checkPassword,
         setSessionCookie, clearSessionCookie } from './admin-auth.js';

const router = Router();

/* ---------- Admin session (optional single-password gate) ---------- */

/**
 * GET /admin/status — is the gate enabled, and is this request authed?
 * Used by the dashboard to decide whether to show a login prompt.
 */
router.get('/admin/status', (req, res) => {
  res.json({ enabled: isAdminEnabled(), authed: isAdminEnabled() ? isAuthed(req) : true });
});

/**
 * POST /admin/login — { password }. On success sets the session cookie.
 */
router.post('/admin/login', (req, res) => {
  if (!isAdminEnabled()) {
    return res.json({ success: true }); // gate disabled — nothing to log into
  }
  const { password } = req.body || {};
  if (!checkPassword(password)) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  setSessionCookie(res);
  res.json({ success: true });
});

/**
 * POST /admin/logout — clears the session cookie.
 */
router.post('/admin/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ success: true });
});

/* ---------- Device-facing (used by ESP32 library) ---------- */

/**
 * POST /enroll — Device enrollment
 * Body: { pairing_code, fw_version }
 * No auth required (pairing code IS the auth)
 */
router.post('/enroll', async (req, res) => {
  try {
    const { pairing_code, fw_version, mac_address, device_name } = req.body;
    const result = await processEnrollment(pairing_code, { fw_version, mac_address, device_name });

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    const resp = { token: result.token };
    if (result.mqtt_url) resp.mqtt_url = result.mqtt_url;
    if (result.config_pw_hash) resp.config_pw_hash = result.config_pw_hash;
    res.json(resp);
    notifyEnrolled(result.token, pairing_code);
  } catch (err) {
    console.error('[ROUTE] Enroll error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * POST /heartbeat — Device heartbeat
 * Body: { uptime, free_heap, fw_version, rssi }
 * Auth: X-Device-Token
 */
router.post('/heartbeat', deviceAuthMiddleware, async (req, res) => {
  try {
    const deviceId = getDeviceId(req);
    if (!deviceId) {
      return res.status(400).json({ error: 'Cannot determine device ID' });
    }

    const response = await processHeartbeat(deviceId, req.body, {
      ip: req.ip || req.socket.remoteAddress,
    });

    notifyHeartbeat(deviceId, req.body);
    res.json(response);
  } catch (err) {
    console.error('[ROUTE] Heartbeat error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * POST /data — Send telemetry data
 * Body: { key: value, ... }
 * Auth: X-Device-Token
 */
router.post('/data', deviceAuthMiddleware, async (req, res) => {
  try {
    const deviceId = getDeviceId(req);
    if (!deviceId) {
      return res.status(400).json({ error: 'Cannot determine device ID' });
    }

    const result = await ingestData(deviceId, req.body);
    notifyData(deviceId, req.body);
    res.json(result);
  } catch (err) {
    console.error('[ROUTE] Data error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

/* ---------- Admin/management (no OAuth, open in standalone) ---------- */

/**
 * GET /devices — List all devices
 */
router.get('/devices', adminAuthMiddleware, async (req, res) => {
  try {
    const devices = await listDevices();
    res.json({ devices, ws_connections: getConnectionCount() });
  } catch (err) {
    console.error('[ROUTE] List devices error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * POST /devices — Create a new pairing code
 * Body: { name? }
 */
router.post('/devices', adminAuthMiddleware, async (req, res) => {
  try {
    const { name } = req.body || {};
    const result = await createPairingCode(name);
    res.json(result);
  } catch (err) {
    console.error('[ROUTE] Create device error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * DELETE /devices/:id — Delete a device and its data
 */
router.delete('/devices/:id', adminAuthMiddleware, async (req, res) => {
  try {
    const { query: dbQuery } = await import('../db/connection.js');
    await dbQuery('DELETE FROM devices WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('[ROUTE] Delete device error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * GET /devices/:id — Device details
 */
router.get('/devices/:id', adminAuthMiddleware, async (req, res) => {
  try {
    const device = await findDeviceById(req.params.id);
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }
    const assignedFirmware = await getDeviceFirmware(device.id);
    // Never leak the config-portal credential in the general device payload.
    // The plaintext is only handed out through the explicit, admin-gated
    // reveal route (GET .../config-password); include just a boolean here.
    const { config_password, config_password_hash, ...safe } = device;
    res.json({
      ...safe,
      has_config_password: !!config_password_hash,
      online: isDeviceConnected(device.id),
      assigned_firmware: assignedFirmware,  // { id, version, filename, size_bytes } or null
    });
  } catch (err) {
    console.error('[ROUTE] Get device error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * GET /devices/:id/config-password — Reveal the device's config-portal password.
 * Behind admin login. Returns plaintext (for the dashboard reveal) + whether a
 * hash exists (i.e. the device has been given a password).
 */
router.get('/devices/:id/config-password', adminAuthMiddleware, async (req, res) => {
  try {
    const device = await findDeviceById(req.params.id);
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }
    const pw = await getDeviceConfigPassword(device.id);
    res.json({
      password: pw ? (pw.config_password || null) : null,
      has_hash: !!(pw && pw.config_password_hash),
    });
  } catch (err) {
    console.error('[ROUTE] Reveal config password error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * POST /devices/:id/config-password/regenerate — Rotate the config-portal
 * password. Behind admin login. The new hash reaches the device on its next
 * heartbeat; the old password stops working once the device stores it.
 */
router.post('/devices/:id/config-password/regenerate', adminAuthMiddleware, async (req, res) => {
  try {
    const device = await findDeviceById(req.params.id);
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }
    const { password } = await regenerateDeviceConfigPassword(device.id);
    res.json({ success: true, password });
  } catch (err) {
    console.error('[ROUTE] Regenerate config password error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * PUT /devices/:id/firmware — Attach or detach a firmware build for this device.
 * Body: { firmware_id }  -> attach that build (offered on next heartbeat)
 *       { firmware_id: null } or empty -> detach (device stays on current fw)
 * Attach is deliberate: the assigned build is offered whenever it differs from
 * what the device reports, so downgrades / rollback are supported on purpose.
 */
router.put('/devices/:id/firmware', adminAuthMiddleware, async (req, res) => {
  try {
    const device = await findDeviceById(req.params.id);
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    const firmwareId = (req.body && req.body.firmware_id != null) ? req.body.firmware_id : null;

    if (firmwareId == null) {
      await detachDeviceFirmware(device.id);
      console.log(`[OTA] Detached firmware from device ${device.id}`);
      return res.json({ success: true, assigned_firmware: null });
    }

    const firmware = await findFirmwareById(firmwareId);
    if (!firmware) {
      return res.status(400).json({ error: 'Firmware not found' });
    }

    await assignFirmwareToDevice(device.id, firmware.id);
    console.log(`[OTA] Attached v${firmware.version} to device ${device.id}`);
    const assigned = await getDeviceFirmware(device.id);
    res.json({ success: true, assigned_firmware: assigned });
  } catch (err) {
    console.error('[ROUTE] Attach firmware error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * GET /devices/:id/data/count — Get data point count
 */
router.get('/devices/:id/data/count', adminAuthMiddleware, async (req, res) => {
  try {
    const { rows } = await (await import('../db/connection.js')).query(
      'SELECT COUNT(*) as count FROM data_points WHERE device_id = $1', [req.params.id]
    );
    res.json({ count: rows[0]?.count || 0 });
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * GET /devices/:id/data — Query device telemetry
 * Query params: limit, since
 */
router.get('/devices/:id/data', adminAuthMiddleware, async (req, res) => {
  try {
    const { limit, since } = req.query;
    const data = await queryData(req.params.id, {
      limit: limit ? parseInt(limit, 10) : 100,
      since: since || null,
    });
    res.json({ data });
  } catch (err) {
    console.error('[ROUTE] Query data error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * POST /devices/:id/command — Send a command to a device
 * Body: { command, payload? }
 */
router.post('/devices/:id/command', adminAuthMiddleware, async (req, res) => {
  try {
    const { command, payload } = req.body;
    const result = await sendCommand(req.params.id, command, payload);

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    // Push command immediately via MQTT
    const device = await findDeviceById(req.params.id);
    const pushed = device && device.token ? mqttPublishCommand(device.token, { command, payload: payload || {} }) : false;

    notifyCommand(req.params.id, command, payload);
    res.json({ ...result, pushed });
  } catch (err) {
    console.error('[ROUTE] Command error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * PUT /devices/:id/config — Push config to a device
 * Body: { key: value, ... }
 */
router.put('/devices/:id/config', adminAuthMiddleware, async (req, res) => {
  try {
    const result = await setConfigs(req.params.id, req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    // Push config immediately via MQTT
    const device = await findDeviceById(req.params.id);
    if (device && device.token) {
      const { publishConfig } = await import('../core/mqtt-embedded.js');
      publishConfig(device.token, req.body);
    }

    res.json(result);
  } catch (err) {
    console.error('[ROUTE] Config error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * GET /devices/:id/config — Get device config
 */
router.get('/devices/:id/config', adminAuthMiddleware, async (req, res) => {
  try {
    const config = await getConfigs(req.params.id);
    res.json({ config });
  } catch (err) {
    console.error('[ROUTE] Get config error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * POST /fleet — Create a new fleet code
 * Body: { name?, max_devices? }
 */
router.post('/fleet', adminAuthMiddleware, async (req, res) => {
  try {
    const { name, max_devices } = req.body || {};
    const result = await createFleetCode(name, max_devices || 0);
    res.json(result);
  } catch (err) {
    console.error('[ROUTE] Create fleet error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * GET /fleet — List all fleet codes
 */
router.get('/fleet', adminAuthMiddleware, async (req, res) => {
  try {
    const codes = await listFleetCodes();
    res.json({ fleets: codes });
  } catch (err) {
    console.error('[ROUTE] List fleet error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

/* ---------- Firmware / OTA (admin) ---------- */

/**
 * GET /firmware — List all uploaded firmware versions.
 * Also returns the currently active (deployed) version.
 */
router.get('/firmware', adminAuthMiddleware, async (req, res) => {
  try {
    const [firmware, active] = await Promise.all([listFirmware(), getActive()]);
    res.json({ firmware, active });
  } catch (err) {
    console.error('[ROUTE] List firmware error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * POST /firmware?version=x.y.z — Upload a firmware .bin
 * Body: raw binary (Content-Type: application/octet-stream)
 * Version passed as query param (raw body carries the binary).
 */
router.post(
  '/firmware',
  adminAuthMiddleware,
  raw({ type: '*/*', limit: '16mb' }),
  async (req, res) => {
    try {
      const version = (req.query.version || '').toString().trim();
      if (!version) {
        return res.status(400).json({ error: 'Missing version query param' });
      }
      if (!req.body || !req.body.length) {
        return res.status(400).json({ error: 'Empty firmware body' });
      }

      const result = await uploadFirmware(version, req.body, `pulsync_${version}.bin`);
      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }
      res.json({ success: true, firmware: result.firmware });
    } catch (err) {
      console.error('[ROUTE] Upload firmware error:', err.message);
      res.status(500).json({ error: 'Internal error' });
    }
  }
);

/**
 * POST /firmware/:id/activate — Deploy (activate) a firmware version.
 * Devices running an older version will be offered this on their next heartbeat.
 */
router.post('/firmware/:id/activate', adminAuthMiddleware, async (req, res) => {
  try {
    await activateFirmware(req.params.id);
    const active = await getActive();
    res.json({ success: true, active });
  } catch (err) {
    console.error('[ROUTE] Activate firmware error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

/* ---------- Helpers ---------- */

/**
 * Get device ID from request.
 * For enrolled devices: from the token lookup.
 * For shared-secret mode: from request body (deviceId field).
 */
function getDeviceId(req) {
  if (req.device.mode === 'shared') {
    // In shared-secret mode, device must send its ID in body
    return req.body.deviceId || req.body.device_id || null;
  }
  return req.device.id;
}

export default router;
