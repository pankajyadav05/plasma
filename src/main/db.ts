import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { app } from 'electron';
import { logger } from './logger';

/**
 * Local SQLite store for connections, query history, and settings.
 *
 * File location: `userData/plasma.db`
 * Encryption: passwords are encrypted via Electron `safeStorage` at
 * the vault layer; SQLite itself is not encrypted. Non-password metadata
 * is stored in plaintext (host, port, db name). Full-row encryption is
 * a future enhancement (audit item #62).
 *
 * Schema is versioned via PRAGMA user_version so we can run forward
 * migrations safely in later releases.
 */

/**
 * Schema versions:
 *   1 — initial tables (connections, query_history, settings)
 *   2 — connections.engine column
 *   3 — reserved for U07 (encrypted secrets vault); may be unmerged
 *   4 — open_tabs (U25 session restore)
 *
 * U25 creates `open_tabs` defensively with CREATE TABLE IF NOT EXISTS so
 * the feature works whether or not U07's v3 migration has landed. We only
 * claim user_version=4 once the DB is already at >=3, so an unmerged U07
 * can still apply its v3 bump later.
 */
const CURRENT_SCHEMA_VERSION = 4;

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  const dbPath = join(app.getPath('userData'), 'plasma.db');
  mkdirSync(dirname(dbPath), { recursive: true });

  logger.info('[plasma] opening sqlite database at', dbPath);

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL'); // better concurrency + crash safety
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL'); // acceptable trade-off for our write volume
  db.pragma('busy_timeout = 5000');

  migrate(db);
  return db;
}

export function closeDb(): void {
  if (!db) return;
  try {
    db.close();
  } finally {
    db = null;
  }
}

function migrate(d: Database.Database): void {
  const currentVersion = (d.pragma('user_version', { simple: true }) as number) ?? 0;

  if (currentVersion < 1) {
    logger.info('[plasma] migrating to schema version 1');
    d.exec(`
      CREATE TABLE IF NOT EXISTS connections (
        id                    TEXT PRIMARY KEY,
        name                  TEXT NOT NULL,
        host                  TEXT NOT NULL,
        port                  INTEGER NOT NULL,
        database              TEXT NOT NULL,
        user                  TEXT NOT NULL,
        ssl                   INTEGER NOT NULL DEFAULT 0,
        password_ciphertext   BLOB NOT NULL,
        created_at            INTEGER NOT NULL,
        updated_at            INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS query_history (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        connection_id TEXT,
        sql           TEXT NOT NULL,
        row_count     INTEGER,
        duration_ms   INTEGER,
        error         TEXT,
        executed_at   INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_history_executed_at
        ON query_history (executed_at DESC);

      CREATE INDEX IF NOT EXISTS idx_history_connection
        ON query_history (connection_id, executed_at DESC);

      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    d.pragma('user_version = 1');
  }

  if (currentVersion < 2) {
    logger.info('[plasma] migrating to schema version 2 (engine column)');
    // SQLite doesn't support adding a column with a constraint other
    // than DEFAULT, so we set 'postgres' as the default — every existing
    // saved connection was a Postgres connection at v0.0.10.
    d.exec(`
      ALTER TABLE connections
        ADD COLUMN engine TEXT NOT NULL DEFAULT 'postgres';
    `);
    d.pragma('user_version = 2');
  }

  // U25 open_tabs — additive, safe whether U07 (v3) is present or not.
  ensureOpenTabsTable(d);

  const versionNow = (d.pragma('user_version', { simple: true }) as number) ?? 0;
  if (versionNow >= 3 && versionNow < 4) {
    logger.info('[plasma] migrating to schema version 4 (open_tabs)');
    d.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
  }

  // Future migrations go here, each bumping user_version.
}

/** Idempotent — also called from settings.ts before first open_tabs write. */
export function ensureOpenTabsTable(d: Database.Database = getDb()): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS open_tabs (
      connection_id TEXT NOT NULL,
      position      INTEGER NOT NULL,
      tab_id        TEXT NOT NULL,
      kind          TEXT NOT NULL,
      title         TEXT NOT NULL,
      sql           TEXT NOT NULL DEFAULT '',
      state_json    TEXT NOT NULL DEFAULT '{}',
      is_active     INTEGER NOT NULL DEFAULT 0,
      updated_at    INTEGER NOT NULL,
      PRIMARY KEY (connection_id, tab_id)
    );

    CREATE INDEX IF NOT EXISTS idx_open_tabs_connection
      ON open_tabs (connection_id, position);
  `);
}
