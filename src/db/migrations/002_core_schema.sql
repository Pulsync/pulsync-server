-- Migration 002: Core device protocol schema
-- Devices, telemetry, config, commands, firmware

CREATE TABLE IF NOT EXISTS devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pairing_code VARCHAR(16) UNIQUE,
    token VARCHAR(128) UNIQUE,
    name VARCHAR(64),
    tags JSONB DEFAULT '[]'::jsonb,
    fw_version VARCHAR(32),
    last_seen TIMESTAMPTZ,
    last_ip VARCHAR(45),
    enrolled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS data_points (
    id BIGSERIAL PRIMARY KEY,
    device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    payload JSONB NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_data_points_device_time
    ON data_points (device_id, received_at DESC);

CREATE TABLE IF NOT EXISTS device_configs (
    id SERIAL PRIMARY KEY,
    device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    key VARCHAR(24) NOT NULL,
    value VARCHAR(64) NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(device_id, key)
);

CREATE TABLE IF NOT EXISTS firmware (
    id SERIAL PRIMARY KEY,
    version VARCHAR(32) NOT NULL UNIQUE,
    filename VARCHAR(128) NOT NULL,
    size_bytes INTEGER,
    checksum VARCHAR(64),
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_active BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS commands (
    id SERIAL PRIMARY KEY,
    device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    command VARCHAR(32) NOT NULL,
    payload JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delivered_at TIMESTAMPTZ,
    acknowledged_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_commands_device_pending
    ON commands (device_id, delivered_at)
    WHERE delivered_at IS NULL;
