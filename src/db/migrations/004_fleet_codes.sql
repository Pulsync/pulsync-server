-- Migration 004: Fleet codes (PLF- prefix) for multi-device enrollment

CREATE TABLE IF NOT EXISTS fleet_codes (
    id SERIAL PRIMARY KEY,
    code VARCHAR(16) NOT NULL UNIQUE,
    name VARCHAR(64),
    max_devices INTEGER DEFAULT 0,          -- 0 = unlimited
    enrolled_count INTEGER DEFAULT 0,
    mac_allowlist JSONB DEFAULT '[]'::jsonb, -- ["AA:BB:CC:DD:EE:FF", ...] empty = allow any
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_active BOOLEAN NOT NULL DEFAULT true
);

-- Link devices to fleet codes (optional, tracks which fleet a device came from)
ALTER TABLE devices ADD COLUMN IF NOT EXISTS fleet_code_id INTEGER REFERENCES fleet_codes(id);
