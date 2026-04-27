/**
 * Postgres type → category bucket → operator set. The Filter popover uses
 * this to narrow operators by column type so e.g. picking a `numeric`
 * column doesn't offer ILIKE.
 */

import type { FilterOp } from './table-query';

export type PgTypeCategory =
  | 'numeric'
  | 'text'
  | 'bool'
  | 'date'
  | 'json'
  | 'uuid'
  | 'array'
  | 'other';

const NUMERIC = new Set([
  'int2',
  'int4',
  'int8',
  'float4',
  'float8',
  'numeric',
  'money',
  'smallint',
  'integer',
  'bigint',
  'real',
  'double precision',
  'decimal',
]);

const TEXT = new Set([
  'text',
  'varchar',
  'character varying',
  'character',
  'char',
  'bpchar',
  'name',
  'citext',
]);

const DATE = new Set([
  'date',
  'time',
  'timetz',
  'timestamp',
  'timestamptz',
  'timestamp without time zone',
  'timestamp with time zone',
  'time without time zone',
  'time with time zone',
  'interval',
]);

const JSONLIKE = new Set(['json', 'jsonb']);
const BOOLLIKE = new Set(['bool', 'boolean']);
const UUIDLIKE = new Set(['uuid']);

export function categorize(dataTypeName: string | undefined | null): PgTypeCategory {
  if (!dataTypeName) return 'other';
  // Strip pg's `varchar(50)` / `numeric(10,2)` decoration before bucketing.
  const base = dataTypeName
    .replace(/\(.*\)/, '')
    .trim()
    .toLowerCase();
  if (base.endsWith('[]')) return 'array';
  if (NUMERIC.has(base)) return 'numeric';
  if (TEXT.has(base)) return 'text';
  if (DATE.has(base)) return 'date';
  if (JSONLIKE.has(base)) return 'json';
  if (BOOLLIKE.has(base)) return 'bool';
  if (UUIDLIKE.has(base)) return 'uuid';
  return 'other';
}

const COMPARISON: Array<{ value: FilterOp; label: string }> = [
  { value: '=', label: '=' },
  { value: '!=', label: '!=' },
  { value: '>', label: '>' },
  { value: '<', label: '<' },
  { value: '>=', label: '>=' },
  { value: '<=', label: '<=' },
];

const NULLABILITY: Array<{ value: FilterOp; label: string }> = [
  { value: 'IS NULL', label: 'is null' },
  { value: 'IS NOT NULL', label: 'is not null' },
];

const PATTERN: Array<{ value: FilterOp; label: string }> = [
  { value: 'ILIKE', label: 'contains (ILIKE)' },
  { value: 'LIKE', label: 'matches (LIKE)' },
];

export interface OperatorGroup {
  heading: string;
  operators: Array<{ value: FilterOp; label: string }>;
}

/** Returns operator groups appropriate for the given pg type. */
export function operatorsFor(dataTypeName: string | undefined | null): OperatorGroup[] {
  const cat = categorize(dataTypeName);
  switch (cat) {
    case 'numeric':
    case 'date':
    case 'uuid':
      return [
        { heading: 'Comparison', operators: COMPARISON },
        { heading: 'Nullability', operators: NULLABILITY },
      ];
    case 'text':
    case 'json':
      return [
        { heading: 'Comparison', operators: [COMPARISON[0], COMPARISON[1]] },
        { heading: 'Pattern matching', operators: PATTERN },
        { heading: 'Nullability', operators: NULLABILITY },
      ];
    case 'bool':
      return [
        { heading: 'Comparison', operators: [COMPARISON[0], COMPARISON[1]] },
        { heading: 'Nullability', operators: NULLABILITY },
      ];
    case 'array':
    case 'other':
    default:
      return [
        { heading: 'Comparison', operators: [COMPARISON[0], COMPARISON[1]] },
        { heading: 'Pattern matching', operators: PATTERN },
        { heading: 'Nullability', operators: NULLABILITY },
      ];
  }
}

/** Default operator for a given type — sensible first pick when filter is opened from a column. */
export function defaultOperatorFor(dataTypeName: string | undefined | null): FilterOp {
  const cat = categorize(dataTypeName);
  if (cat === 'text' || cat === 'json') return 'ILIKE';
  return '=';
}
