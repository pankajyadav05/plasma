import { describe, expect, it } from 'vitest';
import {
  PG_MAINTENANCE_CHECKS,
  XID_LIMIT,
  interpretAutovacuum,
  interpretIndexBloat,
  interpretTableBloat,
  interpretVacuum,
  interpretWraparound,
} from './pg-maintenance';

const MB = 1024 * 1024;

describe('bloat estimates', () => {
  it('flags large, proportionally bloated tables and labels them as estimates', () => {
    const r = interpretTableBloat([
      {
        schema_name: 'public',
        table_name: 'big',
        real_size: 400 * MB,
        bloat_size: 300 * MB,
        bloat_pct: 75,
      },
      {
        schema_name: 'public',
        table_name: 'tiny',
        real_size: 2 * MB,
        bloat_size: 1 * MB,
        bloat_pct: 50,
      },
      {
        schema_name: 'public',
        table_name: 'fine',
        real_size: 500 * MB,
        bloat_size: 20 * MB,
        bloat_pct: 4,
      },
    ]);
    expect(r.findings.map((f) => f.id)).toEqual(['tbloat:public.big']);
    expect(r.findings[0]?.status).toBe('crit');
    expect(r.findings[0]?.title).toContain('estimate');
    expect(r.note).toContain('Estimate');
    expect(r.table?.rows).toHaveLength(3);
  });

  it('proposes REINDEX CONCURRENTLY for bloated indexes', () => {
    const r = interpretIndexBloat([
      {
        schema_name: 'public',
        index_name: 'big_idx',
        table_name: 'big',
        real_size: 200 * MB,
        bloat_size: 90 * MB,
        bloat_pct: 45,
      },
    ]);
    expect(r.findings[0]?.action?.sql).toBe('REINDEX INDEX CONCURRENTLY "public"."big_idx";');
    expect(r.status).toBe('warn');
  });
});

describe('vacuum and dead tuples', () => {
  const base = {
    schema_name: 'public',
    table_name: 't',
    n_live_tup: 5000,
    n_dead_tup: 0,
    n_mod_since_analyze: 0,
    vacuum_age_s: 60,
    analyze_age_s: 60,
    autovacuum_off: false,
  };

  it('is ok for a clean table', () => {
    expect(interpretVacuum([base]).status).toBe('ok');
  });

  it('flags dead-tuple-heavy tables with a VACUUM preview', () => {
    const r = interpretVacuum([{ ...base, n_live_tup: 5000, n_dead_tup: 15000 }]);
    expect(r.status).toBe('crit');
    expect(r.findings[0]?.id).toBe('dead:public.t');
    expect(r.findings[0]?.action?.sql).toBe('VACUUM (ANALYZE, VERBOSE) "public"."t";');
  });

  it('warns below the critical ratio and ignores small absolute counts', () => {
    expect(interpretVacuum([{ ...base, n_live_tup: 9000, n_dead_tup: 1500 }]).status).toBe('warn');
    expect(interpretVacuum([{ ...base, n_live_tup: 10, n_dead_tup: 9 }]).status).toBe('ok');
  });

  it('reports a table with autovacuum disabled and stale statistics', () => {
    const r = interpretVacuum([
      { ...base, autovacuum_off: true, n_dead_tup: 5 },
      {
        ...base,
        table_name: 'stale',
        n_live_tup: 10000,
        n_mod_since_analyze: 6000,
        analyze_age_s: 30 * 86400,
      },
    ]);
    expect(r.findings.map((f) => f.id)).toEqual(['avoff:public.t', 'analyze:public.stale']);
    expect(r.findings[0]?.action?.sql).toContain('RESET (autovacuum_enabled)');
  });
});

describe('wraparound and autovacuum', () => {
  it('shows the distance to wraparound and stays ok when young', () => {
    const r = interpretWraparound([
      { datname: 'db', xid_age: 1_000_000, mxid_age: 5, freeze_max_age: 200_000_000 },
    ]);
    expect(r.status).toBe('ok');
    expect(r.summary).toContain((XID_LIMIT - 1_000_000).toLocaleString('en-US'));
  });

  it('goes critical past 75% of the xid space', () => {
    const r = interpretWraparound([
      { datname: 'db', xid_age: 1_800_000_000, mxid_age: 5, freeze_max_age: 200_000_000 },
    ]);
    expect(r.status).toBe('crit');
  });

  it('warns when autovacuum is far behind its freeze age', () => {
    const r = interpretWraparound([
      { datname: 'db', xid_age: 400_000_000, mxid_age: 5, freeze_max_age: 200_000_000 },
    ]);
    expect(r.status).toBe('warn');
  });

  it('judges autovacuum status', () => {
    expect(
      interpretAutovacuum([{ enabled: 'on', track_counts: 'on', running: 1, max_workers: 3 }])
        .status,
    ).toBe('ok');
    expect(
      interpretAutovacuum([{ enabled: 'off', track_counts: 'on', running: 0, max_workers: 3 }])
        .status,
    ).toBe('crit');
    expect(
      interpretAutovacuum([{ enabled: 'on', track_counts: 'on', running: 3, max_workers: 3 }])
        .status,
    ).toBe('warn');
    expect(interpretAutovacuum([]).status).toBe('unknown');
  });

  it('registers read-only checks', () => {
    for (const c of PG_MAINTENANCE_CHECKS) expect(c.sql).toMatch(/^\s*(WITH|SELECT)/);
  });
});
