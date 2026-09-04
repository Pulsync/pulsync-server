/**
 * Frontend WebSocket — real-time updates to dashboard clients
 *
 * Browsers connect to /api/live and receive events:
 *   { type: "device_data", deviceId, data, timestamp }
 *   { type: "heartbeat", deviceId, status }
 *   { type: "device_online", deviceId }
 *   { type: "device_offline", deviceId }
 *   { type: "enrolled", deviceId, pairingCode }
 *   { type: "command_sent", deviceId, command }
 */

import { WebSocketServer } from 'ws';

/** Connected dashboard clients */
const clients = new Set();

/**
 * Initialize the frontend WebSocket server.
 * @param {import('http').Server} server - HTTP server to attach to
 */
export function initFrontendWS(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/api/live') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    }
  });

  wss.on('connection', (ws, req) => {
    clients.add(ws);
    console.log(`[LIVE] Dashboard connected (${clients.size} total)`);

    // Send welcome message
    ws.send(JSON.stringify({ type: 'connected', clients: clients.size }));

    ws.on('close', () => {
      clients.delete(ws);
      console.log(`[LIVE] Dashboard disconnected (${clients.size} total)`);
    });

    ws.on('error', () => {
      clients.delete(ws);
    });
  });

  console.log('[LIVE] Frontend WebSocket initialized on /api/live');
}

/**
 * Broadcast an event to all connected dashboard clients.
 * @param {object} event - Event object to send
 */
export function broadcast(event) {
  if (clients.size === 0) return;
  const msg = JSON.stringify(event);
  for (const ws of clients) {
    if (ws.readyState === 1) { // OPEN
      ws.send(msg);
    }
  }
}

/**
 * Notify dashboards of new telemetry data.
 */
export function notifyData(deviceId, data) {
  broadcast({
    type: 'device_data',
    deviceId,
    data,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Notify dashboards of a heartbeat.
 */
export function notifyHeartbeat(deviceId, status) {
  broadcast({
    type: 'heartbeat',
    deviceId,
    status,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Notify dashboards of device enrollment.
 */
export function notifyEnrolled(deviceId, pairingCode) {
  broadcast({
    type: 'enrolled',
    deviceId,
    pairingCode,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Notify dashboards of an OTA status change for a device.
 * status: 'offered' (update offered on heartbeat) | 'updated' (device booted new fw)
 */
export function notifyOTA(deviceId, status, version) {
  broadcast({
    type: 'ota_status',
    deviceId,
    status,
    version,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Notify dashboards of a command being sent.
 */
export function notifyCommand(deviceId, command, payload) {
  broadcast({
    type: 'command_sent',
    deviceId,
    command,
    payload,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Get number of connected dashboard clients.
 */
export function getDashboardCount() {
  return clients.size;
}
