/**
 * Simple migration runner
 *
 * Reads .sql files from migrations/ in order, skips already-applied ones.
 * Run: node src/db/migrate.js
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, testConnection, close } from './connection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');

async function ensureMigrationsTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function getAppliedMigrations() {
  const result = await query('SELECT name FROM _migrations ORDER BY id');
  return new Set(result.rows.map((r) => r.name));
}

async function migrate() {
  const connected = await testConnection();
  if (!connected) {
    console.error('[MIGRATE] Cannot connect to database. Exiting.');
    process.exit(1);
  }

  await ensureMigrationsTable();
  const applied = await getAppliedMigrations();

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf-8');
    console.log(`[MIGRATE] Applying: ${file}`);

    try {
      await query(sql);
      await query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
      count++;
    } catch (err) {
      console.error(`[MIGRATE] Failed on ${file}:`, err.message);
      process.exit(1);
    }
  }

  if (count === 0) {
    console.log('[MIGRATE] All migrations already applied.');
  } else {
    console.log(`[MIGRATE] Applied ${count} migration(s).`);
  }

  await close();
}

migrate();
