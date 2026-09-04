/**
 * Core config-password — device config-portal gate credential.
 *
 * The server owns the config-portal password. It:
 *   - generates a random human-friendly password (time-based entropy as the
 *     generation salt — this is ONLY the randomness used at creation, not a
 *     separate hashing salt),
 *   - keeps the plaintext for dashboard reveal,
 *   - sends the device only H(password) = plain SHA-256 hex, which the device
 *     stores and checks against offline (SHA256(entered) === stored_hash).
 *
 * Auth-agnostic: no tenant/access logic here.
 */

import crypto from 'node:crypto';

// Ambiguous-looking characters (0/O, 1/l/I) are dropped so a revealed password
// is easy to read off a dashboard and type into a phone on the captive portal.
// A small set of form-safe specials is added for extra per-char entropy. We
// deliberately EXCLUDE space (invisible/trimmed on reveal + typing) and the
// form-encoding-sensitive chars = + & % (the password rides in urlencoded
// bodies on both the dashboard login and the device /login).
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$^*-_?';
const PASSWORD_LEN = 8;   // ~6 bits/char over a 64-char set ≈ 48 bits — plenty
                          // for a proximity gate on an open AP, easy to type.

/**
 * Generate a random config-portal password.
 * Time-based entropy is folded into the RNG seed material as the generation
 * salt (creation randomness only — the stored hash is plain SHA-256, no salt).
 * @returns {string} plaintext password
 */
export function generateConfigPassword() {
  // Mix a time-based salt into the entropy pool at generation time.
  const timeSalt = Buffer.from(String(Date.now()) + String(process.hrtime.bigint()));
  const rand = crypto.randomBytes(PASSWORD_LEN * 2);
  const mixed = crypto.createHash('sha512').update(Buffer.concat([timeSalt, rand])).digest();

  let out = '';
  for (let i = 0; i < PASSWORD_LEN; i++) {
    out += ALPHABET[mixed[i] % ALPHABET.length];
  }
  return out;
}

/**
 * Hash a config-portal password for delivery to the device.
 * Plain SHA-256 hex, no separate salt (matches the device's offline check
 * SHA256(entered) === stored_hash).
 * @param {string} password
 * @returns {string} lowercase hex SHA-256
 */
export function hashConfigPassword(password) {
  return crypto.createHash('sha256').update(String(password), 'utf8').digest('hex');
}

/**
 * Generate a fresh password and its hash in one call.
 * @returns {{ password: string, hash: string }}
 */
export function newConfigPassword() {
  const password = generateConfigPassword();
  return { password, hash: hashConfigPassword(password) };
}
