import { describe, expect, it } from 'vitest';
import {
  type BuildInput,
  type Filter,
  buildCountSql,
  buildDataSql,
  buildUpdateSql,
  quoteIdent,
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
