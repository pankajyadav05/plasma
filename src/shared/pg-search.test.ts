import { describe, expect, it } from 'vitest';
import {
  buildTableSearch,
  cellMatches,
  classifyColumn,
  escapeLike,
  rowFilters,
  searchableColumns,
} from './pg-search';

const cols = [
  { name: 'id', dataType: 'integer' },
  { name: 'Name', dataType: 'character varying' },
  { name: 'note', dataType: 'text' },
  { name: 'data', dataType: 'jsonb' },
  { name: 'blob', dataType: 'bytea' },
];

describe('classifyColumn', () => {
  it('groups types', () => {
    expect(classifyColumn('character varying')).toBe('text');
    expect(classifyColumn('bigint')).toBe('number');
    expect(classifyColumn('timestamp with time zone')).toBe('datetime');
    expect(classifyColumn('uuid')).toBe('uuid');
    expect(classifyColumn('integer[]')).toBe('other');
    expect(classifyColumn('bytea')).toBe('binary');
  });
});

describe('buildTableSearch', () => {
  it('contains: ILIKE with an escaped, parameterised pattern', () => {
    const q = buildTableSearch('public', 'users', cols, { term: '50%_off', op: 'contains' });
    expect(q?.params).toEqual(['%50\\%\\_off%']);
    expect(q?.sql).toBe(
      'SELECT t.* FROM "public"."users" t WHERE (t."id"::text ILIKE $1 OR t."Name"::text ILIKE $1 OR t."note"::text ILIKE $1) LIMIT 50',
    );
  });

  it('never inlines the term or lets identifiers break out', () => {
    const term = `'; DROP TABLE users; --`;
    const q = buildTableSearch('we"ird', 'ta"ble', [{ name: 'c"ol', dataType: 'text' }], {
      term,
      op: 'equals',
    });
    expect(q?.sql).not.toContain('DROP');
    expect(q?.sql).toContain('"we""ird"."ta""ble"');
    expect(q?.sql).toContain('t."c""ol"');
    expect(q?.params).toEqual([term]);
  });

  it('equals: numeric compare for numbers, skip number columns for text terms', () => {
    const n = buildTableSearch('s', 't', cols, { term: '42', op: 'equals' });
    expect(n?.sql).toContain('t."id"::numeric = $1::numeric');
    expect(n?.sql).toContain('lower(t."Name"::text) = lower($2)');
    expect(n?.params).toEqual(['42', '42']);
    const s = buildTableSearch('s', 't', cols, { term: 'bob', op: 'equals' });
    expect(s?.columns).toEqual(['Name', 'note']);
  });

  it('startsWith and regex operators', () => {
    expect(buildTableSearch('s', 't', cols, { term: 'ab_', op: 'startsWith' })?.params).toEqual([
      'ab\\_%',
    ]);
    const r = buildTableSearch('s', 't', cols, {
      term: '^a.*z$',
      op: 'regex',
      caseSensitive: true,
    });
    expect(r?.sql).toContain('::text ~ $1');
    const ri = buildTableSearch('s', 't', cols, { term: 'x', op: 'regex' });
    expect(ri?.sql).toContain('::text ~* $1');
  });

  it('respects column classes and clamps the limit', () => {
    const q = buildTableSearch('s', 't', cols, {
      term: 'x',
      op: 'contains',
      classes: ['json'],
      limit: 99999,
    });
    expect(q?.columns).toEqual(['data']);
    expect(q?.sql.endsWith('LIMIT 1000')).toBe(true);
    expect(buildTableSearch('s', 't', cols, { term: 'x', op: 'contains', limit: -1 })?.sql).toMatch(
      /LIMIT 50$/,
    );
  });

  it('returns null for empty terms or no eligible columns', () => {
    expect(buildTableSearch('s', 't', cols, { term: '', op: 'contains' })).toBeNull();
    expect(
      buildTableSearch('s', 't', [{ name: 'b', dataType: 'bytea' }], { term: 'x', op: 'contains' }),
    ).toBeNull();
    expect(searchableColumns(cols, { term: 'x', op: 'contains', classes: [] })).toEqual([]);
  });
});

describe('cellMatches / rowFilters', () => {
  it('mirrors the operators', () => {
    expect(cellMatches('Hello', { term: 'ell', op: 'contains' })).toBe(true);
    expect(cellMatches('Hello', { term: 'ell', op: 'contains', caseSensitive: true })).toBe(true);
    expect(cellMatches('Hello', { term: 'ELL', op: 'contains', caseSensitive: true })).toBe(false);
    expect(cellMatches('1.0', { term: '1', op: 'equals' })).toBe(true);
    expect(cellMatches('abc', { term: '^a', op: 'regex' })).toBe(true);
    expect(cellMatches('abc', { term: '(', op: 'regex' })).toBe(false);
    expect(cellMatches(null, { term: 'a', op: 'contains' })).toBe(false);
  });

  it('prefers the primary key, falls back to a matched column', () => {
    expect(rowFilters(['id', 'n'], [7, 'x'], ['id'], ['n'])).toEqual([
      { column: 'id', value: '7' },
    ]);
    expect(rowFilters(['n'], ['x'], ['id'], ['n'])).toEqual([{ column: 'n', value: 'x' }]);
    expect(rowFilters(['n'], [null], [], ['n'])).toEqual([]);
  });

  it('escapes like metacharacters', () => {
    expect(escapeLike('a\\b%c_')).toBe('a\\\\b\\%c\\_');
  });
});
