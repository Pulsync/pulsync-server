/**
 * MQTT Bridge — subscribes to device topics on the Aedes broker
 * and routes messages into the core pipeline (DB + dashboard).
 *
 * Topics:
 *   pulsync/{token}/data       → ingestData()
 *   pulsync/{token}/heartbeat  → processHeartbeat()
 */

import mqtt from 'mqtt';
import { findDeviceByToken } from './queries.js';
import { ingestData } from './telemetry.js';
import { processHeartbeat } from './heartbeat.js';
import { notifyData, notifyHeartbeat } from './frontend-ws.js';

let client = null;

/**
 * Connect to the MQTT broker and subscribe to device topics.
 * @param {string} brokerUrl - e.g., "mqtt://localhost:1883"
 */
export function initMQTTBridge(brokerUrl) {
  const serverSecret = process.env.MQTT_SERVER_SECRET || 'pulsync-server-bridge';

  client = mqtt.connect(brokerUrl, {
    clientId: 'pulsync-server-bridge',
    clean: true,
    username: 'server',
    password: serverSecret,
    connectTimeout: 10000,
    reconnectPeriod: 5000,
  });

  client.on('connect', () => {
    console.log(`[MQTT-BRIDGE] Connected to ${brokerUrl}`);
    client.subscribe('pulsync/+/upload/data', { qos: 1 });
    client.subscribe('pulsync/+/upload/heartbeat', { qos: 1 });
    console.log('[MQTT-BRIDGE] Subscribed to pulsync/+/upload/data and pulsync/+/upload/heartbeat');
  });

  client.on('message', async (topic, payload) => {
    try {
      const parts = topic.split('/');
      // pulsync/{token}/upload/{type}
      if (parts.length !== 4 || parts[0] !== 'pulsync' || parts[2] !== 'upload') return;

      const token = parts[1];
      const msgType = parts[3];

      // Look up device by token
      const device = await findDeviceByToken(token);
      if (!device) {
        console.warn(`[MQTT-BRIDGE] Unknown token: ${token.slice(0, 20)}...`);
        return;
      }

      const data = JSON.parse(payload.toString());

      switch (msgType) {
        case 'data':
          await ingestData(device.id, data);
          notifyData(device.id, data);
          break;

        case 'heartbeat':
          const response = await processHeartbeat(device.id, data);
          notifyHeartbeat(device.id, data);
          // Publish response to download/config
          if (Object.keys(response).length > 0) {
            client.publish(`pulsync/${token}/download/config`, JSON.stringify(response), { qos: 1 });
          }
          break;
      }
    } catch (err) {
      console.error('[MQTT-BRIDGE] Error processing message:', err.message);
    }
  });

  client.on('error', (err) => {
    console.error('[MQTT-BRIDGE] Connection error:', err.message);
  });

  client.on('close', () => {
    console.log('[MQTT-BRIDGE] Disconnected from broker');
  });
}

/**
 * Publish a command to a device via MQTT.
 * @param {string} token - Device token
 * @param {object} command - Command payload
 */
export function publishCommand(token, command) {
  if (!client || !client.connected) return false;
  const topic = `pulsync/${token}/download/commands`;
  client.publish(topic, JSON.stringify(command), { qos: 1 });
  return true;
}
