-- Migration 003: Add MAC address to devices (permanent device identity)

ALTER TABLE devices ADD COLUMN IF NOT EXISTS mac_address VARCHAR(17) UNIQUE;

CREATE INDEX IF NOT EXISTS idx_devices_mac ON devices (mac_address) WHERE mac_address IS NOT NULL;
