/**
 * Shared MQTT endpoint the server advertises to devices.
 *
 * The device knows the HTTP host a priori (it enrolls over HTTP), but the MQTT
 * broker may live somewhere else (different host/port, or a separate service in
 * hosted mode). Rather than have the device guess, the server hands back a full
 * MQTT URL in the enroll response — and again in heartbeats if it changes.
 *
 * Format: a single URL string, e.g.
 *   "mqtt://192.168.0.103:1883"     (local, plaintext)
 *   "mqtts://mqtt.pulsync.in:8883"  (hosted, TLS)
 *
 * The standalone entrypoint resolves the LAN IP + actual bound broker port at
 * startup and calls setMqttUrl() once. Hosted sets it from its own config.
 */

let mqttUrl = '';

/**
 * Set the MQTT URL devices should connect to. No trailing slash.
 * @param {string} url  e.g. "mqtt://192.168.0.103:1883"
 */
export function setMqttUrl(url) {
  mqttUrl = (url || '').replace(/\/+$/, '');
}

/**
 * Build and set the MQTT URL from parts.
 * @param {string} host
 * @param {number} port
 * @param {boolean} tls
 */
export function setMqttEndpoint(host, port, tls = false) {
  if (!host || !port) { mqttUrl = ''; return; }
  mqttUrl = `${tls ? 'mqtts' : 'mqtt'}://${host}:${port}`;
}

/**
 * Get the advertised MQTT URL. Empty string if not set.
 * @returns {string}
 */
export function getMqttUrl() {
  return mqttUrl;
}
