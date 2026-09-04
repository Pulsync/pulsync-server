/**
 * device-signing — server-to-device message authentication.
 *
 * The device authenticates the SERVER (and the OTA offer) using a symmetric key
 * derived from the device's enrollment token. Both sides derive the same key
 * independently, so nothing extra is stored or transmitted.
 *
 * Scheme (v1):
 *   key = HKDF-SHA256(ikm = token bytes, salt = "", info = "pulsync-ota-v1", 32B)
 *   sig = HMAC-SHA256(key, canonical) as lowercase hex
 * where `canonical` is the newline-joined signed fields (see canonicalOtaOffer).
 *
 * This is the baseline for BOTH self-hosted and hosted. Hosted may later add
 * TLS transport and/or an asymmetric firmware signature on top; the sig_alg
 * field lets the device distinguish schemes without a breaking change.
 */

import { hkdfSync, createHmac, timingSafeEqual } from 'node:crypto';

export const OTA_SIG_ALG = 'hmac-sha256-v1';
const HKDF_INFO = 'pulsync-ota-v1';

/**
 * Derive the per-device signing key from its enrollment token.
 * @param {string} token - the device's enrollment token (e.g. "pst_...")
 * @returns {Buffer} 32-byte key
 */
export function deriveDeviceKey(token) {
  // ikm = the token's raw bytes; salt empty; fixed info label; 32-byte output.
  const key = hkdfSync('sha256', Buffer.from(token, 'utf8'), Buffer.alloc(0),
                       Buffer.from(HKDF_INFO, 'utf8'), 32);
  return Buffer.from(key); // hkdfSync returns an ArrayBuffer
}

/**
 * Build the canonical string that gets signed for an OTA offer.
 * MUST match the device's reconstruction byte-for-byte.
 * Order: version, url, checksum, size — newline-joined.
 */
export function canonicalOtaOffer({ version, url, checksum, size }) {
  return [version, url, checksum, String(size)].join('\n');
}

/**
 * Sign an OTA offer. Returns the lowercase-hex HMAC.
 * @param {string} token - device enrollment token
 * @param {object} fields - { version, url, checksum, size }
 */
export function signOtaOffer(token, fields) {
  const key = deriveDeviceKey(token);
  const canonical = canonicalOtaOffer(fields);
  return createHmac('sha256', key).update(canonical, 'utf8').digest('hex');
}

/**
 * Verify an OTA offer signature (server-side helper, mainly for tests).
 */
export function verifyOtaOffer(token, fields, sigHex) {
  const expected = signOtaOffer(token, fields);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(String(sigHex || ''), 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
