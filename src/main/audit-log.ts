import { createHash } from 'node:crypto';
import {
  type AuditEntry,
  AuditListOpts,
  type AuditSource,
  type AuditVerifyResult,
  DEFAULT_AUDIT_RETENTION_DAYS,
} from '@shared/audit';
import type Database from 'better-sqlite3';
import { redactErrorText, redactSqlSecrets } from './redact';

/**
 * Local audit log (wave D4). Statements run on Prod-tagged connections (or
 * on every connection, when the setting says so) are appended to the
 * `audit_log` table in plasma.db.
 *
 * Append-only: triggers refuse UPDATE, and refuse DELETE except while the
 * retention pass has raised the `pruning` flag. Each row carries
 * `hash = SHA-256(row fields + prev_hash)`, so editing or removing a row in
 * the middle breaks every hash after it; `verifyAudit` replays the chain.
 * (The file owner can still rewrite the whole chain — this is tamper
 * evidence, not tamper proof.)
 */

export const GENESIS_HASH = '0'.repeat(64);

export function ensureAuditTable(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      ts              INTEGER NOT NULL,
      connection_id   TEXT,
      connection_name TEXT NOT NULL,
      db_user         TEXT NOT NULL,
      statement       TEXT NOT NULL,
      outcome         TEXT NOT NULL,
      error           TEXT,
      affected_rows   INTEGER,
      duration_ms     INTEGER,
      source          TEXT NOT NULL,
      prev_hash       TEXT NOT NULL,
      hash            TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log (ts DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_connection ON audit_log (connection_id, ts DESC);
    CREATE TABLE IF NOT EXISTS audit_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT OR IGNORE INTO audit_meta (key, value) VALUES ('pruning', '0');
    CREATE TRIGGER IF NOT EXISTS audit_log_no_update
      BEFORE UPDATE ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
      BEFORE DELETE ON audit_log
      WHEN (SELECT value FROM audit_meta WHERE key = 'pruning') <> '1'
      BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  `);
}

type HashedFields = Pick<
  AuditEntry,
  | 'ts'
  | 'connectionId'
  | 'connectionName'
  | 'dbUser'
  | 'statement'
  | 'outcome'
  | 'error'
  | 'affectedRows'
  | 'durationMs'
  | 'source'
>;

/** SHA-256 over the canonical row fields plus the previous row's hash. */
export function computeAuditHash(f: HashedFields, prevHash: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        f.ts,
        f.connectionId,
        f.connectionName,
        f.dbUser,
        f.statement,
        f.outcome,
        f.error,
        f.affectedRows,
        f.durationMs,
        f.source,
        prevHash,
      ]),
    )
    .digest('hex');
}

export interface AuditInput {
  connectionId: string | null;
  connectionName: string;
  dbUser: string;
  statement: string;
  error?: string | null;
  affectedRows?: number | null;
  durationMs?: number | null;
  source: AuditSource;
  ts?: number;
}

interface Row {
  id: number;
  ts: number;
  connection_id: string | null;
  connection_name: string;
  db_user: string;
  statement: string;
  outcome: string;
  error: string | null;
  affected_rows: number | null;
  duration_ms: number | null;
  source: string;
  prev_hash: string;
  hash: string;
}

const fromRow = (r: Row): AuditEntry => ({
  id: r.id,
  ts: r.ts,
  connectionId: r.connection_id,
  connectionName: r.connection_name,
  dbUser: r.db_user,
  statement: r.statement,
  outcome: r.outcome === 'error' ? 'error' : 'ok',
  error: r.error,
  affectedRows: r.affected_rows,
  durationMs: r.duration_ms,
  source: r.source as AuditSource,
  prevHash: r.prev_hash,
  hash: r.hash,
});

/** Append one statement; returns the stored entry. */
export function appendAudit(d: Database.Database, input: AuditInput): AuditEntry {
  const tx = d.transaction((): AuditEntry => {
    const last = d
      .prepare<[], { hash: string }>('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1')
      .get();
    const prevHash = last?.hash ?? GENESIS_HASH;
    const fields: HashedFields = {
      ts: input.ts ?? Date.now(),
      connectionId: input.connectionId,
      connectionName: input.connectionName,
      dbUser: input.dbUser,
      statement: redactSqlSecrets(input.statement),
      outcome: input.error ? 'error' : 'ok',
      error: input.error ? redactErrorText(input.error) : null,
      affectedRows: input.affectedRows ?? null,
      durationMs: input.durationMs ?? null,
      source: input.source,
    };
    const hash = computeAuditHash(fields, prevHash);
    const res = d
      .prepare(
        `INSERT INTO audit_log
           (ts, connection_id, connection_name, db_user, statement, outcome, error,
            affected_rows, duration_ms, source, prev_hash, hash)
         VALUES (@ts, @connectionId, @connectionName, @dbUser, @statement, @outcome, @error,
                 @affectedRows, @durationMs, @source, @prevHash, @hash)`,
      )
      .run({ ...fields, prevHash, hash });
    return { id: Number(res.lastInsertRowid), ...fields, prevHash, hash };
  });
  return tx();
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function whereOf(opts: Omit<AuditListOpts, 'limit' | 'offset'>): {
  where: string;
  params: Record<string, unknown>;
} {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.connectionId) {
    clauses.push('connection_id = @connectionId');
    params.connectionId = opts.connectionId;
  }
  if (opts.from !== undefined) {
    clauses.push('ts >= @from');
    params.from = opts.from;
  }
  if (opts.to !== undefined) {
    clauses.push('ts <= @to');
    params.to = opts.to;
  }
  if (opts.outcome) {
    clauses.push('outcome = @outcome');
    params.outcome = opts.outcome;
  }
  const text = opts.text?.trim();
  if (text) {
    clauses.push(
      "(statement LIKE @text ESCAPE '\\' OR connection_name LIKE @text ESCAPE '\\' OR db_user LIKE @text ESCAPE '\\' OR IFNULL(error, '') LIKE @text ESCAPE '\\')",
    );
    params.text = `%${escapeLike(text)}%`;
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/** Newest first. */
export function listAudit(d: Database.Database, raw: AuditListOpts = {}): AuditEntry[] {
  const opts = AuditListOpts.parse(raw);
  const { where, params } = whereOf(opts);
  return d
    .prepare<Record<string, unknown>, Row>(
      `SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit: opts.limit, offset: opts.offset })
    .map(fromRow);
}

/** Every row matching the filter, oldest first (for export). */
export function listAuditForExport(
  d: Database.Database,
  filter: Omit<AuditListOpts, 'limit' | 'offset'> = {},
): AuditEntry[] {
  const { where, params } = whereOf(filter);
  return d
    .prepare<Record<string, unknown>, Row>(`SELECT * FROM audit_log ${where} ORDER BY id ASC`)
    .all(params)
    .map(fromRow);
}

/**
 * Replay the chain. The first surviving row anchors on its own `prev_hash`
 * (older rows may have been pruned by retention); every later row must link
 * to its predecessor and hash to its stored value.
 */
export function verifyAudit(d: Database.Database): AuditVerifyResult {
  let checked = 0;
  let prev: { id: number; hash: string } | null = null;
  const stmt = d.prepare<[], Row>('SELECT * FROM audit_log ORDER BY id ASC');
  for (const r of stmt.iterate()) {
    const e = fromRow(r);
    if (prev && e.prevHash !== prev.hash) {
      return {
        ok: false,
        checked,
        badId: e.id,
        reason: `Row ${e.id} does not link to row ${prev.id}: a row before it was changed or removed.`,
      };
    }
    if (computeAuditHash(e, e.prevHash) !== e.hash) {
      return {
        ok: false,
        checked,
        badId: e.id,
        reason: `Row ${e.id} was modified after it was written.`,
      };
    }
    prev = { id: e.id, hash: e.hash };
    checked++;
  }
  return { ok: true, checked, badId: null, reason: null };
}

/** Delete rows older than the retention window; returns how many went. */
export function pruneAudit(
  d: Database.Database,
  retentionDays: number = DEFAULT_AUDIT_RETENTION_DAYS,
  now: number = Date.now(),
): number {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
  const cutoff = now - retentionDays * 86_400_000;
  const tx = d.transaction((): number => {
    d.prepare("UPDATE audit_meta SET value = '1' WHERE key = 'pruning'").run();
    try {
      // Always a prefix of the chain: removing rows from the middle would break it.
      return d
        .prepare('DELETE FROM audit_log WHERE id <= (SELECT MAX(id) FROM audit_log WHERE ts < ?)')
        .run(cutoff).changes;
    } finally {
      d.prepare("UPDATE audit_meta SET value = '0' WHERE key = 'pruning'").run();
    }
  });
  return tx();
}
