/**
 * Shared server base URL.
 *
 * The OTA offer built in heartbeat processing must hand the device an ABSOLUTE
 * firmware URL (the ESP32 esp_https_ota client cannot resolve a relative path,
 * and heartbeats can arrive over MQTT where there's no HTTP request to infer
 * host/port from). The standalone entrypoint resolves the LAN IP + actual bound
 * port at startup and calls setBaseUrl() once; heartbeat.js reads it via
 * getBaseUrl().
 */

let baseUrl = '';

/**
 * Set the public base URL (e.g. "http://192.168.0.103:3001"). No trailing slash.
 * @param {string} url
 */
export function setBaseUrl(url) {
  baseUrl = (url || '').replace(/\/+$/, '');
}

/**
 * Get the public base URL. Empty string if not yet set.
 * @returns {string}
 */
export function getBaseUrl() {
  return baseUrl;
}
