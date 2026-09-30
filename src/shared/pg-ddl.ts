/**
 * Postgres DDL generation for the structure editor, the create table /
 * view dialogs and import's "create a new table" option.
 *
 * Pure (no I/O, no React) so the renderer can preview the exact SQL the
 * worker will run and so every quoting rule is unit-tested. Everything
 * the user types that ends up inside SQL goes through one of:
 *
 *   - `quoteIdent`       identifiers (always safe; quotes only when needed)
 *   - `quoteLiteral`     string literals (comments)
 *   - `checkType`        type names — a restricted grammar, no quotes/`;`
 *   - `checkExpression`  defaults, CHECK, partial-index WHERE, USING —
 *                        raw SQL on purpose, but one expression only
 *
 * Invalid input throws `DdlError` with a message fit for the UI.
 */

export class DdlError extends Error {
  override readonly name = 'DdlError';
}

// ─── identifiers & literals ──────────────────────────────────────────

/**
 * Keywords that cannot be bare column / table names (Postgres reserved
 * words plus the type- and function-name keywords that are only usable
 * quoted in some positions). Quoting them is always correct.
 */
const RESERVED = new Set(
  (
    'all analyse analyze and any array as asc asymmetric authorization between bigint binary bit ' +
    'boolean both case cast char character check coalesce collate collation column concurrently ' +
    'constraint create cross current_catalog current_date current_role current_schema current_time ' +
    'current_timestamp current_user dec decimal default deferrable desc distinct do else end except ' +
    'exists extract false fetch float for foreign freeze from full grant greatest group grouping ' +
    'having ilike in initially inner inout int integer intersect interval into is isnull join lateral ' +
    'leading least left like limit localtime localtimestamp national natural nchar none normalize not ' +
    'notnull null nullif numeric offset on only or order out outer overlaps overlay placing position ' +
    'precision primary real references returning right row select session_user setof similar smallint ' +
    'some substring symmetric system_user table tablesample then time timestamp to trailing treat trim ' +
    'true union unique user using values varchar variadic verbose when where window with xmlattributes ' +
    'xmlconcat xmlelement xmlexists xmlforest xmlnamespaces xmlparse xmlpi xmlroot xmlserialize xmltable'
  ).split(' '),
);

const SIMPLE_IDENT = /^[a-z_][a-z0-9_$]*$/;
/** Postgres truncates identifiers to NAMEDATALEN-1 bytes. */
export const MAX_IDENT_BYTES = 63;

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Throws unless `name` is usable as an identifier (non-empty, ≤ 63 bytes, no NUL). */
export function checkIdent(name: string, what = 'Name'): string {
  if (typeof name !== 'string' || name.length === 0) throw new DdlError(`${what} is empty`);
  if (name.includes('\0')) throw new DdlError(`${what} contains a NUL character`);
  if (byteLength(name) > MAX_IDENT_BYTES) {
    throw new DdlError(`${what} "${name}" is longer than ${MAX_IDENT_BYTES} bytes`);
  }
  return name;
}

/**
 * Quote an identifier the way `quote_ident()` does: bare when it is a
 * lower-case simple name that isn't a keyword, double-quoted otherwise.
 */
export function quoteIdent(name: string): string {
  checkIdent(name);
  if (SIMPLE_IDENT.test(name) && !RESERVED.has(name)) return name;
  return `"${name.replace(/"/g, '""')}"`;
}

/** `schema.name`, each part quoted as needed. */
export function qualifiedName(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

/** Standard-conforming string literal (`'it''s'`). */
export function quoteLiteral(value: string): string {
  if (value.includes('\0')) throw new DdlError('Text contains a NUL character');
  return `'${value.replace(/'/g, "''")}'`;
}

// ─── types ───────────────────────────────────────────────────────────

/** Types offered by the type autocomplete, most common first. */
export const COMMON_PG_TYPES: readonly string[] = [
  'text',
  'varchar(255)',
  'integer',
  'bigint',
  'smallint',
  'serial',
  'bigserial',
  'boolean',
  'numeric(10, 2)',
  'numeric',
  'real',
  'double precision',
  'uuid',
  'timestamptz',
  'timestamp',
  'date',
  'time',
  'interval',
  'jsonb',
  'json',
  'bytea',
  'char(1)',
  'inet',
  'cidr',
  'macaddr',
  'money',
  'text[]',
  'integer[]',
  'bigint[]',
  'uuid[]',
  'tsvector',
  'xml',
  'point',
  'int4range',
  'tstzrange',
];

const TYPE_CHARS = /^[A-Za-z0-9_ ."(),[\]]+$/;

/**
 * Validate a type expression (`varchar(20)`, `numeric(10, 2)`,
 * `timestamp(3) with time zone`, `public."My Enum"[]`). Returns it
 * trimmed with runs of spaces collapsed outside quotes.
 */
export function checkType(type: string): string {
  const t = (type ?? '').trim().replace(/\s+/g, ' ');
  if (!t) throw new DdlError('Type is empty');
  if (!TYPE_CHARS.test(t)) throw new DdlError(`"${t}" is not a valid type`);
  if ((t.match(/"/g) ?? []).length % 2 !== 0) throw new DdlError(`"${t}" has an unclosed quote`);
  // Outside quoted parts, parentheses may only hold numbers (typmods).
  const unquoted = t.replace(/"(?:[^"]|"")*"/g, 'x');
  let depth = 0;
  for (const ch of unquoted) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth < 0 || depth > 1) throw new DdlError(`"${t}" has unbalanced parentheses`);
  }
  if (depth !== 0) throw new DdlError(`"${t}" has unbalanced parentheses`);
  for (const m of unquoted.matchAll(/\(([^)]*)\)/g)) {
    if (!/^\s*\d+\s*(,\s*-?\d+\s*)?$/.test(m[1] ?? '')) {
      throw new DdlError(`"${t}" has an invalid modifier (${m[1]})`);
    }
  }
  if (!/^[A-Za-z_"]/.test(t)) throw new DdlError(`"${t}" is not a valid type`);
  return t;
}

const TEXTISH = /^(text|varchar|character varying|char|character|bpchar|citext|name)\b/i;
const NUMERIC_TYPE =
  /^(smallint|integer|int|int2|int4|int8|bigint|numeric|decimal|real|float4|float8|double precision|serial|bigserial|smallserial|money)\b/i;

/** Rough category of a type, for USING hints and default handling. */
export function typeCategory(
  type: string,
): 'text' | 'number' | 'boolean' | 'datetime' | 'json' | 'uuid' | 'other' {
  const t = type.trim().toLowerCase();
  if (t.endsWith(']')) return 'other';
  if (TEXTISH.test(t)) return 'text';
  if (NUMERIC_TYPE.test(t)) return 'number';
  if (/^(bool|boolean)\b/.test(t)) return 'boolean';
  if (/^(date|time|timestamp|timestamptz|timetz|interval)\b/.test(t)) return 'datetime';
  if (/^jsonb?\b/.test(t)) return 'json';
  if (t === 'uuid') return 'uuid';
  return 'other';
}

/** Strip a typmod so `varchar(10)` and `varchar(20)` compare equal. */
function baseType(type: string): string {
  return type
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A `USING` expression to suggest when changing `column` from `fromType`
 * to `toType`, or null when Postgres converts implicitly (same family,
 * or anything → text).
 */
export function suggestUsing(column: string, fromType: string, toType: string): string | null {
  const from = typeCategory(fromType);
  const to = typeCategory(toType);
  if (baseType(fromType) === baseType(toType)) return null;
  if (to === 'text') return null;
  if (from === to && from !== 'other') return null;
  return `${quoteIdent(column)}::${checkType(toType)}`;
}

// ─── expressions ─────────────────────────────────────────────────────

/**
 * Validate a raw SQL expression (default, CHECK, WHERE, USING). It stays
 * raw — this is the user's own SQL — but it must be one expression: no
 * top-level `;`, no comments, balanced quotes and parentheses.
 */
export function checkExpression(expr: string, what = 'Expression'): string {
  const e = (expr ?? '').trim();
  if (!e) throw new DdlError(`${what} is empty`);
  let depth = 0;
  for (let i = 0; i < e.length; i++) {
    const ch = e[i];
    const next = e[i + 1];
    if (ch === "'" || ch === '"') {
      const close = e.indexOf(ch, i + 1);
      let j = close;
      // Doubled quotes are escapes inside the literal.
      while (j !== -1 && e[j + 1] === ch) j = e.indexOf(ch, j + 2);
      if (j === -1)
        throw new DdlError(`${what} has an unclosed ${ch === "'" ? 'string' : 'quote'}`);
      i = j;
      continue;
    }
    if (ch === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(e.slice(i));
      if (tag) {
        const end = e.indexOf(tag[0], i + tag[0].length);
        if (end === -1) throw new DdlError(`${what} has an unclosed $-quoted string`);
        i = end + tag[0].length - 1;
        continue;
      }
    }
    if ((ch === '-' && next === '-') || (ch === '/' && next === '*')) {
      throw new DdlError(`${what} must not contain comments`);
    }
    if (ch === ';') throw new DdlError(`${what} must be a single expression (no ";")`);
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth < 0) throw new DdlError(`${what} has unbalanced parentheses`);
  }
  if (depth !== 0) throw new DdlError(`${what} has unbalanced parentheses`);
  return e;
}

const EXPRESSION_LIKE =
  /^(null|true|false|default|current_date|current_time|current_timestamp|localtime|localtimestamp|current_user|session_user)$/i;

/**
 * Turn what the user typed in a Default field into SQL. Things that are
 * already SQL — numbers, `NULL`/`TRUE`/`FALSE`, quoted strings, function
 * calls (`now()`), casts (`'x'::text`), `CURRENT_TIMESTAMP` — pass
 * through. Bare words on a text-like column become a string literal, so
 * typing `active` for a varchar default does what the user meant.
 */
export function normalizeDefault(input: string, type: string): string {
  const raw = (input ?? '').trim();
  if (!raw) throw new DdlError('Default is empty');
  if (EXPRESSION_LIKE.test(raw)) return raw;
  if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(raw)) return raw;
  if (/^'.*'$/s.test(raw) || raw.includes('(') || raw.includes('::')) {
    return checkExpression(raw, 'Default');
  }
  if (
    typeCategory(type) === 'text' ||
    typeCategory(type) === 'datetime' ||
    typeCategory(type) === 'uuid' ||
    typeCategory(type) === 'json'
  ) {
    return quoteLiteral(raw);
  }
  return checkExpression(raw, 'Default');
}

// ─── columns ─────────────────────────────────────────────────────────

export interface ColumnSpec {
  name: string;
  type: string;
  nullable: boolean;
  /** Raw default as typed; normalised with `normalizeDefault`. */
  default?: string | null;
  primaryKey?: boolean;
  unique?: boolean;
  comment?: string | null;
}

/** `name type [NOT NULL] [DEFAULT …] [UNIQUE]` (PK is table-level). */
export function columnDefinitionSql(col: ColumnSpec, opts?: { inlineUnique?: boolean }): string {
  const parts = [quoteIdent(checkIdent(col.name, 'Column name')), checkType(col.type)];
  if (!col.nullable || col.primaryKey) parts.push('NOT NULL');
  if (col.default != null && col.default.trim() !== '') {
    parts.push(`DEFAULT ${normalizeDefault(col.default, col.type)}`);
  }
  if (opts?.inlineUnique && col.unique && !col.primaryKey) parts.push('UNIQUE');
  return parts.join(' ');
}

function columnList(columns: readonly string[], what = 'column'): string {
  if (columns.length === 0) throw new DdlError(`Pick at least one ${what}`);
  return columns.map((c) => quoteIdent(checkIdent(c, 'Column name'))).join(', ');
}

// ─── constraints & indexes ───────────────────────────────────────────

export const FK_ACTIONS = ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'] as const;
export type FkAction = (typeof FK_ACTIONS)[number];

export type ConstraintSpec =
  | { type: 'primary'; name?: string; columns: string[] }
  | { type: 'unique'; name?: string; columns: string[] }
  | { type: 'check'; name?: string; expression: string }
  | {
      type: 'foreign';
      name?: string;
      columns: string[];
      refSchema: string;
      refTable: string;
      refColumns: string[];
      onDelete?: FkAction;
      onUpdate?: FkAction;
    };

/** Constraint body as used in CREATE TABLE and ALTER TABLE … ADD. */
export function constraintSql(c: ConstraintSpec): string {
  const named = c.name?.trim()
    ? `CONSTRAINT ${quoteIdent(checkIdent(c.name.trim(), 'Constraint name'))} `
    : '';
  switch (c.type) {
    case 'primary':
      return `${named}PRIMARY KEY (${columnList(c.columns)})`;
    case 'unique':
      return `${named}UNIQUE (${columnList(c.columns)})`;
    case 'check':
      return `${named}CHECK (${checkExpression(c.expression, 'Check expression')})`;
    case 'foreign': {
      if (c.refColumns.length !== c.columns.length) {
        throw new DdlError('Foreign key needs the same number of local and referenced columns');
      }
      let sql = `${named}FOREIGN KEY (${columnList(c.columns)}) REFERENCES ${qualifiedName(
        checkIdent(c.refSchema, 'Referenced schema'),
        checkIdent(c.refTable, 'Referenced table'),
      )} (${columnList(c.refColumns, 'referenced column')})`;
      for (const [clause, action] of [
        ['ON UPDATE', c.onUpdate],
        ['ON DELETE', c.onDelete],
      ] as const) {
        if (!action || action === 'NO ACTION') continue;
        if (!FK_ACTIONS.includes(action)) throw new DdlError(`Unknown action ${action}`);
        sql += ` ${clause} ${action}`;
      }
      return sql;
    }
  }
}

export const INDEX_METHODS = ['btree', 'hash', 'gist', 'gin', 'brin', 'spgist'] as const;
export type IndexMethod = (typeof INDEX_METHODS)[number];

export interface IndexSpec {
  name?: string;
  columns: string[];
  unique?: boolean;
  method?: IndexMethod;
  /** Partial index predicate (without WHERE). */
  where?: string;
  concurrently?: boolean;
}

export function createIndexSql(schema: string, table: string, idx: IndexSpec): string {
  const method = idx.method ?? 'btree';
  if (!INDEX_METHODS.includes(method)) throw new DdlError(`Unknown index method ${method}`);
  if (idx.unique && method !== 'btree') throw new DdlError('Only btree indexes can be unique');
  let sql = `CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX ${idx.concurrently ? 'CONCURRENTLY ' : ''}`;
  if (idx.name?.trim()) sql += `${quoteIdent(checkIdent(idx.name.trim(), 'Index name'))} `;
  sql += `ON ${qualifiedName(schema, table)}`;
  if (method !== 'btree') sql += ` USING ${method}`;
  sql += ` (${columnList(idx.columns)})`;
  if (idx.where?.trim()) sql += ` WHERE ${checkExpression(idx.where, 'Index condition')}`;
  return sql;
}

// ─── CREATE TABLE / VIEW ─────────────────────────────────────────────

export interface CreateTableSpec {
  schema: string;
  name: string;
  columns: ColumnSpec[];
  constraints?: ConstraintSpec[];
  ifNotExists?: boolean;
  comment?: string | null;
}

/** CREATE TABLE plus COMMENT ON statements, one string per statement. */
export function buildCreateTable(spec: CreateTableSpec): string[] {
  checkIdent(spec.schema, 'Schema');
  checkIdent(spec.name, 'Table name');
  if (spec.columns.length === 0) throw new DdlError('Add at least one column');
  const seen = new Set<string>();
  for (const c of spec.columns) {
    checkIdent(c.name, 'Column name');
    if (seen.has(c.name)) throw new DdlError(`Column "${c.name}" appears twice`);
    seen.add(c.name);
  }
  const table = qualifiedName(spec.schema, spec.name);
  const lines = spec.columns.map((c) => `  ${columnDefinitionSql(c, { inlineUnique: true })}`);
  const pk = spec.columns.filter((c) => c.primaryKey).map((c) => c.name);
  const constraints = [...(spec.constraints ?? [])];
  if (pk.length > 0 && !constraints.some((c) => c.type === 'primary')) {
    constraints.unshift({ type: 'primary', columns: pk });
  }
  for (const c of constraints) lines.push(`  ${constraintSql(c)}`);
  const out = [
    `CREATE TABLE ${spec.ifNotExists ? 'IF NOT EXISTS ' : ''}${table} (\n${lines.join(',\n')}\n)`,
  ];
  if (spec.comment?.trim()) out.push(`COMMENT ON TABLE ${table} IS ${quoteLiteral(spec.comment)}`);
  for (const c of spec.columns) {
    if (c.comment?.trim()) {
      out.push(`COMMENT ON COLUMN ${table}.${quoteIdent(c.name)} IS ${quoteLiteral(c.comment)}`);
    }
  }
  return out;
}

export interface CreateViewSpec {
  schema: string;
  name: string;
  query: string;
  materialized?: boolean;
  orReplace?: boolean;
  /** Materialized only: WITH NO DATA. */
  withNoData?: boolean;
}

export function buildCreateView(spec: CreateViewSpec): string {
  const query = (spec.query ?? '').trim().replace(/;\s*$/, '');
  if (!query) throw new DdlError('The view needs a query');
  if (!/^(select|with|values|table)\b/i.test(query)) {
    throw new DdlError('The view query must start with SELECT, WITH, VALUES or TABLE');
  }
  if (spec.materialized && spec.orReplace) {
    throw new DdlError('Materialized views cannot use OR REPLACE');
  }
  const target = qualifiedName(
    checkIdent(spec.schema, 'Schema'),
    checkIdent(spec.name, 'View name'),
  );
  const head = spec.materialized
    ? 'CREATE MATERIALIZED VIEW'
    : `CREATE ${spec.orReplace ? 'OR REPLACE ' : ''}VIEW`;
  return `${head} ${target} AS\n${query}${spec.materialized && spec.withNoData ? '\nWITH NO DATA' : ''}`;
}

// ─── staged structure changes (ALTER TABLE) ──────────────────────────

export type StructureChange =
  | { kind: 'addColumn'; column: ColumnSpec }
  | { kind: 'dropColumn'; name: string; cascade?: boolean }
  | { kind: 'renameColumn'; from: string; to: string }
  | { kind: 'alterType'; name: string; type: string; using?: string | null }
  | { kind: 'setDefault'; name: string; type: string; default: string | null }
  | { kind: 'setNullable'; name: string; nullable: boolean }
  | { kind: 'setComment'; name: string; comment: string | null }
  | { kind: 'addIndex'; index: IndexSpec }
  | { kind: 'dropIndex'; schema: string; name: string; concurrently?: boolean; cascade?: boolean }
  | { kind: 'addConstraint'; constraint: ConstraintSpec }
  | { kind: 'dropConstraint'; name: string; cascade?: boolean };

/** SQL for one staged change (may be several statements). */
export function changeStatements(schema: string, table: string, ch: StructureChange): string[] {
  const t = qualifiedName(schema, table);
  const alter = `ALTER TABLE ${t}`;
  switch (ch.kind) {
    case 'addColumn': {
      const c = ch.column;
      const out = [`${alter} ADD COLUMN ${columnDefinitionSql(c, { inlineUnique: true })}`];
      if (c.primaryKey) out.push(`${alter} ADD PRIMARY KEY (${quoteIdent(c.name)})`);
      if (c.comment?.trim()) {
        out.push(`COMMENT ON COLUMN ${t}.${quoteIdent(c.name)} IS ${quoteLiteral(c.comment)}`);
      }
      return out;
    }
    case 'dropColumn':
      return [`${alter} DROP COLUMN ${quoteIdent(ch.name)}${ch.cascade ? ' CASCADE' : ''}`];
    case 'renameColumn':
      if (ch.from === ch.to) return [];
      return [
        `${alter} RENAME COLUMN ${quoteIdent(ch.from)} TO ${quoteIdent(checkIdent(ch.to, 'Column name'))}`,
      ];
    case 'alterType': {
      const type = checkType(ch.type);
      const using = ch.using?.trim()
        ? ` USING ${checkExpression(ch.using, 'USING expression')}`
        : '';
      return [`${alter} ALTER COLUMN ${quoteIdent(ch.name)} TYPE ${type}${using}`];
    }
    case 'setDefault':
      return [
        ch.default == null || ch.default.trim() === ''
          ? `${alter} ALTER COLUMN ${quoteIdent(ch.name)} DROP DEFAULT`
          : `${alter} ALTER COLUMN ${quoteIdent(ch.name)} SET DEFAULT ${normalizeDefault(ch.default, ch.type)}`,
      ];
    case 'setNullable':
      return [
        `${alter} ALTER COLUMN ${quoteIdent(ch.name)} ${ch.nullable ? 'DROP' : 'SET'} NOT NULL`,
      ];
    case 'setComment':
      return [
        `COMMENT ON COLUMN ${t}.${quoteIdent(ch.name)} IS ${
          ch.comment?.trim() ? quoteLiteral(ch.comment) : 'NULL'
        }`,
      ];
    case 'addIndex':
      return [createIndexSql(schema, table, ch.index)];
    case 'dropIndex':
      return [
        `DROP INDEX ${ch.concurrently ? 'CONCURRENTLY ' : ''}${qualifiedName(ch.schema, ch.name)}${
          ch.cascade && !ch.concurrently ? ' CASCADE' : ''
        }`,
      ];
    case 'addConstraint':
      return [`${alter} ADD ${constraintSql(ch.constraint)}`];
    case 'dropConstraint':
      return [`${alter} DROP CONSTRAINT ${quoteIdent(ch.name)}${ch.cascade ? ' CASCADE' : ''}`];
  }
}

/** True for changes that must run outside a transaction block. */
export function isConcurrentChange(ch: StructureChange): boolean {
  return (
    (ch.kind === 'addIndex' && ch.index.concurrently === true) ||
    (ch.kind === 'dropIndex' && ch.concurrently === true)
  );
}

export interface AlterPlan {
  /** Run together in one transaction. */
  transactional: string[];
  /** CREATE/DROP INDEX CONCURRENTLY — each runs alone, after the transaction. */
  concurrent: string[];
}

/** Turn the staged list into the statements Apply will run, in order. */
export function buildAlterPlan(
  schema: string,
  table: string,
  changes: readonly StructureChange[],
): AlterPlan {
  const plan: AlterPlan = { transactional: [], concurrent: [] };
  for (const ch of changes) {
    const sql = changeStatements(schema, table, ch);
    (isConcurrentChange(ch) ? plan.concurrent : plan.transactional).push(...sql);
  }
  return plan;
}

/** The preview text: statements joined with `;` and a note for CONCURRENTLY. */
export function formatPlan(plan: AlterPlan): string {
  const parts: string[] = [];
  if (plan.transactional.length > 0) {
    parts.push(['BEGIN;', ...plan.transactional.map((s) => `${s};`), 'COMMIT;'].join('\n'));
  }
  if (plan.concurrent.length > 0) {
    parts.push(
      [
        '-- Runs outside the transaction, one statement at a time:',
        ...plan.concurrent.map((s) => `${s};`),
      ].join('\n'),
    );
  }
  return parts.join('\n\n');
}
