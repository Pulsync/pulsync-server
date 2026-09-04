/**
 * Core device WebSocket handler
 *
 * Manages persistent WebSocket connections from ESP32 devices.
 * Handles auth, message routing, and push delivery.
 */

import { WebSocketServer } from 'ws';
import * as db from './queries.js';
import { processHeartbeat } from './heartbeat.js';
import { ingestData } from './telemetry.js';
import { notifyData, notifyHeartbeat } from './frontend-ws.js';

/** Active device connections: Map<deviceId, WebSocket> */
const connections = new Map();

/** Check if a transport is disabled (set by standalone server for testing) */
let isTransportDisabled = () => false;
export function setTransportChecker(fn) { isTransportDisabled = fn; }

/**
 * Initialize the device WebSocket server.
 * @param {import('http').Server} server - HTTP server to attach to
 * @param {function} authenticateToken - Async function(token) => device or null
 */
export function initDeviceWS(server, authenticateToken) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/api/device/ws') {
      // Reject if WSS disabled
      if (isTransportDisabled('wss')) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    }
  });

  wss.on('connection', async (ws, req) => {
    // Check if WSS transport is disabled (testing)
    if (isTransportDisabled('wss')) {
      ws.close(4010, 'WSS disabled');
      return;
    }

    // Extract token from header or query
    const token = req.headers['x-device-token'] ||
                  new URL(req.url, 'http://localhost').searchParams.get('token');

    if (!token) {
      ws.close(4001, 'Missing token');
      return;
    }

    // Authenticate
    const device = await authenticateToken(token);
    if (!device) {
      ws.close(4003, 'Invalid token');
      return;
    }

    const deviceId = device.id;
    console.log(`[WS] Device connected: ${deviceId}`);

    // Store connection
    connections.set(deviceId, ws);

    // Update last_seen
    await db.updateDeviceHeartbeat(deviceId, {
      ip: req.socket.remoteAddress,
    });

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        await handleMessage(deviceId, msg, ws);
      } catch (err) {
        console.error(`[WS] Message parse error from ${deviceId}:`, err.message);
        ws.send(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });

    ws.on('close', () => {
      console.log(`[WS] Device disconnected: ${deviceId}`);
      connections.delete(deviceId);
    });

    ws.on('error', (err) => {
      console.error(`[WS] Error from ${deviceId}:`, err.message);
      connections.delete(deviceId);
    });

    // Send ACK
    ws.send(JSON.stringify({ type: 'connected', deviceId }));
  });

  console.log('[WS] Device WebSocket server initialized on /api/device/ws');
  return wss;
}

/**
 * Handle an incoming message from a device.
 */
async function handleMessage(deviceId, msg, ws) {
  const { type, ...payload } = msg;

  switch (type) {
    case 'heartbeat': {
      const response = await processHeartbeat(deviceId, payload);
      notifyHeartbeat(deviceId, payload);
      ws.send(JSON.stringify({ type: 'heartbeat_response', ...response }));
      break;
    }

    case 'data': {
      await ingestData(deviceId, payload);
      notifyData(deviceId, payload);
      break;
    }

    case 'enroll': {
      // Enrollment via WSS — process and respond
      const { processEnrollment } = await import('./enrollment.js');
      const result = await processEnrollment(payload.pairing_code, {
        fw_version: payload.fw_version,
        mac_address: payload.mac_address,
        device_name: payload.device_name,
      });
      ws.send(JSON.stringify({ type: 'enroll_response', ...result }));
      break;
    }

    default:
      // Try to ingest as data if no type (backwards compat)
      if (Object.keys(msg).length > 0) {
        await ingestData(deviceId, msg);
      } else {
        console.warn(`[WS] Unknown message type '${type}' from ${deviceId}`);
      }
      break;
  }
}

/**
 * Push a message to a specific device (if connected via WSS).
 * @param {string} deviceId - Target device UUID
 * @param {object} message - JSON payload to send
 * @returns {boolean} true if device was connected and message sent
 */
export function pushToDevice(deviceId, message) {
  const ws = connections.get(deviceId);
  if (!ws || ws.readyState !== 1 /* OPEN */) {
    return false;
  }

  ws.send(JSON.stringify(message));
  return true;
}

/**
 * Check if a device has an active WebSocket connection.
 */
export function isDeviceConnected(deviceId) {
  const ws = connections.get(deviceId);
  return ws && ws.readyState === 1;
}

/**
 * Get count of active WebSocket connections.
 */
export function getConnectionCount() {
  return connections.size;
}

/**
 * Disconnect all device WebSocket connections (for testing transport fallback).
 */
export function disconnectAllDevices() {
  for (const [id, ws] of connections) {
    ws.close(4010, 'Transport disabled');
  }
  connections.clear();
}
