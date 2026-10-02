import {
  type ColumnSpec,
  DdlError,
  type FkAction,
  buildCreateTable,
  checkType,
  columnDefinitionSql,
  constraintSql,
  qualifiedName,
  quoteIdent,
} from '@shared/pg-ddl';
import type { SchemaInfo } from '@shared/protocol';

/**
 * Schema diff + migration script (R-10). Pure: takes two `SchemaInfo`
 * snapshots, returns what changed and the SQL that turns the first into the
 * second.
 *
 * Relations are keyed by kind-aware identity, never by splitting a
 * `schema.name` string (names may contain dots), and every statement uses the
 * right verb for the relation's kind (`DROP VIEW`, not `DROP TABLE`).
 * Snapshots do not carry view bodies, partition bounds, CHECK/UNIQUE
 * constraints or grants, so for those the script says what to copy over
 * instead of inventing SQL.
 */

type Rel = SchemaInfo['tables'][number];
type Col = SchemaInfo['columns'][number];
export type RelKind = Rel['kind'];

export interface RelRef {
  schema: string;
  name: string;
  kind: RelKind;
}

export interface TableChange {
  schema: string;
  table: string;
  kind: RelKind;
  addedCols: Col[];
  droppedCols: Col[];
  typeChanges: Array<{ name: string; from: string; to: string }>;
  nullabilityChanges: Array<{ name: string; from: boolean; to: boolean }>;
}

export interface SchemaDiff {
  addedTables: RelRef[];
  droppedTables: RelRef[];
  /** Same name, different kind (table -> view …): dropped and re-created. */
  kindChanges: Array<{ schema: string; name: string; from: RelKind; to: RelKind }>;
  changes: TableChange[];
}

/** Unambiguous map key: identifiers may contain dots, never a NUL. */
const key = (schema: string, name: string) => `${schema}\u0000${name}`;

export function computeDiff(a: SchemaInfo, b: SchemaInfo): SchemaDiff {
  const aRels = new Map(a.tables.map((t) => [key(t.schema, t.name), t]));
  const bRels = new Map(b.tables.map((t) => [key(t.schema, t.name), t]));

  const addedTables: RelRef[] = [];
  const droppedTables: RelRef[] = [];
  const kindChanges: SchemaDiff['kindChanges'] = [];
  for (const [k, t] of bRels) {
    const old = aRels.get(k);
    if (!old) addedTables.push({ schema: t.schema, name: t.name, kind: t.kind });
    else if (old.kind !== t.kind) {
      kindChanges.push({ schema: t.schema, name: t.name, from: old.kind, to: t.kind });
    }
  }
  for (const [k, t] of aRels) {
    if (!bRels.has(k)) droppedTables.push({ schema: t.schema, name: t.name, kind: t.kind });
  }

  const aCols = groupCols(a);
  const bCols = groupCols(b);
  const changes: TableChange[] = [];
  for (const [k, newer] of bRels) {
    const older = aRels.get(k);
    if (!older || older.kind !== newer.kind) continue; // handled above
    const before = aCols.get(k) ?? [];
    const after = bCols.get(k) ?? [];
    const beforeByName = new Map(before.map((c) => [c.name, c]));
    const afterByName = new Map(after.map((c) => [c.name, c]));
    const change: TableChange = {
      schema: newer.schema,
      table: newer.name,
      kind: newer.kind,
      addedCols: after.filter((c) => !beforeByName.has(c.name)),
      droppedCols: before.filter((c) => !afterByName.has(c.name)),
      typeChanges: [],
      nullabilityChanges: [],
    };
    for (const col of before) {
      const next = afterByName.get(col.name);
      if (!next) continue;
      if (next.dataType !== col.dataType) {
        change.typeChanges.push({ name: col.name, from: col.dataType, to: next.dataType });
      }
      if (next.isNullable !== col.isNullable) {
        change.nullabilityChanges.push({
          name: col.name,
          from: col.isNullable,
          to: next.isNullable,
        });
      }
    }
    if (
      change.addedCols.length ||
      change.droppedCols.length ||
      change.typeChanges.length ||
      change.nullabilityChanges.length
    ) {
      changes.push(change);
    }
  }
  return { addedTables, droppedTables, kindChanges, changes };
}

function groupCols(s: SchemaInfo): Map<string, Col[]> {
  const m = new Map<string, Col[]>();
  for (const c of s.columns) {
    const k = key(c.schema, c.table);
    const arr = m.get(k) ?? [];
    arr.push(c);
    m.set(k, arr);
  }
  for (const arr of m.values()) arr.sort((x, y) => x.ordinal - y.ordinal);
  return m;
}

export function summary(d: SchemaDiff): string {
  const parts: string[] = [];
  const count = (rels: RelRef[], verb: '+' | '-') => {
    const tables = rels.filter((r) => r.kind === 'table' || r.kind === 'partitioned').length;
    const views = rels.filter((r) => r.kind === 'view' || r.kind === 'matview').length;
    const other = rels.length - tables - views;
    if (tables) parts.push(`${verb}${tables} table${tables === 1 ? '' : 's'}`);
    if (views) parts.push(`${verb}${views} view${views === 1 ? '' : 's'}`);
    if (other) parts.push(`${verb}${other} other`);
  };
  count(d.addedTables, '+');
  count(d.droppedTables, '-');
  if (d.kindChanges.length) parts.push(`${d.kindChanges.length} changed kind`);
  if (d.changes.length) parts.push(`${d.changes.length} altered`);
  return parts.length ? parts.join(' · ') : 'no changes';
}

// ─── migration SQL ───────────────────────────────────────────────────

const rel = (schema: string, name: string) => qualifiedName(schema, name);

function dropStatement(r: { schema: string; name: string; kind: RelKind }): string {
  const target = rel(r.schema, r.name);
  switch (r.kind) {
    case 'view':
      return `DROP VIEW ${target};`;
    case 'matview':
      return `DROP MATERIALIZED VIEW ${target};`;
    case 'foreign':
      return `DROP FOREIGN TABLE ${target};`;
    default:
      return `DROP TABLE ${target};`;
  }
}

const SERIAL_FOR: Record<string, string> = {
  smallint: 'smallserial',
  integer: 'serial',
  bigint: 'bigserial',
};

function toColumnSpec(c: Col): ColumnSpec {
  let type = c.dataType;
  let def: string | null = c.defaultExpr ?? null;
  // `nextval('t_id_seq'::regclass)` would reference a sequence that doesn't
  // exist yet: the serial pseudo-types create it.
  if (def && /^nextval\(/i.test(def) && SERIAL_FOR[type]) {
    type = SERIAL_FOR[type]!;
    def = null;
  }
  const spec: ColumnSpec = {
    name: c.name,
    type,
    nullable: c.isNullable,
    default: c.identity ? null : def,
    primaryKey: false,
  };
  return spec;
}

function createTableStatements(
  r: RelRef,
  schema: SchemaInfo,
  cols: Col[],
): { create: string[]; foreignKeys: string[]; indexes: string[] } {
  const pk = cols.filter((c) => c.isPrimaryKey).map((c) => c.name);
  const specs = cols.map(toColumnSpec);
  const create = buildCreateTable({
    schema: r.schema,
    name: r.name,
    columns: specs,
    constraints: pk.length > 0 ? [{ type: 'primary', columns: pk }] : [],
  });
  // Identity columns: buildCreateTable has no identity support, so patch the
  // column line (type, then NOT NULL, then the identity clause).
  const identityCols = cols.filter((c) => c.identity);
  if (identityCols.length > 0 && create[0]) {
    let sql = create[0];
    for (const c of identityCols) {
      const def = columnDefinitionSql(toColumnSpec(c), { inlineUnique: true });
      const clause = c.identity === 'always' ? 'ALWAYS' : 'BY DEFAULT';
      sql = sql.replace(`  ${def}`, `  ${def} GENERATED ${clause} AS IDENTITY`);
    }
    create[0] = sql;
  }

  // Foreign keys go after every CREATE TABLE so creation order doesn't matter.
  const fkRows = schema.foreignKeys.filter((f) => f.schema === r.schema && f.table === r.name);
  const groups = new Map<string, typeof fkRows>();
  fkRows.forEach((f, i) => {
    const g = f.constraint ? `c:${f.constraint}` : `row:${i}`;
    const list = groups.get(g) ?? [];
    list.push(f);
    groups.set(g, list);
  });
  const foreignKeys: string[] = [];
  for (const list of groups.values()) {
    const first = list[0]!;
    foreignKeys.push(
      `ALTER TABLE ${rel(r.schema, r.name)} ADD ${constraintSql({
        type: 'foreign',
        name: first.constraint,
        columns: list.map((f) => f.column),
        refSchema: first.refSchema,
        refTable: first.refTable,
        refColumns: list.map((f) => f.refColumn),
        onDelete: first.onDelete as FkAction | undefined,
        onUpdate: first.onUpdate as FkAction | undefined,
      })};`,
    );
  }

  const indexes = (schema.indexes ?? [])
    .filter((x) => x.schema === r.schema && x.table === r.name && !x.primary)
    .map((x) => `${x.definition.replace(/;\s*$/, '')};`);
  return { create, foreignKeys, indexes };
}

function relationNote(r: RelRef, schema: SchemaInfo): string[] {
  const target = rel(r.schema, r.name);
  const what =
    r.kind === 'view'
      ? 'view'
      : r.kind === 'matview'
        ? 'materialized view'
        : r.kind === 'foreign'
          ? 'foreign table'
          : 'partitioned table';
  const part = schema.tables.find((t) => t.schema === r.schema && t.name === r.name)?.partitionOf;
  if (part) {
    return [
      `-- ${target} is a partition of ${rel(part.schema, part.name)}: attach it with`,
      `--   CREATE TABLE ${target} PARTITION OF ${rel(part.schema, part.name)} FOR VALUES …;  -- bounds are not in snapshots`,
    ];
  }
  return [
    `-- ${what} ${target} was added, but snapshots do not store its definition.`,
    '-- Copy it from the source database (pg_get_viewdef / pg_dump -t) and create it here.',
  ];
}

export function buildMigration(d: SchemaDiff, next: SchemaInfo | null = null): string {
  const empty: SchemaInfo = {
    schemas: [],
    tables: [],
    columns: [],
    foreignKeys: [],
    routines: [],
    sequences: [],
    types: [],
    extensions: [],
  };
  const target = next ?? empty;
  const nextCols = groupCols(target);
  const out: string[] = [];
  const destructive =
    d.droppedTables.length > 0 ||
    d.kindChanges.length > 0 ||
    d.changes.some((c) => c.droppedCols.length > 0 || c.typeChanges.length > 0);
  if (destructive) {
    out.push('-- WARNING: this script drops objects or changes column types and can lose data.');
    out.push('-- Review every statement and run it inside a transaction on a copy first.');
    out.push('');
  }
  const isView = (k: RelKind) => k === 'view' || k === 'matview';

  // 1. Dependent relations first, so dropping/altering what they read can't fail.
  for (const r of d.droppedTables.filter((x) => isView(x.kind))) out.push(dropStatement(r));
  for (const k of d.kindChanges) {
    out.push(dropStatement({ schema: k.schema, name: k.name, kind: k.from }));
  }

  // 2. New relations.
  const fks: string[] = [];
  const idxs: string[] = [];
  for (const r of d.addedTables) {
    out.push(...creationSql(r, target, nextCols, fks, idxs));
  }
  for (const k of d.kindChanges) {
    out.push(
      ...creationSql({ schema: k.schema, name: k.name, kind: k.to }, target, nextCols, fks, idxs),
    );
  }

  // 3. Column-level changes (tables and foreign tables only; views are rebuilt).
  for (const c of d.changes) {
    const at = rel(c.schema, c.table);
    if (isView(c.kind)) {
      const bits = [
        ...c.addedCols.map((x) => `+${x.name}`),
        ...c.droppedCols.map((x) => `-${x.name}`),
        ...c.typeChanges.map((x) => `~${x.name}`),
      ];
      out.push(
        `-- ${c.kind === 'matview' ? 'materialized view' : 'view'} ${at} changed (${bits.join(', ')}): re-create it from its new definition.`,
      );
      continue;
    }
    const alter = c.kind === 'foreign' ? 'ALTER FOREIGN TABLE' : 'ALTER TABLE';
    for (const a of c.addedCols) {
      const spec = toColumnSpec(a);
      out.push(`${alter} ${at} ADD COLUMN ${columnDefinitionSql(spec)};`);
    }
    for (const x of c.droppedCols) out.push(`${alter} ${at} DROP COLUMN ${quoteIdent(x.name)};`);
    for (const tc of c.typeChanges) {
      out.push(
        `${alter} ${at} ALTER COLUMN ${quoteIdent(tc.name)} TYPE ${checkTypeOrRaw(tc.to)}; -- was ${tc.from}`,
      );
    }
    for (const nc of c.nullabilityChanges) {
      out.push(
        `${alter} ${at} ALTER COLUMN ${quoteIdent(nc.name)} ${nc.to ? 'DROP NOT NULL' : 'SET NOT NULL'};`,
      );
    }
  }

  // 4. Constraints and indexes of the new tables, then 5. dropped tables.
  out.push(...fks, ...idxs);
  for (const r of d.droppedTables.filter((x) => !isView(x.kind))) out.push(dropStatement(r));
  return out.length ? out.join('\n') : '-- no changes';
}

function checkTypeOrRaw(type: string): string {
  try {
    return checkType(type);
  } catch {
    return type;
  }
}

function creationSql(
  r: RelRef,
  schema: SchemaInfo,
  colsByRel: Map<string, Col[]>,
  fks: string[],
  idxs: string[],
): string[] {
  const isPartitionChild = Boolean(
    schema.tables.find((t) => t.schema === r.schema && t.name === r.name)?.partitionOf,
  );
  if (r.kind !== 'table' || isPartitionChild) return relationNote(r, schema);
  const cols = colsByRel.get(key(r.schema, r.name)) ?? [];
  if (cols.length === 0) {
    return [
      `-- ${rel(r.schema, r.name)}: no columns in the snapshot, cannot generate CREATE TABLE.`,
    ];
  }
  try {
    const built = createTableStatements(r, schema, cols);
    fks.push(...built.foreignKeys);
    idxs.push(...built.indexes);
    return built.create.map((s) => `${s};`);
  } catch (err) {
    const msg = err instanceof DdlError || err instanceof Error ? err.message : String(err);
    return [`-- ${rel(r.schema, r.name)}: could not generate CREATE TABLE (${msg}).`];
  }
}
