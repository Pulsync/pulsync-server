/**
 * Embedded MQTT Broker — runs inside the standalone server process.
 *
 * No separate broker needed. Devices connect to port 1883 on the same machine.
 * Auth: device token validation against DB.
 * ACL: each device only accesses its own topics.
 * Data flows directly to ingestData()/processHeartbeat() — no bridge, no network hop.
 */

import { createServer } from 'node:net';
import { Aedes } from 'aedes';
import { findDeviceByToken, updateDeviceHeartbeat } from './queries.js';
import { ingestData } from './telemetry.js';
import { processHeartbeat } from './heartbeat.js';
import { notifyData, notifyHeartbeat } from './frontend-ws.js';

let aedes = null;
let mqttServer = null;
let boundPort = null;  // the port the broker actually bound to (may differ from requested on fallback)

/**
 * The port the embedded broker actually bound to, or null if not started.
 * May differ from the requested port when the preferred port was in use.
 */
export function getMqttPort() {
  return boundPort;
}

/**
 * Start the embedded MQTT broker.
 * @param {number} port - MQTT port (default 1883)
 */
export async function initEmbeddedMQTT(port = 1883) {
  aedes = await Aedes.createBroker();

  // --- Authentication ---
  aedes.authenticate = (client, username, password, callback) => {
    const user = username ? username.toString() : '';
    const pass = password ? password.toString() : '';

    if (!pass) {
      callback(new Error('No credentials'), false);
      return;
    }

    // Validate device token against DB
    findDeviceByToken(pass).then(device => {
      if (device) {
        client._role = 'device';
        client._token = pass;
        client._deviceId = device.id;
        callback(null, true);
      } else {
        console.warn(`[MQTT] Auth rejected: ${client.id}`);
        callback(new Error('Invalid token'), false);
      }
    }).catch(err => {
      callback(err, false);
    });
  };

  // --- Publish ACL ---
  aedes.authorizePublish = (client, packet, callback) => {
    const allowedPrefix = `pulsync/${client._token}/upload/`;
    if (packet.topic.startsWith(allowedPrefix)) {
      callback(null);
    } else {
      callback(new Error('Unauthorized topic'));
    }
  };

  // --- Subscribe ACL ---
  aedes.authorizeSubscribe = (client, subscription, callback) => {
    const allowedPrefix = `pulsync/${client._token}/download/`;
    if (subscription.topic.startsWith(allowedPrefix)) {
      callback(null, subscription);
    } else {
      callback(null, null);
    }
  };

  // --- Direct data routing (no bridge needed) ---
  aedes.on('publish', async (packet, client) => {
    if (!client || !client._deviceId) return;
    if (packet.topic.startsWith('$')) return; // skip system topics

    const parts = packet.topic.split('/');
    // pulsync/{token}/upload/{type}
    if (parts.length !== 4 || parts[2] !== 'upload') return;

    const msgType = parts[3];
    try {
      const data = JSON.parse(packet.payload.toString());

      switch (msgType) {
        case 'data':
          await ingestData(client._deviceId, data);
          await updateDeviceHeartbeat(client._deviceId, {});
          notifyData(client._deviceId, data);
          break;

        case 'heartbeat':
          const response = await processHeartbeat(client._deviceId, data);
          notifyHeartbeat(client._deviceId, data);
          // Push config/commands back to device
          if (Object.keys(response).length > 0) {
            const respTopic = `pulsync/${client._token}/download/config`;
            aedes.publish({ topic: respTopic, payload: JSON.stringify(response), qos: 1 });
          }
          break;
      }
    } catch (err) {
      // ignore parse errors
    }
  });

  // --- Logging ---
  aedes.on('client', (client) => {
    console.log(`[MQTT] Device connected: ${client.id}`);
  });

  aedes.on('clientDisconnect', (client) => {
    console.log(`[MQTT] Device disconnected: ${client.id}`);
  });

  // --- Start TCP server ---
  mqttServer = createServer(aedes.handle);
  mqttServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      const altPort = port + 1;
      console.warn(`[MQTT] Port ${port} in use, trying ${altPort}...`);
      const altServer = createServer(aedes.handle);
      altServer.listen({ port: altPort, host: '0.0.0.0', exclusive: false }, () => {
        boundPort = altPort;
        console.log(`[MQTT] Embedded broker on 0.0.0.0:${altPort} (auth + ACL enabled)`);
      });
      mqttServer = altServer;
    } else {
      console.error(`[MQTT] Server error:`, err.message);
    }
  });
  // Bind to 0.0.0.0 (IPv4 all interfaces) so ESP32 devices can connect over IPv4.
  mqttServer.listen({ port, host: '0.0.0.0', exclusive: false }, () => {
    boundPort = port;
    console.log(`[MQTT] Embedded broker on 0.0.0.0:${port} (auth + ACL enabled)`);
  });
}

/**
 * Publish a command to a device via embedded broker.
 */
export function publishCommand(token, command) {
  if (!aedes) return false;
  const topic = `pulsync/${token}/download/commands`;
  aedes.publish({ topic, payload: JSON.stringify(command), qos: 1 });
  return true;
}

/**
 * Publish config to a device via embedded broker.
 */
export function publishConfig(token, config) {
  if (!aedes) return false;
  const topic = `pulsync/${token}/download/config`;
  aedes.publish({ topic, payload: JSON.stringify(config), qos: 1 });
  return true;
}

/**
 * Stop the embedded broker.
 */
export function stopEmbeddedMQTT() {
  if (aedes) aedes.close();
  if (mqttServer) mqttServer.close();
}
