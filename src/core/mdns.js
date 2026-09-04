/**
 * mDNS / Bonjour advertisement for the self-hosted server.
 *
 * Advertises the server on the local network so devices (and browsers) can
 * find it by a stable name — "<hostname>.local", default "pulsync.local" —
 * instead of a DHCP IP that changes on reboot. This is the zero-config LAN
 * story: flash `setServer("pulsync.local")` once and never touch the IP again.
 *
 * We advertise two things off a single publish:
 *   1. An A record for "<hostname>.local" (so a plain A query resolves it).
 *   2. A "_pulsync._tcp" service carrying the HTTP + MQTT ports in its TXT
 *      record (so a future browse-based discovery finds the server with
 *      nothing hardcoded at all).
 *
 * Meaningless for the hosted deployment (public DNS handles api.pulsync.in),
 * so this is gated by config and only wired into the standalone server.
 *
 * Uses bonjour-service (pure JS, no native build) — mDNS done wrong is a
 * network nuisance (name conflicts, multicast/interface handling), so we lean
 * on a maintained implementation rather than hand-rolling a responder.
 *
 * Caveat: mDNS is multicast on the LAN. Inside Docker it needs host networking
 * (multicast doesn't cross the default bridge). Documented in the README.
 */

import { Bonjour } from 'bonjour-service';
import makeMdns from 'multicast-dns';

let instance = null;
let service = null;

/**
 * Probe the LAN for an existing responder that already owns "<hostname>.local".
 *
 * Sends a one-shot multicast A query and waits up to `timeoutMs` for an answer.
 * Resolves to the responder's IP string if the name is already claimed, or
 * null if nobody answers (name is free — safe for us to publish).
 *
 * This is how we avoid stomping on an existing responder (a stale Pulsync
 * instance, another host that took the name, or an OS Bonjour/Avahi record).
 * If a resolver is already present for our name, we stand down.
 *
 * The probe uses multicast-dns (the same library bonjour-service is built on),
 * so it's not an extra dependency. It binds its own short-lived 5353 socket;
 * if that bind fails (e.g. an OS daemon owns the port exclusively) we treat it
 * as "couldn't determine" and let the caller decide.
 *
 * @param {string} hostname - name without ".local"
 * @param {number} [timeoutMs=750]
 * @returns {Promise<string|null>} existing owner's IP, or null if free
 * @throws if the probe socket could not be created (indeterminate)
 */
export function probeHostname(hostname, timeoutMs = 750) {
  const fqdn = `${hostname}.local`;
  return new Promise((resolve, reject) => {
    let mdns;
    try {
      mdns = makeMdns();
    } catch (err) {
      reject(err);
      return;
    }

    let settled = false;
    const finish = (result, err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { mdns.destroy(); } catch { /* ignore */ }
      if (err) reject(err);
      else resolve(result);
    };

    mdns.on('error', (err) => finish(null, err));

    mdns.on('response', (response) => {
      const answers = [...(response.answers || []), ...(response.additionals || [])];
      for (const a of answers) {
        if (a.type === 'A' && typeof a.name === 'string' &&
            a.name.toLowerCase() === fqdn.toLowerCase()) {
          finish(a.data || 'unknown');
          return;
        }
      }
    });

    // Nobody answered in the window → the name is free.
    const timer = setTimeout(() => finish(null), timeoutMs);

    try {
      mdns.query([{ name: fqdn, type: 'A' }]);
    } catch (err) {
      finish(null, err);
    }
  });
}

/**
 * Start advertising the server over mDNS.
 * No-op (returns false) if disabled via config or already running.
 *
 * @param {object} opts
 * @param {string} opts.hostname - name without ".local" (e.g. "pulsync")
 * @param {number} opts.httpPort - the HTTP port the server is listening on
 * @param {number} opts.mqttPort - the embedded MQTT broker port
 * @returns {boolean} true if advertisement started
 */
export function startMdns({ hostname, httpPort, mqttPort }) {
  if (instance) return false; // already running

  try {
    // errorCallback keeps a socket error (e.g. port 5353 unavailable, or an OS
    // responder already bound) from crashing the whole server. mDNS is a
    // convenience, never a hard dependency.
    instance = new Bonjour({}, (err) => {
      console.warn(`[MDNS] responder error (advertisement may be degraded): ${err?.message || err}`);
    });

    const fqdn = `${hostname}.local`;

    service = instance.publish({
      name: 'Pulsync Server',
      type: 'pulsync',        // → _pulsync._tcp.local
      protocol: 'tcp',
      port: httpPort,
      host: fqdn,             // publishes the A record for "<hostname>.local"
      txt: {
        http: String(httpPort),
        mqtt: String(mqttPort),
        path: '/',
        version: '1',         // TXT schema version, for forward-compat
      },
    });

    service.on('error', (err) => {
      console.warn(`[MDNS] publish error: ${err?.message || err}`);
    });

    console.log(`[MDNS] Advertising ${fqdn} (http:${httpPort}, mqtt:${mqttPort}) as _pulsync._tcp`);
    return true;
  } catch (err) {
    console.warn(`[MDNS] Failed to start advertisement: ${err?.message || err}`);
    instance = null;
    service = null;
    return false;
  }
}

/**
 * Probe for an existing responder that owns "<hostname>.local"; only start our
 * own advertisement if the name appears free.
 *
 * Behavior:
 *   - Name already claimed → log who has it and do NOT publish (return false).
 *   - Name free → publish and return true.
 *   - Probe indeterminate (e.g. couldn't bind the probe socket) → publish
 *     anyway and let bonjour-service's own conflict handling take over; a
 *     genuine collision surfaces as a publish "error" we log.
 *
 * @param {object} opts - same shape as startMdns()
 * @returns {Promise<boolean>} true if we started advertising
 */
export async function startMdnsIfFree({ hostname, httpPort, mqttPort }) {
  if (instance) return false; // already running

  let existing = null;
  try {
    existing = await probeHostname(hostname);
  } catch (err) {
    // Couldn't run the probe (socket bind failed, etc.). Don't block on it —
    // fall through and publish, relying on the responder's conflict detection.
    console.warn(`[MDNS] Name probe inconclusive (${err?.message || err}); publishing anyway.`);
    return startMdns({ hostname, httpPort, mqttPort });
  }

  if (existing) {
    console.warn(`[MDNS] ${hostname}.local is already claimed on this network by ${existing}; not advertising. ` +
                 `Set MDNS_HOSTNAME to a different name, or MDNS_ENABLE=false, if this isn't us.`);
    return false;
  }

  return startMdns({ hostname, httpPort, mqttPort });
}

/**
 * Stop advertising and release the socket. Sends mDNS "goodbye" packets so
 * clients drop the stale record promptly instead of waiting for TTL expiry.
 * Safe to call when not running. Invokes `done` once cleanup completes.
 */
export function stopMdns(done) {
  if (!instance) {
    if (done) done();
    return;
  }
  const inst = instance;
  instance = null;
  service = null;
  try {
    // unpublishAll sends the goodbye (TTL=0) records, then we tear down sockets.
    inst.unpublishAll(() => {
      try { inst.destroy(); } catch { /* ignore */ }
      if (done) done();
    });
  } catch (err) {
    console.warn(`[MDNS] Error during shutdown: ${err?.message || err}`);
    try { inst.destroy(); } catch { /* ignore */ }
    if (done) done();
  }
}
