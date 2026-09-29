/**
 * SQL script generation for the sidebar context menu (PC2 / PC3):
 * "Copy script as CREATE / DROP / TRUNCATE / SELECT / INSERT" and the
 * DDL shown when opening a function, sequence, type or extension.
 * Pure string builders — the catalog reads live in object-ddl.ts.
 */

/** Words that must be quoted even though they look like plain identifiers. */
const RESERVED = new Set([
  'all',
  'analyse',
  'analyze',
  'and',
  'any',
  'array',
  'as',
  'asc',
  'asymmetric',
  'authorization',
  'binary',
  'both',
  'case',
  'cast',
  'check',
  'collate',
  'collation',
  'column',
  'concurrently',
  'constraint',
  'create',
  'cross',
  'current_catalog',
  'current_date',
  'current_role',
  'current_schema',
  'current_time',
  'current_timestamp',
  'current_user',
  'default',
  'deferrable',
  'desc',
  'distinct',
  'do',
  'else',
  'end',
  'except',
  'false',
  'fetch',
  'for',
  'foreign',
  'freeze',
  'from',
  'full',
  'grant',
  'group',
  'having',
  'ilike',
  'in',
  'initially',
  'inner',
  'intersect',
  'into',
  'is',
  'isnull',
  'join',
  'lateral',
  'leading',
  'left',
  'like',
  'limit',
  'localtime',
  'localtimestamp',
  'natural',
  'not',
  'notnull',
  'null',
  'offset',
  'on',
  'only',
  'or',
  'order',
  'outer',
  'overlaps',
  'placing',
  'primary',
  'references',
  'returning',
  'right',
  'select',
  'session_user',
  'similar',
  'some',
  'symmetric',
  'system_user',
  'table',
  'tablesample',
  'then',
  'to',
  'trailing',
  'true',
  'union',
  'unique',
  'user',
  'using',
  'variadic',
  'verbose',
  'when',
  'where',
  'window',
  'with',
]);

/** Quote an identifier only when Postgres needs it (mixed case, symbols, keywords). */
export function ident(name: string): string {
  if (/^[a-z_][a-z0-9_$]*$/.test(name) && !RESERVED.has(name)) return name;
  return `"${name.replace(/"/g, '""')}"`;
}

export function qualified(schema: string, name: string): string {
  return `${ident(schema)}.${ident(name)}`;
}

/** Always-quoted form, e.g. for `$1::regclass` parameters. */
export function quotedQualified(schema: string, name: string): string {
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  return `${q(schema)}.${q(name)}`;
}

export function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export type RelationKind = 'table' | 'view' | 'matview' | 'foreign' | 'partitioned';

export type DropTarget =
  | { kind: RelationKind | 'sequence'; schema: string; name: string }
  | {
      kind: 'type';
      schema: string;
      name: string;
      typeKind?: 'enum' | 'composite' | 'domain' | 'range';
    }
  | { kind: 'function' | 'procedure'; schema: string; name: string; args: string }
  | { kind: 'extension'; name: string };

const DROP_KEYWORD: Record<RelationKind | 'sequence', string> = {
  table: 'TABLE',
  partitioned: 'TABLE',
  view: 'VIEW',
  matview: 'MATERIALIZED VIEW',
  foreign: 'FOREIGN TABLE',
  sequence: 'SEQUENCE',
};

export function buildDropScript(target: DropTarget, opts: { cascade?: boolean } = {}): string {
  const tail = opts.cascade ? ' CASCADE;' : ';';
  switch (target.kind) {
    case 'extension':
      return `DROP EXTENSION ${ident(target.name)}${tail}`;
    case 'function':
    case 'procedure':
      return `DROP ${target.kind.toUpperCase()} ${qualified(target.schema, target.name)}(${target.args})${tail}`;
    case 'type':
      return `DROP ${target.typeKind === 'domain' ? 'DOMAIN' : 'TYPE'} ${qualified(target.schema, target.name)}${tail}`;
    default:
      return `DROP ${DROP_KEYWORD[target.kind]} ${qualified(target.schema, target.name)}${tail}`;
  }
}

export function buildTruncateScript(
  schema: string,
  name: string,
  opts: { cascade?: boolean; restartIdentity?: boolean } = {},
): string {
  const parts = [`TRUNCATE TABLE ${qualified(schema, name)}`];
  if (opts.restartIdentity) parts.push('RESTART IDENTITY');
  if (opts.cascade) parts.push('CASCADE');
  return `${parts.join(' ')};`;
}

export function buildSelectScript(
  schema: string,
  name: string,
  columns: readonly string[] = [],
  limit = 100,
): string {
  const cols = columns.length > 0 ? columns.map(ident).join(', ') : '*';
  return `SELECT ${cols}\nFROM ${qualified(schema, name)}\nLIMIT ${limit};`;
}

export interface InsertColumn {
  name: string;
  dataType: string;
  hasDefault?: boolean;
}

/**
 * INSERT template with one value per column: DEFAULT where the column
 * has one, NULL otherwise, each annotated with the column type.
 */
export function buildInsertScript(
  schema: string,
  name: string,
  columns: readonly InsertColumn[],
): string {
  const target = qualified(schema, name);
  if (columns.length === 0) return `INSERT INTO ${target} DEFAULT VALUES;`;
  const names = columns.map((c) => ident(c.name)).join(', ');
  const values = columns.map((c, i) => {
    const v = c.hasDefault ? 'DEFAULT' : 'NULL';
    const comma = i < columns.length - 1 ? ',' : '';
    return `  ${v}${comma} -- ${c.name} ${c.dataType}`;
  });
  return `INSERT INTO ${target} (${names})\nVALUES (\n${values.join('\n')}\n);`;
}

/** One row of `buildDefinitionQuerySql` (lib/table-query.ts), all text. */
export interface DefinitionRow {
  kind: 'col' | 'con' | 'idx';
  c1: string;
  c2: string;
  c3: string;
  c4: string;
}

/** CREATE TABLE + constraints + indexes from catalog rows. */
export function composeCreateTable(
  schema: string,
  name: string,
  rows: readonly DefinitionRow[],
): string {
  const target = qualified(schema, name);
  const cols = rows.filter((r) => r.kind === 'col');
  const cons = rows.filter((r) => r.kind === 'con');
  const idxs = rows.filter((r) => r.kind === 'idx');
  const colLines = cols.map((c) => {
    const parts = [`  ${ident(c.c1)} ${c.c2}`];
    if (c.c3) parts.push(c.c3);
    if (c.c4) parts.push(`DEFAULT ${c.c4}`);
    return parts.join(' ');
  });
  const head = `CREATE TABLE ${target} (\n${colLines.join(',\n')}\n);`;
  const consLines = cons.map(
    (c) => `ALTER TABLE ${target}\n  ADD CONSTRAINT ${ident(c.c1)} ${c.c2};`,
  );
  // Constraint-backed indexes come back from pg_indexes too; keep the constraint.
  const consNames = new Set(cons.map((c) => c.c1));
  const idxLines = idxs.filter((i) => !consNames.has(i.c1)).map((i) => `${i.c2};`);
  return [head, ...consLines, ...idxLines].join('\n\n');
}

export function buildCreateViewScript(
  kind: 'view' | 'matview',
  schema: string,
  name: string,
  definition: string,
): string {
  const body = definition.trim().replace(/;\s*$/, '');
  const head =
    kind === 'matview'
      ? `CREATE MATERIALIZED VIEW ${qualified(schema, name)} AS`
      : `CREATE OR REPLACE VIEW ${qualified(schema, name)} AS`;
  return `${head}\n${body};`;
}

export interface SequenceInfo {
  dataType: string;
  start: string;
  increment: string;
  min: string;
  max: string;
  cache: string;
  cycle: boolean;
}

export function buildSequenceDdl(schema: string, name: string, s: SequenceInfo): string {
  return [
    `CREATE SEQUENCE ${qualified(schema, name)}`,
    `  AS ${s.dataType}`,
    `  INCREMENT BY ${s.increment}`,
    `  MINVALUE ${s.min}`,
    `  MAXVALUE ${s.max}`,
    `  START WITH ${s.start}`,
    `  CACHE ${s.cache}`,
    `  ${s.cycle ? 'CYCLE' : 'NO CYCLE'};`,
  ].join('\n');
}

export function buildEnumDdl(schema: string, name: string, values: readonly string[]): string {
  if (values.length === 0) return `CREATE TYPE ${qualified(schema, name)} AS ENUM ();`;
  return `CREATE TYPE ${qualified(schema, name)} AS ENUM (\n${values
    .map((v) => `  ${literal(v)}`)
    .join(',\n')}\n);`;
}

export function buildCompositeDdl(
  schema: string,
  name: string,
  attributes: ReadonlyArray<{ name: string; type: string }>,
): string {
  return `CREATE TYPE ${qualified(schema, name)} AS (\n${attributes
    .map((a) => `  ${ident(a.name)} ${a.type}`)
    .join(',\n')}\n);`;
}

export function buildDomainDdl(
  schema: string,
  name: string,
  d: {
    baseType: string;
    notNull: boolean;
    defaultExpr: string | null;
    constraints: readonly string[];
  },
): string {
  const lines = [`CREATE DOMAIN ${qualified(schema, name)} AS ${d.baseType}`];
  if (d.defaultExpr) lines.push(`  DEFAULT ${d.defaultExpr}`);
  if (d.notNull) lines.push('  NOT NULL');
  for (const c of d.constraints) lines.push(`  ${c}`);
  return `${lines.join('\n')};`;
}

export function buildRangeDdl(schema: string, name: string, subtype: string): string {
  return `CREATE TYPE ${qualified(schema, name)} AS RANGE (\n  SUBTYPE = ${subtype}\n);`;
}

export function buildExtensionDdl(name: string, schema: string, version: string): string {
  return `CREATE EXTENSION IF NOT EXISTS ${ident(name)}\n  WITH SCHEMA ${ident(schema)}\n  VERSION ${literal(version)};`;
}
