import pg from 'pg';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

const log = logger.child('db');

/**
 * Optional PostgreSQL persistence.
 *
 * TravelGuard runs entirely on the in-memory working set so the demo boots with
 * zero setup, but when DATABASE_URL is present every state transition is
 * mirrored into PostgreSQL for durable audit — the API itself never blocks on
 * the database, so a slow or absent database can never break a recovery.
 */
let pool = null;
let status = { configured: Boolean(config.database.url), connected: false, error: null, lastWriteAt: null };

if (config.database.url) {
  pool = new pg.Pool({
    connectionString: config.database.url,
    ssl: config.database.ssl ? { rejectUnauthorized: false } : undefined,
    max: 5,
    idleTimeoutMillis: 30000,
  });

  pool
    .query('SELECT 1')
    .then(() => {
      status.connected = true;
      log.info('connected to PostgreSQL');
      return ensureSchema();
    })
    .catch((error) => {
      status.error = error.message;
      log.warn(`PostgreSQL unavailable (${error.message}) — continuing with in-memory audit only`);
    });
} else {
  log.info('no DATABASE_URL set — using in-memory repository (demo mode)');
}

async function ensureSchema() {
  if (!pool) return;
  const ddl = `
    CREATE TABLE IF NOT EXISTS trips (
      id TEXT PRIMARY KEY,
      code TEXT,
      traveler_id TEXT,
      status TEXT,
      phase TEXT,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS disruptions (
      id TEXT PRIMARY KEY,
      trip_id TEXT,
      scenario_id TEXT,
      type TEXT,
      flight_number TEXT,
      reason TEXT,
      severity TEXT,
      detected_at TIMESTAMPTZ,
      detection_ms INTEGER,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      trip_id TEXT,
      scenario_id TEXT,
      status TEXT,
      decision TEXT,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      recovery_ms INTEGER,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      trip_id TEXT,
      reference TEXT,
      status TEXT,
      label TEXT,
      added_fare INTEGER,
      approved_by TEXT,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS hotel_updates (
      id TEXT PRIMARY KEY,
      trip_id TEXT,
      confirmation TEXT,
      previous_arrival TIMESTAMPTZ,
      confirmed_arrival TIMESTAMPTZ,
      hold_until TIMESTAMPTZ,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      trip_id TEXT,
      level TEXT,
      category TEXT,
      title TEXT,
      body TEXT,
      channels JSONB,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS agent_events (
      id TEXT PRIMARY KEY,
      trip_id TEXT,
      type TEXT,
      level TEXT,
      title TEXT,
      detail TEXT,
      actor TEXT,
      at TIMESTAMPTZ,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_agent_events_trip ON agent_events (trip_id, at DESC);
    CREATE INDEX IF NOT EXISTS idx_notifications_trip ON notifications (trip_id, created_at DESC);
  `;
  await pool.query(ddl);
  log.info('schema ensured');
}

async function upsert(table, record) {
  if (!pool || !status.connected) return { persisted: false, reason: status.configured ? 'not-connected' : 'not-configured' };
  try {
    const columns = Object.keys(record);
    const values = Object.values(record).map((value) =>
      value && typeof value === 'object' && !(value instanceof Date) ? JSON.stringify(value) : value,
    );
    const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
    await pool.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})
       ON CONFLICT (id) DO UPDATE SET ${columns
         .filter((c) => c !== 'id')
         .map((c) => `${c} = EXCLUDED.${c}`)
         .join(', ')}`,
      values,
    );
    status.lastWriteAt = new Date().toISOString();
    return { persisted: true };
  } catch (error) {
    status.error = error.message;
    log.warn(`write to ${table} failed: ${error.message}`);
    return { persisted: false, reason: error.message };
  }
}

export const db = {
  get enabled() {
    return Boolean(pool);
  },
  upsert,
  status: () => ({ ...status, driver: 'pg', url: config.database.url ? 'configured' : null }),
  stats: async () => {
    if (!pool || !status.connected) return null;
    const { rows } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM trips) AS trips,
        (SELECT COUNT(*) FROM disruptions) AS disruptions,
        (SELECT COUNT(*) FROM workflows) AS workflows,
        (SELECT COUNT(*) FROM bookings) AS bookings,
        (SELECT COUNT(*) FROM notifications) AS notifications,
        (SELECT COUNT(*) FROM agent_events) AS agent_events
    `);
    return rows[0];
  },
  close: async () => {
    if (pool) await pool.end();
  },
};

export const databaseStatus = () => db.status();
