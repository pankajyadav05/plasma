/**
 * Foreign-key navigation (pure): outgoing FKs for peek / click-through and
 * incoming ("Referenced by") FKs for the reverse drill, plus the SQL behind
 * the per-row reference counts and the FK peek lookup.
 *
 * Introspection yields one `foreignKeys` row per FK column; a composite FK
 * shares its `constraint` name across rows. Everything here groups by
 * constraint so two single-column FKs to the same table (created_by /
 * updated_by) stay separate.
 */
import type { SchemaInfo } from './protocol';
import { POSTGRES_DIALECT, type SqlDialect } from './sql-dialect';

export type ForeignKeyRow = SchemaInfo['foreignKeys'][number];

export interface FkGroup {
  /** `schema.table.constraint` — stable key for caches / React keys. */
  key: string;
  schema: string;
  table: string;
  refSchema: string;
  refTable: string;
  constraint?: string;
  /** child column → parent column, in declaration order. */
  pairs: Array<{ column: string; refColumn: string }>;
}

/** Group per-column rows into one entry per constraint. */
export function groupForeignKeys(fks: readonly ForeignKeyRow[]): FkGroup[] {
  const groups = new Map<string, FkGroup>();
  for (const fk of fks) {
    // Old drivers omit the constraint name: fall back to one group per
    // (table → ref table) edge, which is the best we can do.
    const id = fk.constraint ?? `${fk.refSchema}.${fk.refTable}`;
    const key = `${fk.schema}.${fk.table}.${id}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        schema: fk.schema,
        table: fk.table,
        refSchema: fk.refSchema,
        refTable: fk.refTable,
        constraint: fk.constraint,
        pairs: [],
      };
      groups.set(key, g);
    }
    g.pairs.push({ column: fk.column, refColumn: fk.refColumn });
  }
  return [...groups.values()];
}

/** FKs declared ON this table (its columns reference other tables). */
export function outgoingFks(
  fks: readonly ForeignKeyRow[] | undefined,
  schema: string,
  table: string,
): FkGroup[] {
  return groupForeignKeys((fks ?? []).filter((f) => f.schema === schema && f.table === table));
}

/** FKs in other tables (or this one) that point AT this table. */
export function incomingFks(
  fks: readonly ForeignKeyRow[] | undefined,
  schema: string,
  table: string,
): FkGroup[] {
  return groupForeignKeys(
    (fks ?? []).filter((f) => f.refSchema === schema && f.refTable === table),
  );
}

/** Outgoing FK group by child column (first group wins when a column is in several). */
export function fkByColumnName(groups: readonly FkGroup[]): Map<string, FkGroup> {
  const m = new Map<string, FkGroup>();
  for (const g of groups) for (const p of g.pairs) if (!m.has(p.column)) m.set(p.column, g);
  return m;
}

export interface FkLookup {
  /** Column of the lookup table → Postgres text value to match. */
  match: Array<{ column: string; value: string }>;
}

/**
 * The `column = value` pairs to find rows in a FK's *other* side, read from
 * one row of this table. `direction`:
 *  - 'incoming': row is on the referenced side; match child `column`s against the row's `refColumn` values.
 *  - 'outgoing': row is on the child side; match parent `refColumn`s against the row's `column` values.
 * Returns null when any needed column is missing from the row or NULL
 * (a NULL never matches).
 */
export function lookupForRow(
  group: FkGroup,
  direction: 'incoming' | 'outgoing',
  read: (columnName: string) => string | null | undefined,
): FkLookup | null {
  const match: FkLookup['match'] = [];
  for (const p of group.pairs) {
    const own = direction === 'incoming' ? p.refColumn : p.column;
    const other = direction === 'incoming' ? p.column : p.refColumn;
    const v = read(own);
    if (v === null || v === undefined) return null;
    match.push({ column: other, value: v });
  }
  return match.length > 0 ? { match } : null;
}

/** Counts stop here ("1000+") so a huge child table never gets fully scanned. */
export const INCOMING_COUNT_CAP = 1000;

export interface IncomingCountRequest {
  group: FkGroup;
  lookup: FkLookup;
}

/**
 * One statement counting the referencing rows of every request (capped):
 * `SELECT (SELECT count(*) FROM (SELECT 1 FROM t WHERE c = $1 LIMIT 1001) s), …`.
 */
export function buildIncomingCountSql(
  requests: readonly IncomingCountRequest[],
  d: SqlDialect = POSTGRES_DIALECT,
): {
  sql: string;
  params: string[];
} {
  const params: string[] = [];
  const parts = requests.map(({ group, lookup }) => {
    const where = lookup.match
      .map((m) => {
        params.push(m.value);
        return `${d.quoteIdent(m.column)} = $${params.length}`;
      })
      .join(' AND ');
    return `(SELECT count(*) FROM (SELECT 1 FROM ${d.qualify(group.schema, group.table)} WHERE ${where} LIMIT ${INCOMING_COUNT_CAP + 1}) s)`;
  });
  return { sql: `SELECT ${parts.join(', ')}`, params };
}

export interface IncomingCount {
  /** Number of referencing rows (capped at INCOMING_COUNT_CAP). */
  count: number;
  /** True when the cap was hit: the real number is larger. */
  capped: boolean;
}

/** Read the single result row of {@link buildIncomingCountSql}. */
export function parseIncomingCounts(
  row: readonly unknown[],
  n: number,
): Array<IncomingCount | null> {
  const out: Array<IncomingCount | null> = [];
  for (let i = 0; i < n; i++) {
    const raw = row[i];
    const num = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
    if (!Number.isFinite(num)) {
      out.push(null);
      continue;
    }
    out.push({ count: Math.min(num, INCOMING_COUNT_CAP), capped: num > INCOMING_COUNT_CAP });
  }
  return out;
}

/** "12 rows", "1 row", "1000+ rows". */
export function formatIncomingCount(c: IncomingCount | null | undefined): string {
  if (!c) return '…';
  const n = c.count.toLocaleString('en-US');
  return `${n}${c.capped ? '+' : ''} row${c.count === 1 && !c.capped ? '' : 's'}`;
}

/** "order_items.order_id" (composite keys list every column). */
export function describeIncoming(group: FkGroup): string {
  const cols = group.pairs.map((p) => p.column);
  return `${group.table}.${cols.length === 1 ? cols[0] : `(${cols.join(', ')})`}`;
}

/** SELECT used by the FK peek popover: the one referenced row. */
export function buildPeekSql(
  refSchema: string,
  refTable: string,
  lookup: FkLookup,
  d: SqlDialect = POSTGRES_DIALECT,
): { sql: string; params: string[] } {
  const params: string[] = [];
  const where = lookup.match
    .map((m) => {
      params.push(m.value);
      return `${d.quoteIdent(m.column)} = $${params.length}`;
    })
    .join(' AND ');
  return {
    sql: `SELECT * FROM ${d.qualify(refSchema, refTable)} WHERE ${where} LIMIT 1`,
    params,
  };
}

/**
 * Arguments for `openForeignRow(schema, table, column, value, also)` that
 * open the lookup side filtered to the matching rows.
 */
export function openArgs(
  schema: string,
  table: string,
  lookup: FkLookup,
): {
  schema: string;
  table: string;
  column: string;
  value: string;
  also: Array<{ column: string; value: string }>;
} {
  const [first, ...rest] = lookup.match;
  return { schema, table, column: first!.column, value: first!.value, also: rest };
}

/**
 * Count requests for one row: every incoming FK whose referenced columns are
 * all present (and non-NULL) in the row. `columns` / `row` are the SERVER
 * values of the row (pending edits do not exist in the database yet);
 * `toText` renders a value as its Postgres text (null = NULL).
 */
export function incomingRequestsForRow(
  groups: readonly FkGroup[],
  columns: ReadonlyArray<{ name: string; dataTypeName: string }>,
  row: readonly unknown[],
  toText: (value: unknown, typeName: string) => string | null,
): IncomingCountRequest[] {
  const out: IncomingCountRequest[] = [];
  for (const group of groups) {
    const lookup = lookupForRow(group, 'incoming', (name) => {
      const i = columns.findIndex((c) => c.name === name);
      return i < 0 ? undefined : toText(row[i], columns[i]?.dataTypeName ?? '');
    });
    if (lookup) out.push({ group, lookup });
  }
  return out;
}

/** Cache / React key for a request list. */
export function requestsKey(requests: readonly IncomingCountRequest[]): string {
  return requests
    .map((r) => `${r.group.key}|${r.lookup.match.map((m) => `${m.column}=${m.value}`).join('&')}`)
    .join('\n');
}
