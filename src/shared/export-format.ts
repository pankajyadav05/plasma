import type { ColumnMeta } from './protocol';
import type { SqlDialect } from './sql-dialect';

/**
 * Incremental CSV / JSON / SQL INSERT formatting (U16).
 *
 * Keeps assembly off the renderer hot path: callers stream batches into a
 * sink (file write stream or string collector) without building one giant
 * in-memory string up front.
 */

export type ExportFormat = 'csv' | 'json' | 'sql';

export function exportExtension(format: ExportFormat): string {
  switch (format) {
    case 'csv':
      return 'csv';
    case 'json':
      return 'json';
    case 'sql':
      return 'sql';
  }
}

export function exportMime(format: ExportFormat): string {
  switch (format) {
    case 'csv':
      return 'text/csv;charset=utf-8';
    case 'json':
      return 'application/json;charset=utf-8';
    case 'sql':
      return 'text/plain;charset=utf-8';
  }
}

export type ExportSink = (chunk: string) => void | Promise<void>;

export type ExportStreamer = {
  begin(): void;
  writeRows(rows: readonly unknown[][]): void;
  end(): void;
};

/** UTF-8 BOM so Excel opens CSV correctly. */
export const CSV_BOM = '\uFEFF';

/** CSV dialect (Settings → Data → CSV export). */
export type CsvOptions = {
  delimiter: ',' | ';' | '\t' | '|';
  header: boolean;
  quote: '"' | "'";
  /** How SQL NULL is written: an empty field or the literal `NULL`. */
  nullAs: 'empty' | 'NULL';
  lineEnding: 'lf' | 'crlf';
  /**
   * Prefix cells that start with `= + - @ TAB CR` with `'` so spreadsheets
   * don't run them as formulas (SC-15). On unless explicitly `false`.
   */
  formulaGuard?: boolean;
};

export const DEFAULT_CSV_OPTIONS: CsvOptions = {
  delimiter: ',',
  header: true,
  quote: '"',
  nullAs: 'empty',
  lineEnding: 'crlf',
};

function eol(opts: CsvOptions): string {
  return opts.lineEnding === 'lf' ? '\n' : '\r\n';
}

const FORMULA_START = /^[=+\-@\t\r]/;
/** Plain numbers (Postgres numeric / int8 arrive as strings) are not formulas. */
const PLAIN_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Neutralise a leading formula character (SC-15). */
export function guardFormula(str: string): string {
  return FORMULA_START.test(str) && !PLAIN_NUMBER.test(str) ? `'${str}` : str;
}

export function csvEscape(value: unknown, opts: CsvOptions = DEFAULT_CSV_OPTIONS): string {
  if (value === null || value === undefined) return opts.nullAs === 'NULL' ? 'NULL' : '';
  let str: string;
  if (value instanceof Date) {
    str = value.toISOString();
  } else if (typeof value === 'object') {
    try {
      str = JSON.stringify(value);
    } catch {
      str = String(value);
    }
  } else {
    str = String(value);
  }
  if (typeof value === 'string' && opts.formulaGuard !== false) str = guardFormula(str);
  const q = opts.quote;
  if (str.includes(opts.delimiter) || str.includes(q) || /[\r\n]/.test(str)) {
    return `${q}${str.split(q).join(q + q)}${q}`;
  }
  return str;
}

export function formatCsvHeader(
  columns: readonly ColumnMeta[],
  opts: CsvOptions = DEFAULT_CSV_OPTIONS,
): string {
  return columns.map((c) => csvEscape(c.name, { ...opts, nullAs: 'empty' })).join(opts.delimiter);
}

export function formatCsvRow(
  row: readonly unknown[],
  opts: CsvOptions = DEFAULT_CSV_OPTIONS,
): string {
  return row.map((v) => csvEscape(v, opts)).join(opts.delimiter);
}

/**
 * Object keys for a result's columns: a repeated name (`SELECT 1 a, 2 a`)
 * becomes `a`, `a_2`, `a_3` instead of the later column overwriting the
 * earlier one (P2-4).
 */
export function uniqueColumnKeys(columns: readonly Pick<ColumnMeta, 'name'>[]): string[] {
  const used = new Set<string>();
  return columns.map((col) => {
    let key = col.name;
    for (let n = 2; used.has(key); n++) key = `${col.name}_${n}`;
    used.add(key);
    return key;
  });
}

export function rowToObject(
  columns: readonly ColumnMeta[],
  row: readonly unknown[],
): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  const keys = uniqueColumnKeys(columns);
  keys.forEach((key, i) => {
    obj[key] = row[i];
  });
  return obj;
}

/**
 * JSON.stringify would write NaN / ±Infinity as `null` (a silent data
 * change) and throw on bigint; keep them as strings (P2-4).
 */
export function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function quoteText(str: string): string {
  return `'${str.replace(/'/g, "''")}'`;
}

/**
 * SQL literal for one exported value (F7). The worker hands us Postgres
 * text for dates, timestamps, intervals, bytea (`\x…`), numeric, int8 and
 * arrays (`{1,2}`), so those are quoted verbatim and Postgres casts them
 * to the target column on INSERT — no UTC shift, no precision loss, no
 * array-as-jsonb. Only json/jsonb arrive as parsed values; they are
 * re-serialised and cast to the column's own JSON type.
 */
export function sqlLiteral(
  value: unknown,
  column?: Pick<ColumnMeta, 'dataTypeName'>,
  dialect?: SqlDialect,
): string {
  if (dialect && dialect.engine !== 'postgres') return genericSqlLiteral(value, column, dialect);
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number')
    return Number.isFinite(value) ? String(value) : quoteText(String(value));
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return quoteText(value.toISOString());
  if (typeof value === 'object') {
    const cast = column?.dataTypeName === 'json' ? '::json' : '::jsonb';
    try {
      return quoteText(JSON.stringify(value)) + cast;
    } catch {
      return quoteText(String(value));
    }
  }
  if (column?.dataTypeName === 'json' || column?.dataTypeName === 'jsonb') {
    // A JSON string scalar parses to a JS string; keep it valid JSON.
    return `${quoteText(JSON.stringify(value))}::${column.dataTypeName}`;
  }
  return quoteText(String(value));
}

/**
 * Literal for the SQLite / MySQL dialects: no `::json` casts (their drivers
 * hand over plain text), blobs as `X'…'`, the engine's own string escaping.
 */
function genericSqlLiteral(
  value: unknown,
  column: Pick<ColumnMeta, 'dataTypeName'> | undefined,
  dialect: SqlDialect,
): string {
  if (
    typeof value === 'string' &&
    column?.dataTypeName === 'bytea' &&
    /^\\x[0-9a-fA-F]*$/.test(value)
  ) {
    return `X'${value.slice(2)}'`;
  }
  return dialect.literal(value);
}

/** Default INSERT target when the result has no single source table. */
export const DEFAULT_EXPORT_TABLE = 'target_table';

export function formatSqlInsert(
  columns: readonly ColumnMeta[],
  row: readonly unknown[],
  tableName = DEFAULT_EXPORT_TABLE,
  dialect?: SqlDialect,
): string {
  const colList = columns
    .map((c) => (dialect ? dialect.quoteIdent(c.name) : `"${c.name.replace(/"/g, '""')}"`))
    .join(', ');
  const vals = row.map((v, i) => sqlLiteral(v, columns[i], dialect)).join(', ');
  return `INSERT INTO ${tableName} (${colList}) VALUES (${vals});`;
}

/**
 * Create a streamer that emits formatted text into sink without retaining
 * prior batches. JSON is emitted as a pretty-printed array.
 */
export function createExportStreamer(
  format: ExportFormat,
  columns: readonly ColumnMeta[],
  sink: ExportSink,
  opts?: { targetTable?: string; csv?: CsvOptions; dialect?: SqlDialect },
): ExportStreamer {
  const csv = opts?.csv ?? DEFAULT_CSV_OPTIONS;
  const targetTable = opts?.targetTable || DEFAULT_EXPORT_TABLE;
  let rowIndex = 0;

  if (format === 'csv') {
    return {
      begin() {
        void sink(CSV_BOM);
        if (csv.header) void sink(`${formatCsvHeader(columns, csv)}${eol(csv)}`);
      },
      writeRows(rows) {
        if (rows.length === 0) return;
        const body = rows.map((row) => formatCsvRow(row, csv)).join(eol(csv));
        void sink(`${body}${eol(csv)}`);
        rowIndex += rows.length;
      },
      end() {
        void rowIndex;
      },
    };
  }

  if (format === 'json') {
    return {
      begin() {
        void sink('[\n');
      },
      writeRows(rows) {
        for (const row of rows) {
          const prefix = rowIndex === 0 ? '  ' : ',\n  ';
          const json = JSON.stringify(rowToObject(columns, row), jsonReplacer, 2).replace(
            /\n/g,
            '\n  ',
          );
          void sink(prefix + json);
          rowIndex++;
        }
      },
      end() {
        void sink(rowIndex === 0 ? '\n]\n' : '\n]\n');
      },
    };
  }

  return {
    begin() {},
    writeRows(rows) {
      if (rows.length === 0) return;
      const body = rows
        .map((row) => formatSqlInsert(columns, row, targetTable, opts?.dialect))
        .join('\n');
      void sink(`${body}\n`);
      rowIndex += rows.length;
    },
    end() {
      void rowIndex;
    },
  };
}

/** Convenience: format an entire result into one string (clipboard / tests). */
export function formatResultString(
  columns: readonly ColumnMeta[],
  rows: readonly unknown[][],
  format: ExportFormat,
  opts?: { targetTable?: string; bom?: boolean; csv?: CsvOptions; dialect?: SqlDialect },
): string {
  const parts: string[] = [];
  const streamer = createExportStreamer(
    format,
    columns,
    (chunk) => {
      if (chunk === CSV_BOM && opts?.bom === false) return;
      parts.push(chunk);
    },
    opts,
  );
  streamer.begin();
  streamer.writeRows(rows);
  streamer.end();
  return parts.join('');
}
