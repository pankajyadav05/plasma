import type { ConnectionConfig, ConnectionEngine, SavedConnection, Settings } from '@shared/protocol';
import type Database from 'better-sqlite3';
import { safeStorage } from 'electron';
import { getDb } from './db';
import { logger } from './logger';
import {
  planSecretsMigration,
  redactSettingsWithPresence,
} from './vault-secrets-plan';

export { planSecretsMigration, redactSettingsWithPresence } from './vault-secrets-plan';

/**
 * Connection + secrets vault — backed by SQLite + Electron `safeStorage`.
 *
 * - DB passwords: `connections.password_ciphertext` (schema v1+)
 * - SSH secrets + API keys: `secrets` table (schema v3+), never returned
 *   by SettingsGet / public settings responses
 * - Plaintext never touches disk after migrate/write; migration checkpoints
 *   WAL and vacuums so freelist/WAL copies of old plaintext are purged
 */

function assertEncryptionAvailable(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'OS-level encryption is not available. Plasma cannot save connections ' +
        'without a working keychain (macOS Keychain, Windows Credential Vault, or libsecret).',
    );
  }
}

function encryptString(plaintext: string): Buffer {
  assertEncryptionAvailable();
  return safeStorage.encryptString(plaintext);
}

function decryptString(ciphertext: Buffer): string {
  assertEncryptionAvailable();
  return safeStorage.decryptString(ciphertext);
}

// ─── Connection row shape ────────────────────────────────────────────

interface ConnectionRow {
  id: string;
  name: string;
  engine: string;
  host: string;
  port: number;
  database: string;
  user: string;
  ssl: number;
  password_ciphertext: Buffer;
  created_at: number;
  updated_at: number;
}

function asEngine(raw: string | null | undefined): ConnectionEngine {
  if (raw === 'redis' || raw === 'opensearch') return raw;
  return 'postgres';
}

// ─── Secrets table (schema v3) ───────────────────────────────────────

export type SecretKey =
  | 'setting:openrouterApiKey'
  | 'setting:claudeApiKey'
  | `ssh:${string}:password`
  | `ssh:${string}:privateKey`
  | `ssh:${string}:passphrase`
  | string;

interface SecretRow {
  key: string;
  ciphertext: Buffer;
  updated_at: number;
}

export function ensureSecretsTable(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS secrets (
      key         TEXT PRIMARY KEY,
      ciphertext  BLOB NOT NULL,
      updated_at  INTEGER NOT NULL
    );
  `);
}

export function putSecret(key: SecretKey, plaintext: string, d: Database.Database = getDb()): void {
  if (!plaintext) {
    d.prepare('DELETE FROM secrets WHERE key = ?').run(key);
    return;
  }
  const ciphertext = encryptString(plaintext);
  d.prepare(
    `INSERT INTO secrets (key, ciphertext, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`,
  ).run(key, ciphertext, Date.now());
}

export function getSecret(key: SecretKey, d: Database.Database = getDb()): string | null {
  const row = d.prepare<[string], SecretRow>('SELECT key, ciphertext, updated_at FROM secrets WHERE key = ?').get(key);
  if (!row) return null;
  try {
    return decryptString(row.ciphertext);
  } catch (err) {
    logger.error('[plasma] vault: failed to decrypt secret', key, err);
    return null;
  }
}

export function hasSecret(key: SecretKey, d: Database.Database = getDb()): boolean {
  const row = d.prepare<[string], { key: string }>('SELECT key FROM secrets WHERE key = ?').get(key);
  return Boolean(row);
}

export function deleteSecret(key: SecretKey, d: Database.Database = getDb()): void {
  d.prepare('DELETE FROM secrets WHERE key = ?').run(key);
}

export function deleteSshSecrets(connectionId: string, d: Database.Database = getDb()): void {
  d.prepare("DELETE FROM secrets WHERE key LIKE ?").run(`ssh:${connectionId}:%`);
}

export function getApiKey(d: Database.Database = getDb()): string {
  return getSecret('setting:openrouterApiKey', d) || getSecret('setting:claudeApiKey', d) || '';
}

export type SshTunnelConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  privateKey: string;
  passphrase: string;
};

/**
 * Merge public SSH metadata from settings with decrypted vault secrets.
 * Returns null when the connection has no SSH entry.
 */
export function getFullSshConfig(
  connectionId: string,
  connectionSsh: Settings['connectionSsh'] | undefined,
  d: Database.Database = getDb(),
): SshTunnelConfig | null {
  const meta = connectionSsh?.[connectionId];
  if (!meta) return null;
  return {
    host: meta.host,
    port: meta.port,
    user: meta.user,
    password: getSecret(`ssh:${connectionId}:password`, d) ?? '',
    privateKey: getSecret(`ssh:${connectionId}:privateKey`, d) ?? '',
    passphrase: getSecret(`ssh:${connectionId}:passphrase`, d) ?? '',
  };
}

/**
 * Persist SSH secrets for a connection. Empty secret fields keep any
 * previously stored value (so the dialog can leave blanks = "unchanged").
 * Pass `clearMissing: true` to delete secrets omitted/empty (unused today).
 */
export function setSshSecrets(
  connectionId: string,
  secrets: { password?: string; privateKey?: string; passphrase?: string },
  d: Database.Database = getDb(),
): void {
  if (secrets.password) putSecret(`ssh:${connectionId}:password`, secrets.password, d);
  if (secrets.privateKey) putSecret(`ssh:${connectionId}:privateKey`, secrets.privateKey, d);
  if (secrets.passphrase) putSecret(`ssh:${connectionId}:passphrase`, secrets.passphrase, d);
}

/**
 * Strip secret material from a Settings object for renderer/IPC responses.
 * Presence flags tell the UI a value is stored without exposing it.
 */
export function redactSettingsForRenderer(settings: Settings, d: Database.Database = getDb()): Settings {
  return redactSettingsWithPresence(settings, (key) => hasSecret(key, d));
}

/**
 * Schema v3 migration: move plaintext API keys + SSH secrets from the
 * settings JSON blob into the encrypted `secrets` table, rewrite settings
 * rows without secrets, then caller checkpoints WAL + vacuums.
 */
export function migratePlaintextSettingsSecrets(d: Database.Database): void {
  ensureSecretsTable(d);

  const rows = d
    .prepare<[], { key: string; value: string }>('SELECT key, value FROM settings')
    .all();
  const raw: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      raw[row.key] = JSON.parse(row.value);
    } catch {
      raw[row.key] = row.value;
    }
  }

  const planned = planSecretsMigration(raw);
  for (const [key, plaintext] of Object.entries(planned.secrets)) {
    putSecret(key, plaintext, d);
    logger.info('[plasma] vault: migrated plaintext secret', key);
  }

  const upsert = d.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  for (const key of ['openrouterApiKey', 'claudeApiKey', 'connectionSsh'] as const) {
    if (key in planned.settings) {
      upsert.run(key, JSON.stringify(planned.settings[key]));
    }
  }
}

// ─── Public connection vault API ─────────────────────────────────────

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
  const ciphertext = encryptString(config.password);
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
  deleteSshSecrets(id);
  logger.info('[plasma] vault: deleted connection', id, 'changes=', info.changes);
}

/**
 * Read a full connection including decrypted password. Used only by
 * the `vault.connectById` IPC handler — the plaintext password is
 * immediately forwarded to the worker and never returned to the renderer
 * from SettingsGet. (VaultGetConfig still returns it for the edit form.)
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
    password: decryptString(row.password_ciphertext),
  };
}
