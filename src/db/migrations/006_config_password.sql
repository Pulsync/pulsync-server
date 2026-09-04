-- Migration 006: Config-portal password (device-side gate)
--
-- Once a device is enrolled, its captive config menu is gated behind a password.
-- The server owns the password:
--   * config_password       — plaintext, for dashboard "reveal" (behind admin login)
--   * config_password_hash  — plain SHA-256 hex of the password; this is what the
--                             device stores and checks against offline. The device
--                             never holds the plaintext.
-- The password is generated at enrollment and re-generatable from the dashboard;
-- regenerate pushes a new hash on the next heartbeat and the old password stops
-- working. The generation salt is time-based entropy used only when creating the
-- value (NOT a separate hashing salt): the hash is plain SHA-256(password).

ALTER TABLE devices ADD COLUMN IF NOT EXISTS config_password VARCHAR(64);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS config_password_hash VARCHAR(64);
