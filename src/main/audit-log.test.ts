import { formatAuditExport } from '@shared/audit';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AuditInput,
  GENESIS_HASH,
  appendAudit,
  ensureAuditTable,
  listAudit,
  listAuditForExport,
  pruneAudit,
  verifyAudit,
} from './audit-log';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  ensureAuditTable(db);
});

const input = (over: Partial<AuditInput> = {}): AuditInput => ({
  connectionId: 'c1',
  connectionName: 'Prod DB',
  dbUser: 'app',
  statement: 'UPDATE t SET a = 1',
  source: 'editor',
  affectedRows: 1,
  durationMs: 5,
  ts: 1_000,
  ...over,
});

describe('audit log', () => {
  it('appends rows, redacts secrets and chains hashes', () => {
    const a = appendAudit(db, input({ statement: "CREATE ROLE x PASSWORD 'hunter2'" }));
    const b = appendAudit(db, input({ ts: 2_000, error: 'relation "t" does not exist' }));
    expect(a.prevHash).toBe(GENESIS_HASH);
    expect(b.prevHash).toBe(a.hash);
    expect(a.statement).not.toContain('hunter2');
    expect(a.outcome).toBe('ok');
    expect(b.outcome).toBe('error');
    expect(verifyAudit(db)).toEqual({ ok: true, checked: 2, badId: null, reason: null });
  });

  it('verifies an empty log', () => {
    expect(verifyAudit(db).ok).toBe(true);
  });

  it('refuses UPDATE and DELETE outright', () => {
    appendAudit(db, input());
    expect(() => db.prepare("UPDATE audit_log SET statement = 'x'").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM audit_log').run()).toThrow(/append-only/);
  });

  it('detects a tampered row when the guard triggers are bypassed', () => {
    for (let i = 0; i < 4; i++) appendAudit(db, input({ ts: 1_000 + i, statement: `SELECT ${i}` }));
    db.exec('DROP TRIGGER audit_log_no_update');
    db.prepare("UPDATE audit_log SET statement = 'SELECT 999' WHERE id = 2").run();
    const res = verifyAudit(db);
    expect(res.ok).toBe(false);
    expect(res.badId).toBe(2);
    expect(res.checked).toBe(1);
  });

  it('detects a removed row in the middle of the chain', () => {
    for (let i = 0; i < 4; i++) appendAudit(db, input({ ts: 1_000 + i }));
    db.exec('DROP TRIGGER audit_log_no_delete');
    db.prepare('DELETE FROM audit_log WHERE id = 2').run();
    const res = verifyAudit(db);
    expect(res.ok).toBe(false);
    expect(res.badId).toBe(3);
  });

  it('detects a rewritten hash that no longer matches its fields', () => {
    appendAudit(db, input());
    db.exec('DROP TRIGGER audit_log_no_update');
    db.prepare("UPDATE audit_log SET hash = ?, outcome = 'error'").run('f'.repeat(64));
    expect(verifyAudit(db).ok).toBe(false);
  });

  it('prunes by retention from the front only and the chain still verifies', () => {
    const day = 86_400_000;
    const now = 200 * day;
    appendAudit(db, input({ ts: now - 120 * day }));
    appendAudit(db, input({ ts: now - 100 * day }));
    appendAudit(db, input({ ts: now - 10 * day }));
    appendAudit(db, input({ ts: now - 1 * day }));
    expect(pruneAudit(db, 90, now)).toBe(2);
    const left = listAudit(db);
    expect(left.map((e) => e.id)).toEqual([4, 3]);
    expect(verifyAudit(db)).toMatchObject({ ok: true, checked: 2 });
    // New rows keep chaining onto the survivors.
    appendAudit(db, input({ ts: now }));
    expect(verifyAudit(db)).toMatchObject({ ok: true, checked: 3 });
    // The guard is back on afterwards.
    expect(() => db.prepare('DELETE FROM audit_log').run()).toThrow(/append-only/);
  });

  it('never prunes with retention 0 or less', () => {
    appendAudit(db, input({ ts: 1 }));
    expect(pruneAudit(db, 0, 10 ** 12)).toBe(0);
    expect(listAudit(db)).toHaveLength(1);
  });

  it('filters by connection, date range, outcome and text', () => {
    appendAudit(db, input({ ts: 1_000, statement: 'DELETE FROM users' }));
    appendAudit(
      db,
      input({ ts: 2_000, connectionId: 'c2', connectionName: 'Other', statement: 'SELECT 100%' }),
    );
    appendAudit(db, input({ ts: 3_000, error: 'boom', statement: 'DROP TABLE x' }));
    expect(listAudit(db, { connectionId: 'c2' }).map((e) => e.id)).toEqual([2]);
    expect(listAudit(db, { from: 1_500, to: 2_500 }).map((e) => e.id)).toEqual([2]);
    expect(listAudit(db, { outcome: 'error' }).map((e) => e.id)).toEqual([3]);
    expect(listAudit(db, { text: 'users' }).map((e) => e.id)).toEqual([1]);
    expect(listAudit(db, { text: '100%' }).map((e) => e.id)).toEqual([2]);
    expect(listAudit(db, { text: '%' }).map((e) => e.id)).toEqual([2]);
    expect(listAudit(db, { limit: 1, offset: 1 }).map((e) => e.id)).toEqual([2]);
  });

  it('exports CSV (formula-guarded) and JSON', () => {
    appendAudit(db, input({ statement: '=cmd|calc, "x"' }));
    const rows = listAuditForExport(db);
    const csv = formatAuditExport(rows, 'csv');
    const [header, line] = csv.split('\n');
    expect(header).toContain('statement');
    expect(line).toContain(`"'=cmd|calc, ""x"""`);
    expect(JSON.parse(formatAuditExport(rows, 'json'))[0].connectionName).toBe('Prod DB');
  });
});
