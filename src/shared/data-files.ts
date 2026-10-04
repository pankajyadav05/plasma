import type { ConnectionConfig } from './protocol';

/**
 * Data files DuckDB can open: what a path's extension says about it, the
 * view each file becomes, and the session config built from a set of files.
 * Pure, so main (validation), the worker (views) and the renderer (config)
 * share one definition.
 */

export type DataFileKind = 'csv' | 'tsv' | 'parquet' | 'json' | 'ndjson' | 'xlsx' | 'duckdb';

const COMPRESSED = /\.gz$/i;

/** File kind from the extension (`.csv.gz` is a CSV too); null when unsupported. */
export function dataFileKind(path: string): DataFileKind | null {
  const base = path.replace(/^.*[\\/]/, '');
  const name = base.replace(COMPRESSED, '').toLowerCase();
  const gz = COMPRESSED.test(base);
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  switch (ext) {
    case 'csv':
      return 'csv';
    case 'tsv':
    case 'tab':
      return 'tsv';
    case 'parquet':
      return gz ? null : 'parquet';
    case 'json':
      return 'json';
    case 'ndjson':
    case 'jsonl':
      return 'ndjson';
    case 'xlsx':
      return gz ? null : 'xlsx';
    case 'duckdb':
    case 'ddb':
      return gz ? null : 'duckdb';
    default:
      return null;
  }
}

/** Extensions (without dot) the file dialogs offer. */
export const DATA_FILE_EXTENSIONS = {
  tabular: ['csv', 'tsv', 'tab', 'parquet', 'json', 'jsonl', 'ndjson', 'xlsx', 'gz'],
  database: ['duckdb', 'ddb'],
} as const;

/**
 * DuckDB treats `* ? [` in a path as a glob. A data file is always one named
 * file, so such names are refused instead of silently matching others.
 */
export function dataFilePathProblem(path: string): string | null {
  if (!path || path.includes('\0')) return 'The file path is not valid.';
  if (/[*?[\]]/.test(path)) {
    return 'File names containing * ? [ or ] are not supported (DuckDB would read them as patterns). Rename the file.';
  }
  if (!dataFileKind(path)) {
    if (/\.xls$/i.test(path)) {
      return 'Old .xls workbooks are not supported. Save it as .xlsx (Excel: File → Save As) and open that.';
    }
    return 'Unsupported file type. Open a CSV, TSV, Parquet, JSON, NDJSON or Excel (.xlsx) file (or a .duckdb database).';
  }
  return null;
}

/** `/data/Sales 2024.csv.gz` -> `Sales 2024` -> `Sales_2024`. */
export function dataFileStem(path: string): string {
  const base = path.replace(/^.*[\\/]/, '').replace(COMPRESSED, '');
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const clean = stem
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return clean || 'data';
}

/** One unique view name per file, named after it (`t`, `t_2`, … on clashes). */
export function viewNamesFor(paths: readonly string[], reserved: Iterable<string> = []): string[] {
  return uniqueViewNames(paths.map(dataFileStem), reserved);
}

/** View name for one sheet of a workbook: `Sales` + `Q1 2024` -> `Sales_Q1_2024`. */
export function sheetViewStem(path: string, sheet: string): string {
  const clean = sheet
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return clean ? `${dataFileStem(path)}_${clean}`.slice(0, 80) : dataFileStem(path);
}

/** De-duplicate stems case-insensitively (`t`, `t_2`, …), avoiding `reserved`. */
export function uniqueViewNames(
  stems: readonly string[],
  reserved: Iterable<string> = [],
): string[] {
  const taken = new Set([...reserved].map((n) => n.toLowerCase()));
  return stems.map((stem) => {
    let name = stem;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${stem}_${n}`;
    taken.add(name.toLowerCase());
    return name;
  });
}

function singleQuoted(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/** `CREATE VIEW` over one file (one sheet of a workbook), using the reader for its kind. */
export function createViewSql(
  viewName: string,
  path: string,
  kind: DataFileKind,
  sheet?: string,
): string {
  const view = `"${viewName.replace(/"/g, '""')}"`;
  const file = singleQuoted(path);
  switch (kind) {
    case 'csv':
      return `CREATE VIEW ${view} AS SELECT * FROM read_csv_auto(${file})`;
    case 'tsv':
      return `CREATE VIEW ${view} AS SELECT * FROM read_csv_auto(${file}, delim = '\\t')`;
    case 'parquet':
      return `CREATE VIEW ${view} AS SELECT * FROM read_parquet(${file})`;
    case 'json':
      return `CREATE VIEW ${view} AS SELECT * FROM read_json_auto(${file}, format = 'auto')`;
    case 'ndjson':
      return `CREATE VIEW ${view} AS SELECT * FROM read_json_auto(${file}, format = 'newline_delimited')`;
    case 'xlsx':
      return `CREATE VIEW ${view} AS SELECT * FROM read_xlsx(${file}${sheet ? `, sheet = ${singleQuoted(sheet)}` : ''})`;
    case 'duckdb':
      throw new Error('A .duckdb file is a database, not a view source.');
  }
}

/** Human label of a file kind for tables and details. */
export const DATA_FILE_KIND_LABEL: Record<DataFileKind, string> = {
  csv: 'CSV',
  tsv: 'TSV',
  parquet: 'Parquet',
  json: 'JSON',
  ndjson: 'NDJSON',
  xlsx: 'Excel workbook',
  duckdb: 'DuckDB database',
};

/** Catalog alias for an attached Postgres connection: `pg_<name>`. */
export function attachAlias(name: string, taken: Iterable<string> = []): string {
  const used = new Set([...taken].map((n) => n.toLowerCase()));
  const stem =
    `pg_${name.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')}`.slice(0, 40) || 'pg';
  let alias = stem;
  for (let n = 2; used.has(alias.toLowerCase()); n++) alias = `${stem}_${n}`;
  return alias;
}

/**
 * Stable id for a session over these files: reopening the same files finds the
 * same saved tabs, and sessions do not pile up one id each in local storage.
 */
export function dataFileSessionId(
  paths: readonly string[],
  attachConnectionIds: readonly string[] = [],
): string {
  const text = `${[...paths].sort().join('\n')}\u0000${[...attachConnectionIds].sort().join('\n')}`;
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return `duckdb-${h.toString(36)}`;
}

/**
 * Session config for a set of opened paths: a `.duckdb` file in the set is
 * the database (read-only), everything else becomes a view over `:memory:`.
 */
/** Error text the DuckDB driver uses when the Postgres extension must be downloaded first. */
export const DUCKDB_PG_EXTENSION_MISSING = "DuckDB's Postgres extension is not installed";
/** Error text the DuckDB driver uses when the Excel extension must be downloaded first. */
export const DUCKDB_EXCEL_EXTENSION_MISSING = "DuckDB's Excel extension is not installed";

export function dataFileSessionConfig(
  paths: readonly string[],
  attachConnectionIds: readonly string[] = [],
  id = dataFileSessionId(paths, attachConnectionIds),
): ConnectionConfig {
  const db = paths.find((p) => dataFileKind(p) === 'duckdb');
  const files = paths.filter((p) => p !== db);
  const first = db ?? files[0] ?? '';
  const base = first.replace(/^.*[\\/]/, '');
  const name = paths.length > 1 ? `${base} +${paths.length - 1}` : base || 'Data files';
  return {
    id,
    name,
    engine: 'duckdb',
    host: 'local',
    port: 1,
    database: db ?? ':memory:',
    user: '',
    password: '',
    ssl: false,
    readOnly: false,
    duckdb: {
      files,
      ...(attachConnectionIds.length > 0 ? { attachConnectionIds: [...attachConnectionIds] } : {}),
    },
  };
}

/** True for a session built from data files (not a saved .duckdb connection). */
export function isDataFileSession(
  config: { engine?: string; id?: string; duckdb?: { files: string[] } } | null | undefined,
): boolean {
  return config?.engine === 'duckdb' && config.id?.startsWith('duckdb-') === true;
}
