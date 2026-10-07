import { describe, expect, it } from 'vitest';
import { MAX_GUARD_CHARS, buildGuardClauses, guardPredicate, planGuard } from './edit-guard';
import { dialectFor } from './sql-dialect';

describe('planGuard', () => {
  it('compares ordinary scalar types on every engine', () => {
    for (const engine of ['postgres', 'mysql', 'sqlite'] as const) {
      expect(planGuard(engine, 'int4', '5')).toBe('eq');
      expect(planGuard(engine, 'text', 'héllo 😀')).toBe('eq');
      expect(planGuard(engine, 'timestamp', '2026-01-01 00:00:00')).toBe('eq');
    }
  });

  it('compares NULL (the value is simply null)', () => {
    expect(planGuard('postgres', 'text', null)).toBe('eq');
  });

  it('skips values over the size cap, keeping the key-only behaviour', () => {
    expect(planGuard('postgres', 'text', 'x'.repeat(MAX_GUARD_CHARS))).toBe('eq');
    expect(planGuard('postgres', 'text', 'x'.repeat(MAX_GUARD_CHARS + 1))).toBe('skip');
  });

  it('postgres: json is compared as jsonb, types without = are skipped, arrays follow the element type', () => {
    expect(planGuard('postgres', 'json', '{"a":1}')).toBe('json-cast');
    expect(planGuard('postgres', 'jsonb', '{"a":1}')).toBe('eq');
    expect(planGuard('postgres', 'point', '(1,2)')).toBe('skip');
    expect(planGuard('postgres', '_point', '{"(1,2)"}')).toBe('skip');
    expect(planGuard('postgres', 'int4[]', '{1,2}')).toBe('eq');
    expect(planGuard('postgres', 'float8', '0.1')).toBe('eq');
  });

  it('mysql: json, floats and binary are skipped', () => {
    for (const t of ['json', 'float', 'double', 'blob', 'longblob', 'binary', 'varbinary', 'bit']) {
      expect(planGuard('mysql', t, '1')).toBe('skip');
    }
    expect(planGuard('mysql', 'decimal', '1.50')).toBe('eq');
    expect(planGuard('mysql', 'datetime', '2026-01-01 00:00:00')).toBe('eq');
  });

  it('sqlite: real and blob are skipped', () => {
    for (const t of ['real', 'float', 'double', 'blob']) {
      expect(planGuard('sqlite', t, '1')).toBe('skip');
    }
    expect(planGuard('sqlite', 'integer', '1')).toBe('eq');
  });

  it('engines that cannot detect conflicts never guard', () => {
    expect(planGuard('clickhouse', 'int4', '1')).toBe('skip');
    expect(planGuard('duckdb', 'int4', '1')).toBe('skip');
  });
});

describe('planGuard: types that cannot be compared (P1-2, P1-3, P2-5)', () => {
  it('postgres: json arrays, jsonpath, snapshots and anything the server flags are skipped', () => {
    for (const t of ['_json', 'json[]', 'jsonpath', '_jsonpath', 'pg_snapshot', 'txid_snapshot']) {
      expect(planGuard('postgres', t, 'x'), t).toBe('skip');
    }
    expect(planGuard('postgres', 'mycomposite', '(1,2)', true)).toBe('skip');
    expect(planGuard('postgres', 'mycomposite[]', '{}', true)).toBe('skip');
    expect(planGuard('postgres', 'mydomain', 'x', undefined)).toBe('eq');
  });
  it('postgres: json numbers JavaScript cannot hold exactly are not compared', () => {
    expect(planGuard('postgres', 'jsonb', '{"a":12345678901234567890}')).toBe('skip');
    expect(planGuard('postgres', 'jsonb', '{"a":"12345678901234567890"}')).toBe('skip');
    expect(planGuard('postgres', 'jsonb', '{"a":123}')).toBe('eq');
  });
  it('sqlite and mysql: binary is skipped whatever the column is called', () => {
    expect(planGuard('sqlite', 'bytea', '\\xdeadbeef')).toBe('skip');
    expect(planGuard('sqlite', 'text', '\\x00')).toBe('skip');
    expect(planGuard('sqlite', '', '\\x00')).toBe('skip');
    expect(planGuard('mysql', 'text', '\\x00ff')).toBe('skip');
    expect(planGuard('sqlite', 'text', 'plain')).toBe('eq');
  });
});

describe('guardPredicate', () => {
  it('postgres', () => {
    const d = dialectFor('postgres');
    expect(guardPredicate(d, 'a"b', 'eq', '$3')).toBe('"a""b" IS NOT DISTINCT FROM $3');
    expect(guardPredicate(d, 'doc', 'json-cast', '$3')).toBe(
      '"doc"::jsonb IS NOT DISTINCT FROM $3::jsonb',
    );
  });
  it('mysql uses the null-safe equals', () => {
    expect(guardPredicate(dialectFor('mysql'), 'a`b', 'eq', '$3')).toBe('`a``b` <=> $3');
  });
  it('sqlite uses IS, plus a text comparison for columns with no affinity', () => {
    expect(guardPredicate(dialectFor('sqlite'), 'a', 'eq', '$3')).toBe(
      '("a" IS $3 OR CAST("a" AS TEXT) IS $3)',
    );
  });
});

describe('buildGuardClauses', () => {
  it('binds one parameter per compared value, in order, skipping the skipped', () => {
    const params: unknown[] = [];
    const add = (v: unknown) => {
      params.push(v);
      return `$${params.length + 10}`;
    };
    const out = buildGuardClauses(
      dialectFor('postgres'),
      [
        { column: 'a', value: '1', type: 'int4' },
        { column: 'p', value: '(1,2)', type: 'point' },
        { column: 'b', value: null, type: 'text' },
      ],
      add,
    );
    expect(out).toEqual(['"a" IS NOT DISTINCT FROM $11', '"b" IS NOT DISTINCT FROM $12']);
    expect(params).toEqual(['1', null]);
  });
  it('is empty with no guards', () => {
    expect(buildGuardClauses(dialectFor('postgres'), undefined, () => '$1')).toEqual([]);
  });
});
