/**
 * admin-auth — optional single-password gate for the standalone dashboard and
 * management/admin routes.
 *
 * - ADMIN_PASSWORD env unset/empty  => gate DISABLED (open). Default for dev.
 * - ADMIN_PASSWORD set              => management routes require a valid session
 *   cookie obtained by POSTing the password to /api/admin/login.
 *
 * The cookie holds a SIGNED session token (never the password). It's signed with
 * an HMAC over a server secret (JWT_SECRET, or an auto-generated per-process
 * secret). Device-facing routes (/enroll, /heartbeat, /data, /fw-bin) and MQTT
 * are NOT gated — devices authenticate with their own token.
 *
 * No external deps: node:crypto + manual cookie header handling.
 * NOTE: HttpOnly + SameSite=Lax, but NOT Secure — self-hosted runs plain HTTP on
 * a LAN, and a Secure cookie would never be sent. Fine for the local/testing
 * trust model; revisit when serving over HTTPS.
 */

import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import config from '../config.js';

const COOKIE_NAME = 'ps_admin';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Signing secret: prefer a real JWT_SECRET; otherwise generate an ephemeral one
// (sessions won't survive a restart, which is acceptable for dev/testing).
let SIGNING_SECRET = process.env.JWT_SECRET || '';
if (!SIGNING_SECRET || SIGNING_SECRET === 'dev-secret-change-in-production') {
  SIGNING_SECRET = randomBytes(32).toString('hex');
  if (config.admin.password) {
    console.warn('[ADMIN] No stable JWT_SECRET set; using an ephemeral signing key. '
      + 'Admin sessions will be invalidated on restart. Set JWT_SECRET to persist them.');
  }
}

/** Whether the admin gate is active. */
export function isAdminEnabled() {
  return !!config.admin.password;
}

/** Constant-time password check against ADMIN_PASSWORD. */
export function checkPassword(pw) {
  const expected = config.admin.password || '';
  if (!expected) return false;
  const a = Buffer.from(String(pw ?? ''), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // timingSafeEqual requires equal lengths; guard first (length isn't secret).
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function sign(payloadB64) {
  return createHmac('sha256', SIGNING_SECRET).update(payloadB64).digest('hex');
}

/** Create a signed session token: base64url(json).hmac */
export function makeSession() {
  const payload = { iat: Date.now(), exp: Date.now() + SESSION_TTL_MS };
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${b64}.${sign(b64)}`;
}

/** Verify a session token: signature valid + not expired. */
export function verifySession(token) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const b64 = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);
  const expectedSig = sign(b64);
  const pa = Buffer.from(providedSig, 'utf8');
  const ea = Buffer.from(expectedSig, 'utf8');
  if (pa.length !== ea.length || !timingSafeEqual(pa, ea)) return false;
  try {
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' && payload.exp > Date.now();
  } catch {
    return false;
  }
}

/** Parse a Cookie header into a { name: value } map. */
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function setSessionCookie(res) {
  const token = makeSession();
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`);
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

/** True if the request carries a valid admin session cookie. */
export function isAuthed(req) {
  const cookies = parseCookies(req.headers['cookie']);
  return verifySession(cookies[COOKIE_NAME]);
}

/**
 * Express middleware gating admin/management routes.
 * If the gate is disabled, passes through. Otherwise requires a valid session.
 */
export function adminAuthMiddleware(req, res, next) {
  if (!isAdminEnabled()) return next();
  if (isAuthed(req)) return next();
  return res.status(401).json({ error: 'Admin authentication required' });
}
