import { describe, expect, it } from 'vitest';
import {
  FK_NO_INDEX_SQL,
  PG_INDEX_CHECKS,
  dropIndexSql,
  findRedundantIndexes,
  interpretFkWithoutIndex,
  interpretInvalidIndexes,
  interpretSeqScans,
  interpretUnusedIndexes,
} from './pg-indexes';

const idx = (over: Record<string, unknown>) => ({
  schema_name: 'public',
  table_name: 't',
  index_name: 'i',
  method: 'btree',
  keys: '1',
  opclasses: '1978',
  collations: '0',
  options: '0',
  predicate: '',
  expressions: '',
  is_unique: false,
  is_primary: false,
  backs_constraint: false,
  size_bytes: 1000,
  indexdef: 'CREATE INDEX ...',
  ...over,
});

describe('unused indexes', () => {
  it('turns each row into a finding with a DROP INDEX CONCURRENTLY preview', () => {
    const r = interpretUnusedIndexes([
      {
        schema_name: 'public',
        table_name: 'orders',
        index_name: 'orders_old_idx',
        idx_scan: 0,
        size_bytes: 50 * 1024 * 1024,
        indexdef: 'CREATE INDEX ...',
        stats_reset: '2026-01-01',
      },
    ]);
    expect(r.status).toBe('warn');
    expect(r.findings[0]?.action?.sql).toBe(
      'DROP INDEX CONCURRENTLY IF EXISTS "public"."orders_old_idx";',
    );
    expect(r.findings[0]?.action?.destructive).toBe(true);
    expect(r.note).toContain('2026-01-01');
  });

  it('is ok when nothing is unused and ignores tiny indexes for severity', () => {
    expect(interpretUnusedIndexes([]).status).toBe('ok');
    expect(
      interpretUnusedIndexes([
        { schema_name: 's', table_name: 't', index_name: 'i', size_bytes: 8192 },
      ]).status,
    ).toBe('ok');
  });

  it('escapes identifiers in the drop', () => {
    expect(dropIndexSql('My"S', 'i x')).toBe('DROP INDEX CONCURRENTLY IF EXISTS "My""S"."i x";');
  });
});

describe('duplicate and overlapping indexes', () => {
  it('reports exact duplicates once, keeping the first', () => {
    const f = findRedundantIndexes([idx({ index_name: 'a_idx' }), idx({ index_name: 'a_idx2' })]);
    expect(f).toHaveLength(1);
    expect(f[0]?.id).toBe('dup:public.a_idx2');
  });

  it('keeps a constraint-backed index over its twin', () => {
    const f = findRedundantIndexes([
      idx({ index_name: 'a_aaa', backs_constraint: true, is_unique: true }),
      idx({ index_name: 'a_zzz' }),
    ]);
    expect(f.map((x) => x.id)).toEqual(['dup:public.a_zzz']);
  });

  it('never suggests dropping two protected twins', () => {
    expect(
      findRedundantIndexes([
        idx({ index_name: 'p1', is_primary: true, is_unique: true }),
        idx({ index_name: 'u1', is_unique: true }),
      ]),
    ).toEqual([]);
  });

  it('flags a leading-prefix index as overlapping', () => {
    const f = findRedundantIndexes([
      idx({ index_name: 'a_idx', keys: '1', opclasses: '1978', collations: '0', options: '0' }),
      idx({
        index_name: 'ab_idx',
        keys: '1 2',
        opclasses: '1978 1978',
        collations: '0 0',
        options: '0 0',
      }),
    ]);
    expect(f.map((x) => x.id)).toEqual(['overlap:public.a_idx']);
  });

  it('does not flag different predicates, methods, tables or non-prefix columns', () => {
    expect(
      findRedundantIndexes([
        idx({ index_name: 'a', predicate: '(x > 1)' }),
        idx({ index_name: 'b', predicate: '' }),
        idx({ index_name: 'c', method: 'hash' }),
        idx({ index_name: 'd', table_name: 'other' }),
        idx({ index_name: 'e', keys: '2', opclasses: '1978' }),
      ]),
    ).toEqual([]);
  });

  it('does not drop a unique index that is a prefix of a wider one', () => {
    expect(
      findRedundantIndexes([
        idx({ index_name: 'a_uq', is_unique: true }),
        idx({
          index_name: 'ab',
          keys: '1 2',
          opclasses: '1978 1978',
          collations: '0 0',
          options: '0 0',
        }),
      ]),
    ).toEqual([]);
  });
});

describe('invalid indexes, seq scans and foreign keys', () => {
  it('marks invalid indexes critical', () => {
    const r = interpretInvalidIndexes([
      { schema_name: 'public', table_name: 't', index_name: 'broken', size_bytes: 0, indexdef: '' },
    ]);
    expect(r.status).toBe('crit');
    expect(r.findings[0]?.action?.sql).toContain('"broken"');
  });

  it('flags tables mostly read by seq scan and ignores index-dominated ones', () => {
    const r = interpretSeqScans([
      {
        schema_name: 'public',
        table_name: 'events',
        seq_scan: 500,
        seq_tup_read: 50_000_000,
        idx_scan: 3,
        n_live_tup: 100000,
        size_bytes: 1,
      },
      {
        schema_name: 'public',
        table_name: 'ok',
        seq_scan: 500,
        seq_tup_read: 50_000_000,
        idx_scan: 9000,
        n_live_tup: 100000,
        size_bytes: 1,
      },
      {
        schema_name: 'public',
        table_name: 'cold',
        seq_scan: 2,
        seq_tup_read: 200000,
        idx_scan: 0,
        n_live_tup: 100000,
        size_bytes: 1,
      },
    ]);
    expect(r.findings.map((f) => f.id)).toEqual(['seq:public.events']);
    expect(r.status).toBe('warn');
  });

  it('proposes CREATE INDEX CONCURRENTLY for an unindexed foreign key', () => {
    const r = interpretFkWithoutIndex([
      {
        schema_name: 'public',
        table_name: 'orders',
        constraint_name: 'orders_user_fk',
        columns: 'user_id',
        size_bytes: 100 * 1024 * 1024,
      },
    ]);
    expect(r.status).toBe('warn');
    expect(r.findings[0]?.action?.sql).toBe(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "orders_user_id_idx" ON "public"."orders" (user_id);',
    );
  });

  it('keeps every index check read-only and registered', () => {
    expect(PG_INDEX_CHECKS.map((c) => c.id)).toEqual([
      'idx-unused',
      'idx-duplicate',
      'idx-invalid',
      'idx-seqscan',
      'idx-fk',
    ]);
    for (const c of PG_INDEX_CHECKS) expect(c.sql).toMatch(/^\s*(WITH|SELECT)/);
    expect(FK_NO_INDEX_SQL).toContain("contype = 'f'");
  });
});
