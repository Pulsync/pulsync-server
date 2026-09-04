/**
 * Pulsync Standalone Server — Self-hosted distribution
 *
 * Loads core device protocol + simple token auth.
 * No multi-tenant, no OAuth, no billing, no admin panel.
 * Just: devices connect, send data, receive commands.
 *
 * Auth: single DEVICE_SECRET env var. All devices use the same token.
 * (or per-device tokens via pairing codes — both work)
 */

import 'dotenv/config';
import express from 'express';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import config from '../config.js';
import { testConnection, query } from '../db/connection.js';
import { authenticateDevice, deviceAuthMiddleware } from './auth.js';
import routes from './routes.js';
import { adminAuthMiddleware } from './admin-auth.js';
import { initDeviceWS, disconnectAllDevices, setTransportChecker } from '../core/device-ws.js';
import { initFrontendWS } from '../core/frontend-ws.js';
import { initEmbeddedMQTT, getMqttPort } from '../core/mqtt-embedded.js';
import { findDeviceByToken } from '../core/queries.js';
import { setBaseUrl } from '../core/base-url.js';
import { setMqttEndpoint } from '../core/mqtt-endpoint.js';
import { startMdnsIfFree, stopMdns } from '../core/mdns.js';

const app = express();
const server = createServer(app);

/**
 * Get the LAN IP address of this machine.
 */
function getLanIP() {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254')) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

/**
 * Find a free port starting from the preferred port.
 */
function findFreePort(startPort) {
  return new Promise((resolve) => {
    const tester = createServer();
    tester.once('error', () => resolve(findFreePort(startPort + 1)));
    tester.once('listening', () => { tester.close(() => resolve(startPort)); });
    tester.listen(startPort);
  });
}

const LAN_IP = getLanIP();

// Body parsing
app.use(express.json());

// Request logging
app.use('/api/device', (req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`[REQ] ${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`);
  });
  next();
});

// Dashboard (served at root)
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));

// Shared brand assets (logo/favicon) — same path the frontends use, so the
// dashboard's favicon resolves on the standalone server too.
app.use('/shared', express.static(join(__dirname, '../../../shared')));

app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'dashboard.html'));
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    mode: 'standalone',
    version: '0.1.0',
    ip: LAN_IP,
  });
});

// Server info (used by dashboard for QR generation) — fresh IP on each request
app.get('/api/server-info', (req, res) => {
  res.json({ ip: getLanIP(), port: server.address()?.port || config.port });
});

// QR code generation endpoint
import QRCode from 'qrcode';
app.get('/api/qr', async (req, res) => {
  const text = req.query.text;
  if (!text) return res.status(400).json({ error: 'Missing ?text=' });
  try {
    const dataUrl = await QRCode.toDataURL(text, {
      width: 200,
      margin: 2,
      color: { dark: '#0B1120', light: '#FFFFFF' }
    });
    res.json({ qr: dataUrl });
  } catch (e) {
    res.status(500).json({ error: 'QR generation failed' });
  }
});

// Transport control (testing only)
const disabledTransports = new Set();

app.get('/api/transport', (req, res) => {
  res.json({
    wss: !disabledTransports.has('wss'),
    mqtt: !disabledTransports.has('mqtt'),
    https: !disabledTransports.has('https'),
  });
});

app.post('/api/transport/:type/disable', adminAuthMiddleware, (req, res) => {
  const type = req.params.type;
  disabledTransports.add(type);
  console.log(`[TRANSPORT] Disabled: ${type}`);
  if (type === 'wss') {
    disconnectAllDevices();
  }
  res.json({ disabled: type, active: { wss: !disabledTransports.has('wss'), mqtt: !disabledTransports.has('mqtt'), https: !disabledTransports.has('https') } });
});

app.post('/api/transport/:type/enable', adminAuthMiddleware, (req, res) => {
  disabledTransports.delete(req.params.type);
  console.log(`[TRANSPORT] Enabled: ${req.params.type}`);
  res.json({ enabled: req.params.type, active: { wss: !disabledTransports.has('wss'), mqtt: !disabledTransports.has('mqtt'), https: !disabledTransports.has('https') } });
});

// Device-facing REST routes
app.use('/api/device', routes);

// Firmware binary serving (for OTA).
// NOTE: mounted at /api/device/fw-bin (NOT /api/device/firmware) so it does not
// shadow the admin routes GET/POST /api/device/firmware and
// POST /api/device/firmware/:id/activate.
// Gated by device auth: only enrolled devices (X-Device-Token) can pull binaries,
// so firmware .bin files aren't enumerable/downloadable by anyone on the LAN.
// The device attaches this header via its OTA http_client_init_cb.
app.use('/api/device/fw-bin', deviceAuthMiddleware, express.static(config.ota.storagePath));

// 404 for unmatched API routes
app.use('/api/{*splat}', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Initialize WebSocket for devices
initDeviceWS(server, async (token) => {
  return await authenticateDevice(token);
});
setTransportChecker((type) => disabledTransports.has(type));

// Initialize WebSocket for dashboard
initFrontendWS(server);

// Initialize embedded MQTT broker (port 1883, in-process)
const mqttPort = parseInt(process.env.MQTT_PORT || '1883');
// Re-assert the advertised MQTT endpoint with the port the broker actually
// bound to (the listen callback may run before this async bind resolves, and
// the broker can fall back to mqttPort+1).
initEmbeddedMQTT(mqttPort)
  .then(() => setMqttEndpoint(LAN_IP, getMqttPort() ?? mqttPort, false))
  .catch(err => {
    console.warn(`[MQTT] Failed on port ${mqttPort}, trying ${mqttPort + 1}`);
    initEmbeddedMQTT(mqttPort + 1)
      .then(() => setMqttEndpoint(LAN_IP, getMqttPort() ?? (mqttPort + 1), false))
      .catch(() => {});
  });

// Start
async function start() {
  console.log('[STANDALONE] Pulsync self-hosted server starting...');

  const dbReady = await testConnection();
  if (!dbReady) {
    console.error('[STANDALONE] Database connection failed. Exiting.');
    process.exit(1);
  }

  // Run migrations
  try {
    const { readdir, readFile } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const migrationsDir = join(__dirname, '../db/migrations');

    // Detect if SQLite or PostgreSQL based on DATABASE_URL
    const isSqlite = !process.env.DATABASE_URL || !process.env.DATABASE_URL.startsWith('postgresql');

    // Create migrations table (compatible syntax)
    if (isSqlite) {
      await query(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    } else {
      await query(`CREATE TABLE IF NOT EXISTS _migrations (id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    }

    const applied = new Set((await query('SELECT name FROM _migrations ORDER BY id')).rows.map(r => r.name));
    const files = (await readdir(migrationsDir)).filter(f => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      // Skip SQLite-specific migrations on Postgres and vice versa
      if (isSqlite && file.startsWith('002')) continue; // Skip PG-specific
      if (isSqlite && file.startsWith('003')) continue;
      if (isSqlite && file.startsWith('004')) continue;
      if (isSqlite && file.startsWith('005')) continue; // PG-specific; SQLite gets it from 001_sqlite_init
      if (isSqlite && file.startsWith('006')) continue; // PG-specific; SQLite gets config_password cols from 001_sqlite_init
      if (!isSqlite && file === '001_sqlite_init.sql') continue;

      const sql = await readFile(join(migrationsDir, file), 'utf-8');
      try {
        // SQLite needs statements run individually
        if (isSqlite) {
          const statements = sql.split(';').map(s => s.trim()).filter(s => s.length > 0 && !s.startsWith('--'));
          for (const stmt of statements) {
            await query(stmt);
          }
        } else {
          await query(sql);
        }
        await query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
        console.log(`[MIGRATE] Applied: ${file}`);
      } catch (migErr) {
        // Skip already-applied or syntax issues on wrong db type
        if (!migErr.message.includes('already exists') && !migErr.message.includes('duplicate')) {
          console.warn(`[MIGRATE] Skipped ${file}: ${migErr.message}`);
        }
      }
    }
  } catch (err) {
    console.warn('[MIGRATE] Migration error:', err.message);
  }

  const preferredPort = config.port;
  const port = await findFreePort(preferredPort);
  server.listen(port, () => {
    // Publish the absolute base URL so OTA offers hand devices a fetchable URL.
    setBaseUrl(`http://${LAN_IP}:${port}`);
    // Advertise the MQTT broker endpoint so enrolled devices connect to the
    // right place without deriving it from the HTTP host. Local broker is
    // plaintext on the LAN. Use the actual bound port (may differ on fallback).
    setMqttEndpoint(LAN_IP, getMqttPort() ?? mqttPort, false);
    console.log(`[STANDALONE] Server listening on port ${port}`);
    console.log(`[STANDALONE] Dashboard: http://${LAN_IP}:${port}/`);
    console.log(`[STANDALONE] Health: http://${LAN_IP}:${port}/api/health`);
    console.log(`[STANDALONE] Device WS: ws://${LAN_IP}:${port}/api/device/ws`);
    console.log(`[STANDALONE] DEVICE_SECRET: ${process.env.DEVICE_SECRET ? 'configured' : 'NOT SET (using per-device tokens only)'}`);

    // Advertise on the LAN as "<hostname>.local" so devices find us by name.
    // Probe first: if a responder already owns the name, we stand down.
    if (config.mdns.enable) {
      // Use the port the broker actually bound to (may differ from the
      // requested one if it fell back); default to the requested port if the
      // async bind hasn't resolved yet.
      const actualMqttPort = getMqttPort() ?? mqttPort;
      startMdnsIfFree({ hostname: config.mdns.hostname, httpPort: port, mqttPort: actualMqttPort })
        .then((started) => {
          if (started) {
            console.log(`[STANDALONE] mDNS: http://${config.mdns.hostname}.local:${port}/ (set setServer("${config.mdns.hostname}.local") on devices)`);
          }
        })
        .catch((err) => console.warn(`[MDNS] startup error: ${err?.message || err}`));
    }
  });
}

// Graceful shutdown
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[STANDALONE] Shutting down...');
  server.close();
  // Send mDNS goodbye packets so clients drop the record promptly. Cap the
  // wait so a stuck responder can't block exit.
  const done = () => process.exit(0);
  const timer = setTimeout(done, 1500);
  stopMdns(() => { clearTimeout(timer); done(); });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start();
