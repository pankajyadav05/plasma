import type { ConnectionConfig, ConnectionEngine, SavedConnection } from '@shared/protocol';
import { safeStorage } from 'electron';
import { getDb } from './db';
import { logger } from './logger';

/**
 * Connection vault — backed by SQLite.
 *
 * - Passwords encrypted via Electron `safeStorage` (OS keychain)
 * - Stored as BLOB in the `connections` table
 * - Plaintext passwords never touch disk or the renderer after the
 *   initial form submission
 * - `created_at` / `updated_at` timestamps for sorting + future audit
 * - `engine` column drives which driver runs in the worker (added v2).
 */

function assertEncryptionAvailable(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'OS-level encryption is not available. Plasma cannot save connections ' +
        'without a working keychain (macOS Keychain, Windows Credential Vault, or libsecret).',
    );
  }
}

function encryptPassword(plaintext: string): Buffer {
  assertEncryptionAvailable();
  return safeStorage.encryptString(plaintext);
}

function decryptPassword(ciphertext: Buffer): string {
  assertEncryptionAvailable();
  return safeStorage.decryptString(ciphertext);
}

// ─── Row shape in SQLite (what we read/write) ───────────────────────

interface ConnectionRow {
  id: string;
  name: string;
  engine: string;
  host: string;
  port: number;
  database: string;
  user: string;
  ssl: number; // sqlite boolean
  password_ciphertext: Buffer;
  created_at: number;
  updated_at: number;
}

function asEngine(raw: string | null | undefined): ConnectionEngine {
  if (raw === 'redis' || raw === 'opensearch') return raw;
  return 'postgres';
}

// ─── Public API ──────────────────────────────────────────────────────

export function listConnections(): SavedConnection[] {
  const rows = getDb()
    .prepare<[], ConnectionRow>('SELECT * FROM connections ORDER BY updated_at DESC')
    .all();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    engine: asEngine(r.engine),
    host: r.host,
    port: r.port,
    database: r.database,
    user: r.user,
    ssl: Boolean(r.ssl),
  }));
}

export function saveConnection(config: ConnectionConfig): void {
  const ciphertext = encryptPassword(config.password);
  const now = Date.now();
  const engine = config.engine ?? 'postgres';

  const existing = getDb()
    .prepare<[string], { id: string; created_at: number }>(
      'SELECT id, created_at FROM connections WHERE id = ?',
    )
    .get(config.id);

  if (existing) {
    getDb()
      .prepare(
        `UPDATE connections
            SET name = @name, engine = @engine, host = @host, port = @port, database = @database,
                user = @user, ssl = @ssl, password_ciphertext = @password_ciphertext,
                updated_at = @updated_at
          WHERE id = @id`,
      )
      .run({
        id: config.id,
        name: config.name,
        engine,
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.user,
        ssl: config.ssl ? 1 : 0,
        password_ciphertext: ciphertext,
        updated_at: now,
      });
  } else {
    getDb()
      .prepare(
        `INSERT INTO connections
           (id, name, engine, host, port, database, user, ssl, password_ciphertext, created_at, updated_at)
           VALUES
           (@id, @name, @engine, @host, @port, @database, @user, @ssl, @password_ciphertext, @created_at, @updated_at)`,
      )
      .run({
        id: config.id,
        name: config.name,
        engine,
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.user,
        ssl: config.ssl ? 1 : 0,
        password_ciphertext: ciphertext,
        created_at: now,
        updated_at: now,
      });
  }
  logger.info('[plasma] vault: saved connection', config.id, engine);
}

export function deleteConnection(id: string): void {
  const info = getDb().prepare('DELETE FROM connections WHERE id = ?').run(id);
  logger.info('[plasma] vault: deleted connection', id, 'changes=', info.changes);
}

/**
 * Read a full connection including decrypted password. Used only by
 * the `vault.connectById` IPC handler — the plaintext password is
 * immediately forwarded to the worker and never returned to the renderer.
 */
export function getFullConnection(id: string): ConnectionConfig | null {
  const row = getDb()
    .prepare<[string], ConnectionRow>('SELECT * FROM connections WHERE id = ?')
    .get(id);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    engine: asEngine(row.engine),
    host: row.host,
    port: row.port,
    database: row.database,
    user: row.user,
    ssl: Boolean(row.ssl),
    password: decryptPassword(row.password_ciphertext),
  };
}
