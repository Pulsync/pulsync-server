/**
 * Database connection — auto-detects PostgreSQL or SQLite
 *
 * If DATABASE_URL is set → PostgreSQL (pg)
 * If DATABASE_URL is not set → SQLite (better-sqlite3) at ./pulsync.db
 *
 * Both export the same query(text, params) interface.
 */

import config from '../config.js';

let driver = null; // 'pg' or 'sqlite'
let pool = null;
let db = null;

/**
 * Initialize the database connection.
 */
async function init() {
  if (config.db.url && config.db.url.startsWith('postgresql')) {
    // PostgreSQL
    driver = 'pg';
    const pg = await import('pg');
    pool = new pg.default.Pool({
      connectionString: config.db.url,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    pool.on('error', (err) => {
      console.error('[DB] Pool error:', err.message);
    });
  } else {
    // SQLite
    driver = 'sqlite';
    const Database = (await import('better-sqlite3')).default;
    const dbPath = config.db.sqlitePath || './pulsync.db';
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    console.log(`[DB] SQLite database: ${dbPath}`);
  }
}

/**
 * Run a query.
 * @param {string} text - SQL query (uses $1, $2... for params)
 * @param {any[]} params - Query parameters
 * @returns {{ rows: any[] }}
 */
export async function query(text, params = []) {
  if (!driver) await init();

  if (driver === 'pg') {
    const start = Date.now();
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    if (duration > 1000) {
      console.warn(`[DB] Slow query (${duration}ms):`, text.slice(0, 80));
    }
    return result;
  }

  // SQLite — translate the Postgres dialect the queries are written in:
  //   $1,$2...  → ?1,?2...        (SQLite NUMBERED params)
  //   NOW()     → datetime('now') (current timestamp)
  //
  // Using ?N (not bare ?) is important: Postgres $N are reusable and
  // order-independent (a query may write "$2 ... $1" or reuse "$3" twice),
  // whereas a bare ? binds strictly by appearance order. ?N preserves the
  // $N semantics exactly. better-sqlite3 binds ?N from an object keyed by the
  // number, so we map the positional params array to { "1": v0, "2": v1, ... }.
  // RETURNING and ON CONFLICT ... DO UPDATE are supported natively by the
  // bundled SQLite (3.35+ / 3.24+), so they need no rewriting.
  const sqliteText = text
    .replace(/\$(\d+)/g, '?$1')
    .replace(/\bNOW\(\)/gi, "datetime('now')");

  // Build the numbered-param binding object ({1: params[0], 2: params[1], ...}).
  // better-sqlite3 rejects undefined bindings, and a query may not reference
  // every positional slot, so only include indices actually present in the SQL.
  const usedIdx = new Set();
  for (const m of text.matchAll(/\$(\d+)/g)) usedIdx.add(parseInt(m[1], 10));
  const bind = {};
  for (const i of usedIdx) {
    const v = params[i - 1];
    // Normalize JS undefined → null (SQLite has no undefined; PG treated missing
    // as null too for these queries).
    bind[String(i)] = v === undefined ? null : v;
  }
  const hasParams = usedIdx.size > 0;

  // Determine if it's a SELECT/RETURNING or a write operation
  const isSelect = /^\s*(SELECT|WITH)/i.test(text);
  const hasReturning = /RETURNING/i.test(text);

  try {
    const stmt = db.prepare(sqliteText);
    if (isSelect || hasReturning) {
      const rows = hasParams ? stmt.all(bind) : stmt.all();
      return { rows };
    } else {
      const info = hasParams ? stmt.run(bind) : stmt.run();
      return { rows: [], rowCount: info.changes };
    }
  } catch (err) {
    // Handle SQLite-specific errors
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      const pgError = new Error(err.message);
      pgError.code = '23505'; // PG unique violation code
      throw pgError;
    }
    throw err;
  }
}

/**
 * Test the database connection.
 */
export async function testConnection() {
  try {
    if (!driver) await init();
    if (driver === 'pg') {
      await pool.query('SELECT 1');
    } else {
      db.prepare('SELECT 1').get();
    }
    console.log(`[DB] Connected (${driver})`);
    return true;
  } catch (err) {
    console.error('[DB] Connection failed:', err.message);
    return false;
  }
}

/**
 * Close the connection.
 */
export async function close() {
  if (driver === 'pg' && pool) {
    await pool.end();
  } else if (driver === 'sqlite' && db) {
    db.close();
  }
  console.log('[DB] Closed');
}

export default { query, testConnection, close };
