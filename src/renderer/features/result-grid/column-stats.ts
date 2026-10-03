/**
 * Quick per-column statistics for the selected range (pure): count and null
 * count for every column; sum / average / min / max for numeric columns;
 * min / max for date-like columns (ISO text sorts chronologically).
 */
export interface ColumnStat {
  /** Original column index. */
  col: number;
  name: string;
  /** Cells in the range for this column. */
  cells: number;
  /** Non-NULL cells. */
  count: number;
  nulls: number;
  numeric: boolean;
  /** Numeric columns: how many non-NULL cells parsed as finite numbers. */
  numericCount: number;
  sum?: number;
  avg?: number;
  min?: number | string;
  max?: number | string;
}

const NUMERIC_TYPES = new Set([
  'int2',
  'int4',
  'int8',
  'float4',
  'float8',
  'numeric',
  'smallint',
  'integer',
  'bigint',
  'real',
  'double precision',
  'decimal',
  'oid',
  // SQLite / MySQL spellings
  'int',
  'tinyint',
  'mediumint',
  'float',
  'double',
  'number',
]);

const TEMPORAL_TYPES = new Set(['date', 'timestamp', 'timestamptz', 'time', 'timetz']);

function baseType(typeName: string | null | undefined): string {
  return (typeName ?? '')
    .replace(/\(.*\)/, '')
    .toLowerCase()
    .replace(/\s+(unsigned|signed|zerofill)\b/g, '') // MySQL modifiers
    .trim();
}

export function isNumericTypeName(typeName: string | null | undefined): boolean {
  return NUMERIC_TYPES.has(baseType(typeName));
}

export function isTemporalTypeName(typeName: string | null | undefined): boolean {
  return TEMPORAL_TYPES.has(baseType(typeName));
}

export interface StatColumn {
  col: number;
  name: string;
  typeName: string;
}

/**
 * Stats for `columns` over display rows `r0..r1`. `textAt` returns the cell's
 * Postgres text (null = NULL, undefined = DEFAULT placeholder: ignored).
 */
export function computeColumnStats(
  columns: readonly StatColumn[],
  r0: number,
  r1: number,
  textAt: (row: number, col: number) => string | null | undefined,
): ColumnStat[] {
  return columns.map(({ col, name, typeName }) => {
    const numeric = isNumericTypeName(typeName);
    const temporal = isTemporalTypeName(typeName);
    let cells = 0;
    let count = 0;
    let nulls = 0;
    let numericCount = 0;
    let sum = 0;
    let min: number | string | undefined;
    let max: number | string | undefined;
    for (let r = r0; r <= r1; r++) {
      const t = textAt(r, col);
      if (t === undefined) continue;
      cells++;
      if (t === null) {
        nulls++;
        continue;
      }
      count++;
      if (numeric) {
        const n = Number(t);
        if (t.trim() === '' || !Number.isFinite(n)) continue;
        numericCount++;
        sum += n;
        if (min === undefined || n < (min as number)) min = n;
        if (max === undefined || n > (max as number)) max = n;
      } else if (temporal) {
        if (min === undefined || t < (min as string)) min = t;
        if (max === undefined || t > (max as string)) max = t;
      }
    }
    const stat: ColumnStat = { col, name, cells, count, nulls, numeric, numericCount };
    if (numeric && numericCount > 0) {
      stat.sum = sum;
      stat.avg = sum / numericCount;
    }
    if (min !== undefined) stat.min = min;
    if (max !== undefined) stat.max = max;
    return stat;
  });
}

/** 1,234 · 12.5 · 0.3333 (at most 4 decimals, float noise trimmed). */
export function formatStatNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return Number(n.toFixed(4)).toLocaleString('en-US', { maximumFractionDigits: 4 });
}

function formatBound(v: number | string): string {
  return typeof v === 'number' ? formatStatNumber(v) : v;
}

/** One-line summary: `price  count 12 · sum 340.5 · avg 28.375 · min 1 · max 99`. */
export function formatStatLine(s: ColumnStat): string {
  const parts = [`count ${s.count.toLocaleString('en-US')}`];
  if (s.nulls > 0) parts.push(`null ${s.nulls.toLocaleString('en-US')}`);
  if (s.sum !== undefined) parts.push(`sum ${formatStatNumber(s.sum)}`);
  if (s.avg !== undefined) parts.push(`avg ${formatStatNumber(s.avg)}`);
  if (s.min !== undefined) parts.push(`min ${formatBound(s.min)}`);
  if (s.max !== undefined) parts.push(`max ${formatBound(s.max)}`);
  return parts.join(' · ');
}
