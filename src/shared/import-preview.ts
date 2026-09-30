import {
  type Cell,
  CsvParser,
  type ImportFormat,
  JsonArrayStream,
  LineSplitter,
  detectDelimiter,
  detectHeader,
  inferColumnTypes,
  jsonCell,
  jsonKeys,
  parseJsonObject,
} from './import-parse';
import type { ImportCsvOptions, ImportPreview } from './protocol';
import { splitSqlStatementRanges } from './sql-split';

/** How much of a file the preview reads. */
export const PREVIEW_SAMPLE_BYTES = 512 * 1024;
const PREVIEW_ROWS = 20;
const INFER_ROWS = 500;

export interface PreviewInput {
  path: string;
  format: ImportFormat;
  csv?: Partial<ImportCsvOptions>;
}

/**
 * Build the preview from the head of a file. Pure: the caller reads the
 * bytes. `truncated` says the sample ended before the file did, in which
 * case the last (possibly cut) row is dropped.
 */
export function buildImportPreview(
  input: PreviewInput,
  text: string,
  size: number,
  truncated: boolean,
): ImportPreview {
  const sample = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const base = { path: input.path, format: input.format, size, truncated };

  if (input.format === 'sql') {
    const parts = splitSqlStatementRanges(sample);
    if (truncated) parts.pop();
    return {
      ...base,
      columns: [],
      rows: [],
      types: [],
      statements: parts.slice(0, PREVIEW_ROWS).map((p) => p.text.slice(0, 400)),
    };
  }

  if (input.format === 'csv' || input.format === 'tsv') {
    const delimiter =
      input.csv?.delimiter ?? (input.format === 'tsv' ? '\t' : detectDelimiter(sample));
    const csv: ImportCsvOptions = {
      delimiter,
      quote: input.csv?.quote ?? '"',
      header: input.csv?.header ?? true,
      nullString: input.csv?.nullString === undefined ? '' : input.csv.nullString,
    };
    const parser = new CsvParser(csv);
    let rows: Cell[][];
    try {
      rows = truncated ? parser.push(sample) : [...parser.push(sample), ...parser.end()];
    } catch {
      rows = parser.push(sample);
    }
    if (input.csv?.header === undefined) csv.header = detectHeader(rows);
    const width = rows.slice(0, INFER_ROWS).reduce((m, r) => Math.max(m, r.length), 0);
    const header = csv.header ? rows[0] : undefined;
    const data = csv.header ? rows.slice(1) : rows;
    const columns = Array.from({ length: width }, (_, i) => {
      const h = header?.[i];
      return h != null && h.trim() !== '' ? h : `column ${i + 1}`;
    });
    return {
      ...base,
      csv,
      columns,
      rows: data.slice(0, PREVIEW_ROWS).map((r) => columns.map((_, i) => r[i] ?? null)),
      types: inferColumnTypes(data.slice(0, INFER_ROWS), width),
    };
  }

  // json / ndjson
  const objects: Record<string, unknown>[] = [];
  const take = (texts: string[]) => {
    for (const t of texts) {
      if (objects.length >= INFER_ROWS) return;
      objects.push(parseJsonObject(t));
    }
  };
  if (input.format === 'ndjson') take(new LineSplitter().push(`${sample}${truncated ? '' : '\n'}`));
  else take(new JsonArrayStream().push(sample));
  const keys = jsonKeys(objects);
  const cells = objects.map((o) => keys.map((k) => jsonCell(o[k])));
  return {
    ...base,
    columns: keys,
    rows: cells.slice(0, PREVIEW_ROWS),
    types: inferColumnTypes(cells, keys.length),
  };
}
