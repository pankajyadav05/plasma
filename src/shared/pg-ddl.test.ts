import { describe, expect, it } from 'vitest';
import {
  DdlError,
  buildAlterPlan,
  buildCreateTable,
  buildCreateView,
  changeStatements,
  checkExpression,
  checkType,
  columnDefinitionSql,
  constraintSql,
  createIndexSql,
  formatPlan,
  normalizeDefault,
  quoteIdent,
  quoteLiteral,
  suggestUsing,
  typeCategory,
} from './pg-ddl';

describe('quoteIdent', () => {
  it('leaves simple lower-case names bare', () => {
    expect(quoteIdent('users')).toBe('users');
    expect(quoteIdent('_a1$')).toBe('_a1$');
  });
  it('quotes upper case, spaces, leading digits and reserved words', () => {
    expect(quoteIdent('Users')).toBe('"Users"');
    expect(quoteIdent('my col')).toBe('"my col"');
    expect(quoteIdent('1a')).toBe('"1a"');
    expect(quoteIdent('select')).toBe('"select"');
    expect(quoteIdent('user')).toBe('"user"');
    expect(quoteIdent('order')).toBe('"order"');
  });
  it('doubles embedded quotes', () => {
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
  });
  it('rejects empty, NUL and over-long names', () => {
    expect(() => quoteIdent('')).toThrow(DdlError);
    expect(() => quoteIdent('a\0b')).toThrow(DdlError);
    expect(() => quoteIdent('x'.repeat(64))).toThrow(/longer than 63/);
    expect(() => quoteIdent('é'.repeat(32))).toThrow(/longer than 63/);
    expect(quoteIdent('x'.repeat(63))).toBe('x'.repeat(63));
  });
});

describe('quoteLiteral', () => {
  it('doubles single quotes and keeps backslashes', () => {
    expect(quoteLiteral("it's")).toBe("'it''s'");
    expect(quoteLiteral('a\\b')).toBe("'a\\b'");
  });
  it('rejects NUL', () => {
    expect(() => quoteLiteral('a\0')).toThrow(DdlError);
  });
});

describe('checkType', () => {
  it('accepts common and parameterised types', () => {
    for (const t of [
      'text',
      'varchar(20)',
      'numeric(10, 2)',
      'timestamp(3) with time zone',
      'double precision',
      'integer[]',
      'public."My Enum"',
      '"Weird""Name"[]',
    ]) {
      expect(checkType(t)).toBe(t);
    }
  });
  it('collapses whitespace', () => {
    expect(checkType('  double   precision ')).toBe('double precision');
  });
  it('rejects injection attempts and junk', () => {
    for (const t of [
      '',
      'int; drop table x',
      'int) --',
      "text'",
      'varchar(a)',
      'varchar((1))',
      'int -- x',
      '(int)',
      'text"',
      '1abc',
    ]) {
      expect(() => checkType(t), t).toThrow(DdlError);
    }
  });
});

describe('checkExpression', () => {
  it('passes single expressions with quotes, casts and parens', () => {
    expect(checkExpression(" now() + interval '1 day' ")).toBe("now() + interval '1 day'");
    expect(checkExpression("a > 0 AND b <> 'x;y'")).toBe("a > 0 AND b <> 'x;y'");
    expect(checkExpression('$$a;b$$')).toBe('$$a;b$$');
  });
  it('rejects statements, comments, imbalance', () => {
    expect(() => checkExpression('1; drop table t')).toThrow(/single expression/);
    expect(() => checkExpression('1 -- x')).toThrow(/comments/);
    expect(() => checkExpression('1 /* x */')).toThrow(/comments/);
    expect(() => checkExpression('(1')).toThrow(/parentheses/);
    expect(() => checkExpression('1)')).toThrow(/parentheses/);
    expect(() => checkExpression("'abc")).toThrow(/unclosed/);
    expect(() => checkExpression('  ')).toThrow(/empty/);
  });
});

describe('normalizeDefault', () => {
  it('passes SQL-looking defaults through', () => {
    expect(normalizeDefault('now()', 'timestamptz')).toBe('now()');
    expect(normalizeDefault('42', 'integer')).toBe('42');
    expect(normalizeDefault('-1.5', 'numeric')).toBe('-1.5');
    expect(normalizeDefault('true', 'boolean')).toBe('true');
    expect(normalizeDefault('NULL', 'text')).toBe('NULL');
    expect(normalizeDefault("'x'::text", 'text')).toBe("'x'::text");
    expect(normalizeDefault('CURRENT_TIMESTAMP', 'timestamp')).toBe('CURRENT_TIMESTAMP');
    expect(normalizeDefault('gen_random_uuid()', 'uuid')).toBe('gen_random_uuid()');
  });
  it('quotes bare words on text-like columns', () => {
    expect(normalizeDefault('active', 'varchar(10)')).toBe("'active'");
    expect(normalizeDefault("o'neil", 'text')).toBe("'o''neil'");
    expect(normalizeDefault('{}', 'jsonb')).toBe("'{}'");
  });
  it('refuses multi-statement defaults', () => {
    expect(() => normalizeDefault('1; drop table t', 'integer')).toThrow(DdlError);
    expect(() => normalizeDefault('f(1); x', 'integer')).toThrow(DdlError);
  });
});

describe('columnDefinitionSql', () => {
  it('renders name, type, NOT NULL, DEFAULT', () => {
    expect(
      columnDefinitionSql({ name: 'email', type: 'varchar(255)', nullable: false, default: 'x' }),
    ).toBe("email varchar(255) NOT NULL DEFAULT 'x'");
  });
  it('quotes awkward names and forces NOT NULL for PK columns', () => {
    expect(
      columnDefinitionSql({ name: 'Order', type: 'int', nullable: true, primaryKey: true }),
    ).toBe('"Order" int NOT NULL');
  });
  it('puts UNIQUE inline only on request', () => {
    const c = { name: 'a', type: 'text', nullable: true, unique: true };
    expect(columnDefinitionSql(c)).toBe('a text');
    expect(columnDefinitionSql(c, { inlineUnique: true })).toBe('a text UNIQUE');
  });
});

describe('constraintSql', () => {
  it('primary / unique / check', () => {
    expect(constraintSql({ type: 'primary', columns: ['id'] })).toBe('PRIMARY KEY (id)');
    expect(constraintSql({ type: 'primary', name: 'pk_t', columns: ['a', 'B'] })).toBe(
      'CONSTRAINT pk_t PRIMARY KEY (a, "B")',
    );
    expect(constraintSql({ type: 'unique', name: 'u', columns: ['x'] })).toBe(
      'CONSTRAINT u UNIQUE (x)',
    );
    expect(constraintSql({ type: 'check', name: 'pos', expression: 'qty > 0' })).toBe(
      'CONSTRAINT pos CHECK (qty > 0)',
    );
  });
  it('foreign key with actions', () => {
    expect(
      constraintSql({
        type: 'foreign',
        name: 'fk_o_u',
        columns: ['user_id'],
        refSchema: 'public',
        refTable: 'Users',
        refColumns: ['id'],
        onDelete: 'CASCADE',
        onUpdate: 'SET NULL',
      }),
    ).toBe(
      'CONSTRAINT fk_o_u FOREIGN KEY (user_id) REFERENCES public."Users" (id) ON UPDATE SET NULL ON DELETE CASCADE',
    );
  });
  it('omits NO ACTION and checks arity', () => {
    expect(
      constraintSql({
        type: 'foreign',
        columns: ['a'],
        refSchema: 's',
        refTable: 't',
        refColumns: ['b'],
        onDelete: 'NO ACTION',
      }),
    ).toBe('FOREIGN KEY (a) REFERENCES s.t (b)');
    expect(() =>
      constraintSql({
        type: 'foreign',
        columns: ['a', 'b'],
        refSchema: 's',
        refTable: 't',
        refColumns: ['b'],
      }),
    ).toThrow(/same number/);
    expect(() => constraintSql({ type: 'unique', columns: [] })).toThrow(/at least one/);
  });
  it('rejects bad actions and check injection', () => {
    expect(() =>
      constraintSql({
        type: 'foreign',
        columns: ['a'],
        refSchema: 's',
        refTable: 't',
        refColumns: ['b'],
        onDelete: 'CASCADE; DROP' as never,
      }),
    ).toThrow(DdlError);
    expect(() => constraintSql({ type: 'check', expression: '1); drop table t; --' })).toThrow();
  });
});

describe('createIndexSql', () => {
  it('basic, unique, method, partial, concurrently', () => {
    expect(createIndexSql('public', 't', { columns: ['a'] })).toBe('CREATE INDEX ON public.t (a)');
    expect(
      createIndexSql('public', 'T', {
        name: 'idx_t_a_b',
        columns: ['a', 'b'],
        unique: true,
        where: 'b IS NOT NULL',
        concurrently: true,
      }),
    ).toBe('CREATE UNIQUE INDEX CONCURRENTLY idx_t_a_b ON public."T" (a, b) WHERE b IS NOT NULL');
    expect(createIndexSql('s', 't', { columns: ['doc'], method: 'gin' })).toBe(
      'CREATE INDEX ON s.t USING gin (doc)',
    );
  });
  it('rejects unique non-btree, unknown method and empty column list', () => {
    expect(() =>
      createIndexSql('s', 't', { columns: ['a'], unique: true, method: 'gin' }),
    ).toThrow();
    expect(() => createIndexSql('s', 't', { columns: ['a'], method: 'x' as never })).toThrow();
    expect(() => createIndexSql('s', 't', { columns: [] })).toThrow();
    expect(() => createIndexSql('s', 't', { columns: ['a'], where: 'a; drop' })).toThrow();
  });
});

describe('buildCreateTable', () => {
  it('creates a table with PK, defaults, unique and comments', () => {
    const sql = buildCreateTable({
      schema: 'public',
      name: 'Orders',
      comment: "it's orders",
      columns: [
        { name: 'id', type: 'bigserial', nullable: false, primaryKey: true },
        { name: 'email', type: 'text', nullable: false, unique: true, comment: 'contact' },
        { name: 'created_at', type: 'timestamptz', nullable: false, default: 'now()' },
        { name: 'note', type: 'text', nullable: true },
      ],
    });
    expect(sql).toEqual([
      [
        'CREATE TABLE public."Orders" (',
        '  id bigserial NOT NULL,',
        '  email text NOT NULL UNIQUE,',
        '  created_at timestamptz NOT NULL DEFAULT now(),',
        '  note text,',
        '  PRIMARY KEY (id)',
        ')',
      ].join('\n'),
      `COMMENT ON TABLE public."Orders" IS 'it''s orders'`,
      `COMMENT ON COLUMN public."Orders".email IS 'contact'`,
    ]);
  });
  it('supports composite PK via flags and explicit constraints', () => {
    const [sql] = buildCreateTable({
      schema: 's',
      name: 't',
      ifNotExists: true,
      columns: [
        { name: 'a', type: 'int', nullable: false, primaryKey: true },
        { name: 'b', type: 'int', nullable: false, primaryKey: true },
      ],
      constraints: [{ type: 'check', expression: 'a < b' }],
    });
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS s.t (');
    expect(sql).toContain('PRIMARY KEY (a, b)');
    expect(sql).toContain('CHECK (a < b)');
  });
  it('validates input', () => {
    expect(() => buildCreateTable({ schema: 's', name: 't', columns: [] })).toThrow(/at least one/);
    expect(() =>
      buildCreateTable({
        schema: 's',
        name: 't',
        columns: [
          { name: 'a', type: 'int', nullable: true },
          { name: 'a', type: 'int', nullable: true },
        ],
      }),
    ).toThrow(/twice/);
    expect(() =>
      buildCreateTable({
        schema: 's',
        name: 't',
        columns: [{ name: 'a', type: 'int); drop table x; --', nullable: true }],
      }),
    ).toThrow(DdlError);
  });
});

describe('buildCreateView', () => {
  it('view, or replace, materialized', () => {
    expect(buildCreateView({ schema: 'public', name: 'v', query: 'select 1;' })).toBe(
      'CREATE VIEW public.v AS\nselect 1',
    );
    expect(
      buildCreateView({
        schema: 'public',
        name: 'v',
        query: 'with a as (select 1) select * from a',
        orReplace: true,
      }),
    ).toContain('CREATE OR REPLACE VIEW');
    expect(
      buildCreateView({
        schema: 's',
        name: 'mv',
        query: 'select 1',
        materialized: true,
        withNoData: true,
      }),
    ).toBe('CREATE MATERIALIZED VIEW s.mv AS\nselect 1\nWITH NO DATA');
  });
  it('validates', () => {
    expect(() => buildCreateView({ schema: 's', name: 'v', query: '' })).toThrow();
    expect(() => buildCreateView({ schema: 's', name: 'v', query: 'drop table x' })).toThrow();
    expect(() =>
      buildCreateView({
        schema: 's',
        name: 'v',
        query: 'select 1',
        materialized: true,
        orReplace: true,
      }),
    ).toThrow();
  });
});

describe('suggestUsing / typeCategory', () => {
  it('suggests a cast across families only', () => {
    expect(suggestUsing('age', 'text', 'integer')).toBe('age::integer');
    expect(suggestUsing('Age', 'varchar(10)', 'numeric(10, 2)')).toBe('"Age"::numeric(10, 2)');
    expect(suggestUsing('a', 'integer', 'bigint')).toBeNull();
    expect(suggestUsing('a', 'integer', 'text')).toBeNull();
    expect(suggestUsing('a', 'varchar(5)', 'varchar(9)')).toBeNull();
    expect(suggestUsing('a', 'jsonb', 'uuid')).toBe('a::uuid');
  });
  it('categorises types', () => {
    expect(typeCategory('character varying(3)')).toBe('text');
    expect(typeCategory('timestamptz')).toBe('datetime');
    expect(typeCategory('int[]')).toBe('other');
    expect(typeCategory('boolean')).toBe('boolean');
  });
});

describe('changeStatements / buildAlterPlan', () => {
  const S = 'public';
  const T = 'Users';
  it('column changes', () => {
    expect(
      changeStatements(S, T, {
        kind: 'addColumn',
        column: { name: 'age', type: 'int', nullable: true, default: '0', comment: 'years' },
      }),
    ).toEqual([
      'ALTER TABLE public."Users" ADD COLUMN age int DEFAULT 0',
      `COMMENT ON COLUMN public."Users".age IS 'years'`,
    ]);
    expect(changeStatements(S, T, { kind: 'dropColumn', name: 'age', cascade: true })).toEqual([
      'ALTER TABLE public."Users" DROP COLUMN age CASCADE',
    ]);
    expect(changeStatements(S, T, { kind: 'renameColumn', from: 'a', to: 'B' })).toEqual([
      'ALTER TABLE public."Users" RENAME COLUMN a TO "B"',
    ]);
    expect(changeStatements(S, T, { kind: 'renameColumn', from: 'a', to: 'a' })).toEqual([]);
    expect(
      changeStatements(S, T, {
        kind: 'alterType',
        name: 'age',
        type: 'bigint',
        using: 'age::bigint',
      }),
    ).toEqual(['ALTER TABLE public."Users" ALTER COLUMN age TYPE bigint USING age::bigint']);
    expect(
      changeStatements(S, T, { kind: 'setDefault', name: 'a', type: 'text', default: 'x' }),
    ).toEqual(['ALTER TABLE public."Users" ALTER COLUMN a SET DEFAULT \'x\'']);
    expect(
      changeStatements(S, T, { kind: 'setDefault', name: 'a', type: 'text', default: '' }),
    ).toEqual(['ALTER TABLE public."Users" ALTER COLUMN a DROP DEFAULT']);
    expect(changeStatements(S, T, { kind: 'setNullable', name: 'a', nullable: false })).toEqual([
      'ALTER TABLE public."Users" ALTER COLUMN a SET NOT NULL',
    ]);
    expect(changeStatements(S, T, { kind: 'setComment', name: 'a', comment: null })).toEqual([
      'COMMENT ON COLUMN public."Users".a IS NULL',
    ]);
  });
  it('adding a PK column adds the key', () => {
    expect(
      changeStatements(S, 't', {
        kind: 'addColumn',
        column: { name: 'id', type: 'serial', nullable: false, primaryKey: true },
      }),
    ).toEqual([
      'ALTER TABLE public.t ADD COLUMN id serial NOT NULL',
      'ALTER TABLE public.t ADD PRIMARY KEY (id)',
    ]);
  });
  it('index and constraint changes', () => {
    expect(
      changeStatements(S, 't', { kind: 'dropIndex', schema: 'public', name: 'ix', cascade: true }),
    ).toEqual(['DROP INDEX public.ix CASCADE']);
    expect(
      changeStatements(S, 't', {
        kind: 'dropIndex',
        schema: 'public',
        name: 'ix',
        concurrently: true,
        cascade: true,
      }),
    ).toEqual(['DROP INDEX CONCURRENTLY public.ix']);
    expect(changeStatements(S, 't', { kind: 'dropConstraint', name: 'fk' })).toEqual([
      'ALTER TABLE public.t DROP CONSTRAINT fk',
    ]);
    expect(
      changeStatements(S, 't', {
        kind: 'addConstraint',
        constraint: { type: 'unique', columns: ['a'] },
      }),
    ).toEqual(['ALTER TABLE public.t ADD UNIQUE (a)']);
  });
  it('splits concurrent statements from the transactional plan', () => {
    const plan = buildAlterPlan(S, 't', [
      { kind: 'renameColumn', from: 'a', to: 'b' },
      { kind: 'addIndex', index: { columns: ['b'], concurrently: true } },
      { kind: 'setNullable', name: 'b', nullable: false },
    ]);
    expect(plan.transactional).toEqual([
      'ALTER TABLE public.t RENAME COLUMN a TO b',
      'ALTER TABLE public.t ALTER COLUMN b SET NOT NULL',
    ]);
    expect(plan.concurrent).toEqual(['CREATE INDEX CONCURRENTLY ON public.t (b)']);
    const text = formatPlan(plan);
    expect(text).toContain('BEGIN;');
    expect(text).toContain('COMMIT;');
    expect(text).toContain('outside the transaction');
    expect(text.indexOf('COMMIT;')).toBeLessThan(text.indexOf('CONCURRENTLY'));
  });
  it('empty plan formats to empty text', () => {
    expect(formatPlan(buildAlterPlan(S, 't', []))).toBe('');
  });
});
