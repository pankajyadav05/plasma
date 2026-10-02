import { describe, expect, it } from 'vitest';
import {
  type BuildInput,
  type Filter,
  betweenBounds,
  buildCountSql,
  buildDataSql,
  buildUpdateSql,
  quoteIdent,
  splitFilterList,
} from './table-query';

function input(overrides: Partial<BuildInput> = {}): BuildInput {
  return {
    schema: 'public',
    table: 'users',
    allColumns: ['id', 'email', 'plan'],
    hiddenColumns: new Set<string>(),
    sort: [],
    filters: [],
    page: 0,
    pageSize: 50,
    ...overrides,
  };
}

function filter(over: Partial<Filter> & Pick<Filter, 'column' | 'op'>): Filter {
  return { id: `${over.column}-${over.op}`, value: '', ...over };
}

describe('quoteIdent', () => {
  it('quotes and escapes embedded double quotes', () => {
    expect(quoteIdent('users')).toBe('"users"');
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
    expect(quoteIdent('a"; DROP TABLE t --')).toBe('"a""; DROP TABLE t --"');
  });
});

describe('buildDataSql', () => {
  it('selects everything and paginates when nothing is configured', () => {
    const built = buildDataSql(input({ page: 2, pageSize: 50 }));
    expect(built.sql).toBe('SELECT * FROM "public"."users"\nLIMIT 50 OFFSET 100');
    expect(built.params).toEqual([]);
  });

  it('clamps a non-positive page size and a negative page', () => {
    const built = buildDataSql(input({ page: -3, pageSize: 0 }));
    expect(built.sql).toContain('LIMIT 1 OFFSET 0');
  });

  it('projects only visible columns when some are hidden', () => {
    const built = buildDataSql(input({ hiddenColumns: new Set(['email']) }));
    expect(built.sql.startsWith('SELECT "id", "plan" FROM "public"."users"')).toBe(true);
  });

  it('falls back to * when every column is hidden', () => {
    const built = buildDataSql(input({ hiddenColumns: new Set(['id', 'email', 'plan']) }));
    expect(built.sql.startsWith('SELECT * FROM')).toBe(true);
  });

  it('emits sort keys in order with explicit direction', () => {
    const built = buildDataSql(
      input({
        sort: [
          { column: 'plan', direction: 'asc' },
          { column: 'id', direction: 'desc' },
        ],
      }),
    );
    expect(built.sql).toContain('ORDER BY "plan" ASC, "id" DESC');
  });

  it('numbers placeholders in the same order as params', () => {
    const built = buildDataSql(
      input({
        filters: [
          filter({ column: 'plan', op: 'ILIKE', value: 'pro' }),
          filter({ column: 'email', op: '=', value: 'a@b.co' }),
        ],
      }),
    );
    expect(built.sql).toContain('WHERE "plan"::text ILIKE $1 AND "email" = $2');
    expect(built.params).toEqual(['%pro%', 'a@b.co']);
  });

  it('treats %, _ and backslash in LIKE / ILIKE filters as literal text (R-28)', () => {
    const built = buildDataSql(
      input({
        filters: [
          filter({ column: 'a', op: 'ILIKE', value: '50%' }),
          filter({ column: 'b', op: 'LIKE', value: 'user_1' }),
          filter({ column: 'c', op: 'NOT LIKE', value: 'a\\b' }),
        ],
      }),
    );
    expect(built.params).toEqual(['%50\\%%', '%user\\_1%', '%a\\\\b%']);
  });

  it('renders null checks without a placeholder', () => {
    const built = buildDataSql(
      input({
        filters: [
          filter({ column: 'plan', op: 'IS NULL' }),
          filter({ column: 'email', op: 'IS NOT NULL' }),
        ],
      }),
    );
    expect(built.sql).toContain('WHERE "plan" IS NULL AND "email" IS NOT NULL');
    expect(built.params).toEqual([]);
  });

  it('skips value-taking filters with a blank value', () => {
    const built = buildDataSql(
      input({
        filters: [
          filter({ column: 'plan', op: '=', value: '   ' }),
          filter({ column: 'email', op: 'LIKE', value: 'a@b.co' }),
        ],
      }),
    );
    expect(built.sql).toContain('WHERE "email"::text LIKE $1');
    expect(built.params).toEqual(['%a@b.co%']);
  });

  it('preserves bigint operands that exceed Number.MAX_SAFE_INTEGER', () => {
    const bigint = '9007199254740993';
    const built = buildDataSql(
      input({
        filters: [filter({ column: 'id', op: '=', value: bigint })],
      }),
    );
    expect(built.sql).toContain('WHERE "id" = $1');
    expect(built.params).toEqual([bigint]);
    expect(typeof built.params[0]).toBe('string');
    // Would round to 9007199254740992 if coerced via Number.
    expect(built.params[0]).not.toBe(Number(bigint));
  });

  it('preserves high-precision numeric operands without float rounding', () => {
    const numeric = '1.0000000000000001';
    const built = buildDataSql(
      input({
        filters: [filter({ column: 'amount', op: '=', value: numeric })],
      }),
    );
    expect(built.params).toEqual([numeric]);
    expect(typeof built.params[0]).toBe('string');
    // Number(numeric) === 1 in IEEE-754 double.
    expect(built.params[0]).not.toBe(Number(numeric));
  });

  it('preserves zero-padded text identifiers as exact strings', () => {
    const code = '00123';
    const built = buildDataSql(
      input({
        filters: [filter({ column: 'code', op: '=', value: code })],
      }),
    );
    expect(built.params).toEqual([code]);
    expect(typeof built.params[0]).toBe('string');
    // Number/parseInt would yield 123 and drop leading zeros.
    expect(built.params[0]).not.toBe(123);
  });

  it('does not coerce boolean-looking filter strings', () => {
    const built = buildDataSql(
      input({
        filters: [
          filter({ column: 'active', op: '=', value: 'true' }),
          filter({ column: 'flag', op: '!=', value: 'false' }),
        ],
      }),
    );
    expect(built.params).toEqual(['true', 'false']);
    expect(built.params.every((p) => typeof p === 'string')).toBe(true);
  });
});

describe('buildCountSql', () => {
  it('reuses the data query WHERE clause and params', () => {
    const filters = [
      filter({ column: 'plan', op: 'ILIKE', value: 'pro' }),
      filter({ column: 'email', op: 'IS NOT NULL' }),
    ];
    const data = buildDataSql(input({ filters }));
    const count = buildCountSql({ schema: 'public', table: 'users', filters });

    expect(count.sql).toBe(
      'SELECT COUNT(*) FROM "public"."users"\nWHERE "plan"::text ILIKE $1 AND "email" IS NOT NULL',
    );
    expect(count.params).toEqual(data.params);
  });
});

describe('buildUpdateSql', () => {
  it('binds SET params before WHERE params', () => {
    const built = buildUpdateSql({
      schema: 'public',
      table: 'users',
      set: { email: 'new@b.co', plan: null },
      pkValues: { tenant: 't1', id: 7 },
    });
    expect(built.sql).toBe(
      'UPDATE "public"."users" SET "email" = $1, "plan" = $2 WHERE "tenant" = $3 AND "id" = $4',
    );
    expect(built.params).toEqual(['new@b.co', null, 't1', 7]);
  });

  it('refuses to update a row with no primary key', () => {
    expect(() =>
      buildUpdateSql({ schema: 'public', table: 'users', set: { email: 'x' }, pkValues: {} }),
    ).toThrow(/primary-key/);
  });

  it('refuses an empty SET list', () => {
    expect(() =>
      buildUpdateSql({ schema: 'public', table: 'users', set: {}, pkValues: { id: 1 } }),
    ).toThrow(/nothing to update/);
  });
});

describe('deterministic paging (B5/F17) and bounded lookups (A7)', () => {
  const base = {
    schema: 'public',
    table: 't',
    allColumns: ['id', 'a'],
    hiddenColumns: new Set<string>(),
    sort: [] as import('./table-query').TableSort[],
    filters: [],
    page: 1,
    pageSize: 10,
  };

  it('orders by the primary key when nothing is sorted', async () => {
    const { buildDataSql } = await import('./table-query');
    expect(buildDataSql({ ...base, primaryKey: ['id'] }).sql).toContain(
      'ORDER BY "id" ASC\nLIMIT 10 OFFSET 10',
    );
  });

  it('adds the primary key as a tie-breaker after the user sort', async () => {
    const { buildDataSql } = await import('./table-query');
    const sql = buildDataSql({
      ...base,
      sort: [{ column: 'a', direction: 'desc' }],
      primaryKey: ['id'],
    }).sql;
    expect(sql).toContain('ORDER BY "a" DESC, "id" ASC');
  });

  it('falls back to ctid and supports unpaged export', async () => {
    const { buildDataSql } = await import('./table-query');
    const sql = buildDataSql({ ...base, ctidFallback: true, unpaged: true }).sql;
    expect(sql).toContain('ORDER BY ctid');
    expect(sql).not.toContain('LIMIT');
  });

  it('escapes LIKE wildcards and always samples', async () => {
    const { buildDistinctValuesSql } = await import('./table-query');
    const built = buildDistinctValuesSql('s', 't', 'c', '50%_off');
    expect(built.params).toEqual(['50\\%\\_off%']);
    expect(built.sql).toContain('LIMIT 5000');
  });

  it('filters a loaded sample locally, prefix matches first', async () => {
    const { filterSuggestions } = await import('./table-query');
    expect(filterSuggestions(['banana', 'apple', 'pineapple'], 'app')).toEqual([
      'apple',
      'pineapple',
    ]);
  });
});

describe('F6 filter operators', () => {
  const base = {
    schema: 'public',
    table: 't',
    allColumns: ['id', 'name'],
    hiddenColumns: new Set<string>(),
    sort: [],
    page: 0,
    pageSize: 10,
  };
  it('builds IN / NOT IN / BETWEEN / NOT ILIKE with bind params', () => {
    const { sql, params } = buildDataSql({
      ...base,
      filters: [
        { id: 'a', column: 'id', op: 'IN', value: '1, 2,"3,4"' },
        { id: 'b', column: 'id', op: 'BETWEEN', value: '5 and 9' },
        { id: 'c', column: 'name', op: 'NOT ILIKE', value: 'x' },
        { id: 'd', column: 'name', op: 'NOT IN', value: "'a'" },
      ],
    });
    expect(sql).toContain('"id" IN ($1, $2, $3)');
    expect(sql).toContain('"id" BETWEEN $4 AND $5');
    expect(sql).toContain('"name"::text NOT ILIKE $6');
    expect(sql).toContain('"name" NOT IN ($7)');
    expect(params).toEqual(['1', '2', '3,4', '5', '9', '%x%', 'a']);
  });

  it('skips disabled filters and incomplete BETWEEN', () => {
    const { sql } = buildDataSql({
      ...base,
      filters: [
        { id: 'a', column: 'id', op: '=', value: '1', enabled: false },
        { id: 'b', column: 'id', op: 'BETWEEN', value: '5' },
      ],
    });
    expect(sql).not.toContain('WHERE');
  });

  it('splits lists and between bounds', () => {
    expect(splitFilterList('a, \'b,c\', "d"')).toEqual(['a', 'b,c', 'd']);
    expect(betweenBounds('1, 2')).toEqual(['1', '2']);
    expect(betweenBounds('1')).toBeNull();
  });
});
