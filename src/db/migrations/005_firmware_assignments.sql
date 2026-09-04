-- Migration 005: Per-device firmware assignments (free-tier OTA targeting)
--
-- Attaches a specific firmware build to a specific device. One assignment per
-- device (UNIQUE device_id) — re-attaching replaces the previous assignment.
-- The heartbeat resolver offers the assigned firmware when it differs from what
-- the device currently reports (force semantics: supports rollback/downgrade).

CREATE TABLE IF NOT EXISTS firmware_assignments (
    id SERIAL PRIMARY KEY,
    device_id UUID NOT NULL UNIQUE REFERENCES devices(id) ON DELETE CASCADE,
    firmware_id INTEGER NOT NULL REFERENCES firmware(id) ON DELETE CASCADE,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
