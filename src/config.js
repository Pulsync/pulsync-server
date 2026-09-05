/**
 * Server configuration — loads from environment variables
 */

const config = {
  port: parseInt(process.env.PORT || '3456', 10),
  mode: process.env.PULSYNC_MODE || 'self-hosted',

  db: {
    url: process.env.DATABASE_URL || '',
    sqlitePath: process.env.SQLITE_PATH || './pulsync.db',
  },

  admin: {
    // Optional single-password gate for the standalone dashboard + management
    // routes. Empty = gate disabled (open), which is the default for local dev.
    // When set, admin session cookies are HMAC-signed; set JWT_SECRET (env) to
    // keep sessions stable across restarts, otherwise an ephemeral key is used.
    password: process.env.ADMIN_PASSWORD || '',
  },

  ota: {
    storagePath: process.env.OTA_STORAGE_PATH || './storage/firmware',
  },

  mdns: {
    // Advertise the server on the LAN as "<hostname>.local" via mDNS/Bonjour so
    // devices can find it by name instead of a churn-prone DHCP IP.
    // Default ON for self-hosted (LAN); meaningless for hosted (public DNS).
    // Set MDNS_ENABLE=false to turn it off. MDNS_HOSTNAME overrides the name
    // (without the ".local" suffix); defaults to "pulsync".
    enable: (process.env.MDNS_ENABLE ?? 'true').toLowerCase() !== 'false',
    hostname: (process.env.MDNS_HOSTNAME || 'pulsync').replace(/\.local$/i, ''),
  },

  mqtt: {
    internalUrl: process.env.MQTT_INTERNAL_URL || 'mqtt://localhost:1883',
  },
};

export default config;
