# Pulsync Server (self-hosted)

The self-hostable Pulsync IoT server: the device protocol (enrollment,
heartbeat, telemetry, commands, OTA, remote config) plus a local dashboard.
Runs fully self-contained — **SQLite** for storage and an **in-process MQTT
broker** — so no external database or broker is required.

## Requirements

- Node.js 20+
- Build tools for the native `better-sqlite3` module (Xcode Command Line Tools
  on macOS, `build-essential` on Debian/Ubuntu). Usually already present.

## Run

```bash
npm install
npm start
```

Then open the dashboard at `http://localhost:3456/`. On the LAN the server also
advertises itself as `pulsync.local`, so devices can find it by name.

Configuration is via environment variables — see `.env.example`. With none set,
the defaults give you SQLite + embedded MQTT on port 3456.

## Security notes

- **`ADMIN_PASSWORD`** gates the dashboard + management routes. It's empty
  (open) by default, which is fine on a trusted LAN. **Set it if the dashboard
  is reachable beyond your trusted network.**
- **`JWT_SECRET`** signs admin session cookies. If you leave it unset, a random
  key is generated per process, so admin sessions reset on every restart. Set a
  long random value (`openssl rand -hex 32`) to keep sessions stable.
- The dashboard runs over plain HTTP (no TLS) — intended for LAN use. Put it
  behind a reverse proxy with TLS if you expose it publicly.

## Docker (optional)

Docker is **not** required — plain Node works. A `docker-compose.yml` is provided
for convenience if you prefer containerized deployment.

## Connecting a device

Generate a pairing code from the dashboard (Settings → Generate Pairing Code),
then in your ESP32 firmware:

```cpp
Pulsync.setServer("pulsync.local:3456");  // or your server's host:port
Pulsync.begin("PUL-XXXXXX");              // the pairing code
```

Devices can also discover a local server automatically — see the library docs.

---

Part of the Pulsync platform. This is the open, self-hosted distribution; the
hosted multi-tenant platform lives separately.
