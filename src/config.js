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

  jwt: {
    secret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
  },

  admin: {
    // Optional single-password gate for the standalone dashboard + management
    // routes. Empty = gate disabled (open), which is the default for local dev.
    password: process.env.ADMIN_PASSWORD || '',
  },

  email: {
    provider: process.env.EMAIL_PROVIDER || '',
    from: process.env.EMAIL_FROM || 'Pulsync <info@pulsync.in>',
    resendApiKey: process.env.RESEND_API_KEY || '',
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

  log: {
    provider: process.env.LOG_PROVIDER || '',
    apiKey: process.env.LOG_API_KEY || '',
  },
};

export default config;
