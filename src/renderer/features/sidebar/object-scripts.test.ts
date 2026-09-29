import { describe, expect, it } from 'vitest';
import {
  buildCompositeDdl,
  buildCreateViewScript,
  buildDomainDdl,
  buildDropScript,
  buildEnumDdl,
  buildExtensionDdl,
  buildInsertScript,
  buildRangeDdl,
  buildSelectScript,
  buildSequenceDdl,
  buildTruncateScript,
  composeCreateTable,
  ident,
  qualified,
  quotedQualified,
} from './object-scripts';

describe('ident', () => {
  it('leaves plain lowercase identifiers bare', () => {
    expect(ident('users')).toBe('users');
    expect(ident('_tmp$1')).toBe('_tmp$1');
  });
  it('quotes mixed case, symbols and reserved words', () => {
    expect(ident('Users')).toBe('"Users"');
    expect(ident('my table')).toBe('"my table"');
    expect(ident('user')).toBe('"user"');
    expect(ident('order')).toBe('"order"');
    expect(ident('a"b')).toBe('"a""b"');
    expect(ident('1abc')).toBe('"1abc"');
  });
  it('builds qualified names', () => {
    expect(qualified('public', 'User')).toBe('public."User"');
    expect(quotedQualified('public', 'users')).toBe('"public"."users"');
  });
});

describe('DROP / TRUNCATE', () => {
  it('uses the right keyword per kind', () => {
    expect(buildDropScript({ kind: 'table', schema: 'public', name: 'users' })).toBe(
      'DROP TABLE public.users;',
    );
    expect(buildDropScript({ kind: 'partitioned', schema: 's', name: 'm' })).toBe(
      'DROP TABLE s.m;',
    );
    expect(buildDropScript({ kind: 'view', schema: 's', name: 'v' })).toBe('DROP VIEW s.v;');
    expect(buildDropScript({ kind: 'matview', schema: 's', name: 'v' })).toBe(
      'DROP MATERIALIZED VIEW s.v;',
    );
    expect(buildDropScript({ kind: 'foreign', schema: 's', name: 'f' })).toBe(
      'DROP FOREIGN TABLE s.f;',
    );
    expect(buildDropScript({ kind: 'sequence', schema: 's', name: 'q' })).toBe(
      'DROP SEQUENCE s.q;',
    );
    expect(buildDropScript({ kind: 'type', schema: 's', name: 'mood', typeKind: 'enum' })).toBe(
      'DROP TYPE s.mood;',
    );
    expect(buildDropScript({ kind: 'type', schema: 's', name: 'email', typeKind: 'domain' })).toBe(
      'DROP DOMAIN s.email;',
    );
    expect(buildDropScript({ kind: 'extension', name: 'pg_trgm' })).toBe('DROP EXTENSION pg_trgm;');
  });

  it('addresses function overloads by their argument list', () => {
    expect(
      buildDropScript({
        kind: 'function',
        schema: 'public',
        name: 'add',
        args: 'a integer, b integer',
      }),
    ).toBe('DROP FUNCTION public.add(a integer, b integer);');
    expect(
      buildDropScript(
        { kind: 'procedure', schema: 'public', name: 'p', args: '' },
        { cascade: true },
      ),
    ).toBe('DROP PROCEDURE public.p() CASCADE;');
  });

  it('supports CASCADE and RESTART IDENTITY', () => {
    expect(
      buildDropScript({ kind: 'table', schema: 'public', name: 'User' }, { cascade: true }),
    ).toBe('DROP TABLE public."User" CASCADE;');
    expect(buildTruncateScript('public', 'users')).toBe('TRUNCATE TABLE public.users;');
    expect(buildTruncateScript('public', 'users', { cascade: true, restartIdentity: true })).toBe(
      'TRUNCATE TABLE public.users RESTART IDENTITY CASCADE;',
    );
  });
});

describe('SELECT / INSERT', () => {
  it('lists columns, or * when unknown', () => {
    expect(buildSelectScript('public', 'users', ['id', 'Email', 'user'])).toBe(
      'SELECT id, "Email", "user"\nFROM public.users\nLIMIT 100;',
    );
    expect(buildSelectScript('public', 'users')).toBe('SELECT *\nFROM public.users\nLIMIT 100;');
  });

  it('builds an INSERT template with DEFAULT / NULL per column', () => {
    expect(
      buildInsertScript('public', 'users', [
        { name: 'id', dataType: 'integer', hasDefault: true },
        { name: 'email', dataType: 'text' },
      ]),
    ).toBe(
      'INSERT INTO public.users (id, email)\nVALUES (\n  DEFAULT, -- id integer\n  NULL -- email text\n);',
    );
    expect(buildInsertScript('public', 'users', [])).toBe(
      'INSERT INTO public.users DEFAULT VALUES;',
    );
  });
});

describe('CREATE scripts', () => {
  it('composes CREATE TABLE with constraints and non-constraint indexes', () => {
    const ddl = composeCreateTable('public', 'users', [
      {
        kind: 'col',
        c1: 'id',
        c2: 'integer',
        c3: 'NOT NULL',
        c4: "nextval('users_id_seq'::regclass)",
      },
      { kind: 'col', c1: 'Email', c2: 'text', c3: '', c4: '' },
      { kind: 'con', c1: 'users_pkey', c2: 'PRIMARY KEY (id)', c3: '', c4: '' },
      {
        kind: 'idx',
        c1: 'users_pkey',
        c2: 'CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)',
        c3: '',
        c4: '',
      },
      {
        kind: 'idx',
        c1: 'users_email_idx',
        c2: 'CREATE INDEX users_email_idx ON public.users USING btree ("Email")',
        c3: '',
        c4: '',
      },
    ]);
    expect(ddl).toBe(
      [
        'CREATE TABLE public.users (\n  id integer NOT NULL DEFAULT nextval(\'users_id_seq\'::regclass),\n  "Email" text\n);',
        'ALTER TABLE public.users\n  ADD CONSTRAINT users_pkey PRIMARY KEY (id);',
        'CREATE INDEX users_email_idx ON public.users USING btree ("Email");',
      ].join('\n\n'),
    );
  });

  it('wraps view definitions', () => {
    expect(buildCreateViewScript('view', 'public', 'active', ' SELECT 1;\n')).toBe(
      'CREATE OR REPLACE VIEW public.active AS\nSELECT 1;',
    );
    expect(buildCreateViewScript('matview', 'public', 'm', 'SELECT 1')).toBe(
      'CREATE MATERIALIZED VIEW public.m AS\nSELECT 1;',
    );
  });

  it('builds sequence, type and extension DDL', () => {
    expect(
      buildSequenceDdl('public', 'users_id_seq', {
        dataType: 'integer',
        start: '1',
        increment: '1',
        min: '1',
        max: '2147483647',
        cache: '1',
        cycle: false,
      }),
    ).toBe(
      'CREATE SEQUENCE public.users_id_seq\n  AS integer\n  INCREMENT BY 1\n  MINVALUE 1\n  MAXVALUE 2147483647\n  START WITH 1\n  CACHE 1\n  NO CYCLE;',
    );
    expect(buildEnumDdl('public', 'mood', ['sad', "it's ok"])).toBe(
      "CREATE TYPE public.mood AS ENUM (\n  'sad',\n  'it''s ok'\n);",
    );
    expect(
      buildCompositeDdl('public', 'pair', [
        { name: 'a', type: 'integer' },
        { name: 'B', type: 'text' },
      ]),
    ).toBe('CREATE TYPE public.pair AS (\n  a integer,\n  "B" text\n);');
    expect(
      buildDomainDdl('public', 'email', {
        baseType: 'text',
        notNull: true,
        defaultExpr: "''::text",
        constraints: ["CONSTRAINT email_check CHECK (VALUE ~ '@'::text)"],
      }),
    ).toBe(
      "CREATE DOMAIN public.email AS text\n  DEFAULT ''::text\n  NOT NULL\n  CONSTRAINT email_check CHECK (VALUE ~ '@'::text);",
    );
    expect(buildRangeDdl('public', 'floatrange', 'double precision')).toBe(
      'CREATE TYPE public.floatrange AS RANGE (\n  SUBTYPE = double precision\n);',
    );
    expect(buildExtensionDdl('pg_trgm', 'public', '1.6')).toBe(
      "CREATE EXTENSION IF NOT EXISTS pg_trgm\n  WITH SCHEMA public\n  VERSION '1.6';",
    );
  });
});
