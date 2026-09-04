-- SQLite-compatible schema (used when no DATABASE_URL is set)
-- This file is only run on SQLite databases.

CREATE TABLE IF NOT EXISTS _migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6)))),
  pairing_code TEXT UNIQUE,
  token TEXT UNIQUE,
  name TEXT,
  mac_address TEXT UNIQUE,
  tags TEXT DEFAULT '[]',
  fw_version TEXT,
  last_seen TEXT,
  last_ip TEXT,
  enrolled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  metadata TEXT DEFAULT '{}',
  fleet_code_id INTEGER REFERENCES fleet_codes(id),
  config_password TEXT,
  config_password_hash TEXT
);

CREATE TABLE IF NOT EXISTS data_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_data_points_device_time ON data_points (device_id, received_at DESC);

CREATE TABLE IF NOT EXISTS device_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(device_id, key)
);

CREATE TABLE IF NOT EXISTS firmware (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  size_bytes INTEGER,
  checksum TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  is_active INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  command TEXT NOT NULL,
  payload TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at TEXT,
  acknowledged_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_commands_device_pending ON commands (device_id, delivered_at) WHERE delivered_at IS NULL;

CREATE TABLE IF NOT EXISTS fleet_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT,
  max_devices INTEGER DEFAULT 0,
  enrolled_count INTEGER DEFAULT 0,
  mac_allowlist TEXT DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS firmware_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL UNIQUE REFERENCES devices(id) ON DELETE CASCADE,
  firmware_id INTEGER NOT NULL REFERENCES firmware(id) ON DELETE CASCADE,
  assigned_at TEXT NOT NULL DEFAULT (datetime('now'))
);
