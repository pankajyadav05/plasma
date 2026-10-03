import { describe, expect, it } from 'vitest';
import { parseLockContext } from './pg-lock-preview';
import {
  checkMigration,
  lintOptionsFromContext,
  lintOptionsFromSettings,
} from './pg-migration-check';

const ctxFor = (rows: Record<string, unknown>[]) => parseLockContext(rows);

describe('settings -> lint options', () => {
  it('defaults to enabled / info / nothing muted', () => {
    expect(lintOptionsFromSettings(undefined)).toEqual({
      enabled: true,
      minSeverity: 'info',
      muted: [],
    });
    expect(lintOptionsFromSettings({ migrationLintEnabled: false }).enabled).toBe(false);
  });
});

describe('checkMigration with live context', () => {
  const rows = [
    {
      name: 'public.orders',
      resolved: 'orders',
      est_rows: 5_000_000,
      session_count: 0,
      columns: [
        { name: 'note', type: 'character varying(20)' },
        { name: 'qty', type: 'integer' },
      ],
      indexes: [['id'], ['customer_id', 'created_at']],
    },
    { name: 'tiny', resolved: 'tiny', est_rows: 12, session_count: 0, columns: [], indexes: [] },
  ];
  const ctx = ctxFor(rows);
  const base = lintOptionsFromSettings(undefined);

  it('uses column types to accept a varchar widen and reject int -> bigint', () => {
    const ok = checkMigration(
      'ALTER TABLE public.orders ALTER COLUMN note TYPE varchar(100)',
      base,
      ctx,
    );
    expect(ok.findings.map((f) => f.ruleId)).not.toContain('change-column-type');
    const bad = checkMigration('ALTER TABLE public.orders ALTER COLUMN qty TYPE bigint', base, ctx);
    expect(bad.findings.map((f) => f.ruleId)).toContain('change-column-type');
    expect(bad.worst).toBe('error');
  });
  it('skips size-sensitive rules on a tiny table', () => {
    const r = checkMigration('CREATE INDEX i ON tiny (a)', base, ctxFor(rows));
    expect(r.findings.map((f) => f.ruleId)).not.toContain('create-index-non-concurrent');
  });
  it('detects a missing FK index from live indexes', () => {
    const fk = (col: string) =>
      `ALTER TABLE public.orders ADD FOREIGN KEY (${col}) REFERENCES c (id) NOT VALID`;
    const has = (sql: string) =>
      checkMigration(sql, base, ctx).findings.find((f) => f.ruleId === 'fk-missing-index');
    expect(has(fk('customer_id'))).toBeUndefined();
    expect(has(fk('qty'))?.severity).toBe('warn');
  });
  it('returns locks and target names for the live fetch', () => {
    const r = checkMigration('ALTER TABLE public.orders DROP COLUMN x', base);
    expect(r.names).toEqual(['public.orders']);
    expect(r.locks[0]?.mode).toBe('ACCESS EXCLUSIVE');
  });
  it('passes the server major version to the linter', () => {
    const r = checkMigration(
      "ALTER TABLE t ADD COLUMN s text DEFAULT 'x'",
      base,
      undefined,
      'PostgreSQL 10.5',
    );
    expect(r.findings.map((f) => f.ruleId)).toContain('add-column-volatile-default');
    const r2 = checkMigration(
      "ALTER TABLE t ADD COLUMN s text DEFAULT 'x'",
      base,
      undefined,
      'PostgreSQL 16.2',
    );
    expect(r2.findings.map((f) => f.ruleId)).not.toContain('add-column-volatile-default');
  });
  it('is a no-op for options without context', () => {
    expect(lintOptionsFromContext([], undefined, base)).toBe(base);
  });
});

describe('settings shape', () => {
  it('defaults and repairs the migration-lint settings', async () => {
    const { SettingsShape } = await import('./protocol');
    const d = SettingsShape.parse({});
    expect(d.migrationLintEnabled).toBe(true);
    expect(d.migrationLintMinSeverity).toBe('info');
    expect(d.migrationLintMuted).toEqual([]);
    const bad = SettingsShape.parse({ migrationLintMinSeverity: 'loud', migrationLintMuted: 3 });
    expect(bad.migrationLintMinSeverity).toBe('info');
    expect(bad.migrationLintMuted).toEqual([]);
  });
});
