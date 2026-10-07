import type { SqlDialect } from './sql-dialect';

/**
 * Concurrent-edit guards for grid commits.
 *
 * A staged UPDATE / DELETE is addressed by primary key, which alone can't tell
 * that someone else changed the row after the grid loaded it. So the WHERE
 * clause also carries the values the user saw ("the original values"):
 *
 *   UPDATE t SET a = $1 WHERE id = $2 AND a IS NOT DISTINCT FROM $3
 *
 * If the row changed (or is gone) the statement matches nothing; the worker
 * sees 0 affected rows for a key that should exist and reports a conflict
 * instead of silently overwriting. Which columns are compared, and how, is
 * decided here so every dialect follows one documented rule:
 *
 *  - an UPDATE compares the columns it changes; a DELETE compares every column
 *    of the row it was staged from. Other columns of an updated row may change
 *    freely: the statement does not touch them;
 *  - values are the grid's text form, bound as parameters and parsed by the
 *    server with the column's own input function (so numbers, dates, uuids,
 *    arrays and bytea compare by value, not by spelling);
 *  - a column is NOT compared when its value is over MAX_GUARD_CHARS, or its
 *    type has no reliable equality (see `planGuard`). The row is still
 *    addressed by key, so such a column keeps last-write-wins behaviour;
 *  - MySQL compares text with the column's collation (so a change of letter
 *    case alone can go unnoticed on a case-insensitive collation).
 */

/** Values longer than this (as text) are not compared: the statement would carry them twice. */
export const MAX_GUARD_CHARS = 64 * 1024;

export type GuardPlan = 'eq' | 'json-cast' | 'skip';

/** One original value to compare. `type` is the result column's `dataTypeName`. */
export interface GuardValue {
  column: string;
  value: string | null;
  type?: string;
  /** The server says this type has no usable `=` (composite, json[], …): never compared. */
  noEquality?: boolean;
}

// Postgres types without an `=` operator (arrays of them included), or whose
// equality is not "same value" (box compares area). Custom types are decided by
// the server (`ColumnMeta.noEquality`).
const PG_SKIP = new Set([
  'jsonpath',
  'pg_snapshot',
  'txid_snapshot',
  'refcursor',
  'xml',
  'point',
  'lseg',
  'box',
  'path',
  'polygon',
  'circle',
  'line',
  'record',
]);
// MySQL / MariaDB: JSON compares as text, floats are inexact, binary is hex text here.
const MYSQL_SKIP =
  /^(json|float|double|real|bit|geometry|point|linestring|polygon|multi\w+|geometrycollection|\w*blob|binary|varbinary)$/;
// SQLite: REAL round-trips as text with a different spelling, blobs arrive as hex text.
const SQLITE_SKIP = /^(real|float|double|double precision|blob|bytea)$/;
// Binary values reach the grid as `\\x…` text whatever the column is declared as.
const HEX_BLOB = /^\\x[0-9a-fA-F]*$/;
// A JSON number that JavaScript cannot hold exactly arrives as a string, so the
// text the grid has is not the text the server holds.
const BIG_JSON_NUMBER = /\d{16,}/;

function parseType(type: string | undefined): { base: string; array: boolean } {
  let t = (type ?? '')
    .toLowerCase()
    .replace(/\(.*\)/, '')
    .trim();
  let array = false;
  if (t.endsWith('[]')) {
    t = t.slice(0, -2);
    array = true;
  } else if (t.startsWith('_')) {
    t = t.slice(1);
    array = true;
  }
  return { base: t, array };
}

/** How (or whether) to compare one original value on `engine`. */
export function planGuard(
  engine: SqlDialect['engine'],
  type: string | undefined,
  value: string | null,
  noEquality?: boolean,
): GuardPlan {
  if (noEquality) return 'skip';
  if (value !== null && value.length > MAX_GUARD_CHARS) return 'skip';
  const { base: t, array } = parseType(type);
  switch (engine) {
    case 'postgres':
      if (PG_SKIP.has(t)) return 'skip';
      if (t === 'json') return array ? 'skip' : 'json-cast';
      if ((t === 'jsonb' || t === 'json') && value !== null && BIG_JSON_NUMBER.test(value)) {
        return 'skip';
      }
      return 'eq';
    case 'mysql':
      if (value !== null && HEX_BLOB.test(value)) return 'skip';
      return MYSQL_SKIP.test(t) ? 'skip' : 'eq';
    case 'sqlite':
      if (value !== null && HEX_BLOB.test(value)) return 'skip';
      return SQLITE_SKIP.test(t) ? 'skip' : 'eq';
    default:
      return 'skip';
  }
}

/** `col` equals the value bound at `placeholder`, NULL-safe, in the dialect's spelling. */
export function guardPredicate(
  dialect: SqlDialect,
  column: string,
  plan: Exclude<GuardPlan, 'skip'>,
  placeholder: string,
): string {
  const col = dialect.quoteIdent(column);
  switch (dialect.engine) {
    case 'mysql':
      return `${col} <=> ${placeholder}`;
    case 'sqlite':
      // INTEGER / NUMERIC affinity converts the bound text; the CAST covers a
      // column with no affinity whose stored value is a number.
      return `(${col} IS ${placeholder} OR CAST(${col} AS TEXT) IS ${placeholder})`;
    default:
      return plan === 'json-cast'
        ? `${col}::jsonb IS NOT DISTINCT FROM ${placeholder}::jsonb`
        : `${col} IS NOT DISTINCT FROM ${placeholder}`;
  }
}

/**
 * The WHERE fragments for a set of original values. `addParam` appends a bind
 * value and returns its placeholder.
 */
export function buildGuardClauses(
  dialect: SqlDialect,
  guards: readonly GuardValue[] | undefined,
  addParam: (value: unknown) => string,
): string[] {
  const out: string[] = [];
  for (const g of guards ?? []) {
    const plan = planGuard(dialect.engine, g.type, g.value, g.noEquality);
    if (plan === 'skip') continue;
    out.push(guardPredicate(dialect, g.column, plan, addParam(g.value)));
  }
  return out;
}
