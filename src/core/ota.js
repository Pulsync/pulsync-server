/**
 * Core OTA — firmware management
 *
 * Handles firmware upload, version management, serving.
 * Auth-agnostic for the serving part (devices download via token).
 */

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import config from '../config.js';
import * as db from './queries.js';

// Ensure storage directory exists
const storagePath = config.ota.storagePath;
if (!existsSync(storagePath)) {
  mkdirSync(storagePath, { recursive: true });
}

/**
 * Validate the firmware version format.
 * Accepts: X.Y.Z, optionally followed by a label (e.g. -dev3, -rc2, -beta).
 * The label may contain AT MOST ONE number, because the device compares
 * versions by their numbers only (major.minor.patch + one label counter = 4).
 * A label with more than one number (e.g. 0.1.1-dev3.2) is rejected so ordering
 * stays unambiguous.
 */
function isValidSemver(version) {
  // Structure: three dot-separated integers, optional -label of allowed chars.
  if (!/^\d+\.\d+\.\d+(-[a-zA-Z0-9._-]+)?$/.test(version)) return false;
  // Count integers in the label (everything after the first '-').
  const dash = version.indexOf('-');
  if (dash === -1) return true;
  const label = version.slice(dash + 1);
  const numbersInLabel = label.match(/\d+/g);
  return !numbersInLabel || numbersInLabel.length <= 1;
}

/**
 * Upload a firmware binary.
 * @param {string} version - Semver version string
 * @param {Buffer} fileBuffer - Raw binary content
 * @param {string} originalName - Original filename
 * @returns {{ success: boolean, firmware?: object, error?: string }}
 */
export async function uploadFirmware(version, fileBuffer, originalName) {
  if (!isValidSemver(version)) {
    return { success: false, error: 'Invalid version. Use x.y.z or x.y.z-label with at most one number in the label (e.g. 0.1.1, 0.1.1-dev3).' };
  }

  // Generate unique filename
  const filename = `pulsync_${version.replace(/[^a-zA-Z0-9.-]/g, '_')}.bin`;
  const filepath = join(storagePath, filename);

  // Write to disk
  await writeFile(filepath, fileBuffer);

  // Calculate checksum
  const crypto = await import('node:crypto');
  const checksum = crypto.createHash('sha256').update(fileBuffer).digest('hex');

  // Store in DB
  try {
    const firmware = await db.insertFirmware(version, filename, fileBuffer.length, checksum);
    console.log(`[OTA] Firmware uploaded: v${version} (${fileBuffer.length} bytes)`);
    return { success: true, firmware };
  } catch (err) {
    // Cleanup file on DB error (likely duplicate version)
    await unlink(filepath).catch(() => {});
    if (err.code === '23505') {
      return { success: false, error: `Version ${version} already exists` };
    }
    throw err;
  }
}

/**
 * Activate a firmware version for deployment.
 * @param {number} firmwareId - Firmware record ID
 */
export async function activateFirmware(firmwareId) {
  await db.activateFirmware(firmwareId);
  console.log(`[OTA] Firmware ${firmwareId} activated`);
}

/**
 * Get the file path for a firmware binary (for serving to devices).
 * @param {string} filename - Firmware filename
 * @returns {string|null} Full file path or null if not found
 */
export function getFirmwarePath(filename) {
  const filepath = join(storagePath, filename);
  if (existsSync(filepath)) {
    return filepath;
  }
  return null;
}

/**
 * List all firmware versions.
 */
export async function listFirmware() {
  return await db.listFirmware();
}

/**
 * Get active firmware info.
 */
export async function getActive() {
  return await db.getActiveFirmware();
}
