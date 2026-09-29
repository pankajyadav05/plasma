/**
 * Grid clipboard formats (F5): copy a cell range or selected rows as
 * TSV, CSV (with or without header), JSON, Markdown or SQL INSERTs, and
 * parse pasted spreadsheet text back into a cell block.
 *
 * Values are rendered with `cellToText` — the same Postgres text the grid
 * shows and edits — so dates, json and arrays copy exactly.
 */
import type { ColumnMeta } from '@shared/protocol';
import { cellToText } from './cell-edit';

export type CopyFormat = 'tsv' | 'csv' | 'csv-header' | 'json' | 'markdown' | 'sql';

export const COPY_FORMATS: Array<{ value: CopyFormat; label: string }> = [
  { value: 'tsv', label: 'Tab-separated' },
  { value: 'csv', label: 'CSV' },
  { value: 'csv-header', label: 'CSV with header' },
  { value: 'json', label: 'JSON' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'sql', label: 'SQL INSERT' },
];

function csvField(v: string | null): string {
  if (v === null) return '';
  return /[",\r\n]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function tsvField(v: string | null): string {
  if (v === null) return 'NULL';
  // Spreadsheet-safe: tabs / newlines inside a value force quoting.
  return /[\t\r\n"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function mdField(v: string | null): string {
  if (v === null) return 'NULL';
  return v.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function sqlLiteral(v: string | null): string {
  if (v === null) return 'NULL';
  return `'${v.replace(/'/g, "''")}'`;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** JSON value for a cell: keep numbers / booleans / json documents typed. */
function jsonValue(v: unknown, col: ColumnMeta): unknown {
  if (v === null || v === undefined) return null;
  const t = col.dataTypeName.toLowerCase();
  if (t === 'json' || t === 'jsonb') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  return cellToText(v, col.dataTypeName);
}

/**
 * Serialise `rows` (full result rows) restricted to `colIndices`.
 * `table` (schema-qualified, already quoted or plain) is used by `sql`.
 */
export function formatRows(
  format: CopyFormat,
  columns: readonly ColumnMeta[],
  rows: readonly (readonly unknown[])[],
  colIndices: readonly number[],
  table?: { schema?: string; name: string },
): string {
  const cols = colIndices.map((i) => columns[i]!).filter(Boolean);
  const text = (row: readonly unknown[]) =>
    colIndices.map((i) => cellToText(row[i], columns[i]?.dataTypeName));
  switch (format) {
    case 'tsv':
      return rows.map((r) => text(r).map(tsvField).join('\t')).join('\n');
    case 'csv':
      return rows.map((r) => text(r).map(csvField).join(',')).join('\n');
    case 'csv-header':
      return [
        cols.map((c) => csvField(c.name)).join(','),
        ...rows.map((r) => text(r).map(csvField).join(',')),
      ].join('\n');
    case 'json':
      return JSON.stringify(
        rows.map((r) =>
          Object.fromEntries(
            colIndices.map((i) => [columns[i]!.name, jsonValue(r[i], columns[i]!)]),
          ),
        ),
        null,
        2,
      );
    case 'markdown': {
      const head = `| ${cols.map((c) => mdField(c.name)).join(' | ')} |`;
      const sep = `| ${cols.map(() => '---').join(' | ')} |`;
      return [head, sep, ...rows.map((r) => `| ${text(r).map(mdField).join(' | ')} |`)].join('\n');
    }
    case 'sql': {
      const target = table
        ? table.schema
          ? `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`
          : quoteIdent(table.name)
        : quoteIdent('target_table');
      const colList = cols.map((c) => quoteIdent(c.name)).join(', ');
      return rows
        .map(
          (r) =>
            `INSERT INTO ${target} (${colList}) VALUES (${text(r).map(sqlLiteral).join(', ')});`,
        )
        .join('\n');
    }
  }
}

/**
 * Parse clipboard text (TSV from a spreadsheet or this grid) into a cell
 * block. Handles quoted fields with embedded tabs / newlines / "" quotes.
 * The literal `NULL` becomes SQL NULL. A single trailing newline is ignored.
 */
export function parseClipboardBlock(text: string): Array<Array<string | null>> {
  const src = text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
  const rows: Array<Array<string | null>> = [];
  let row: Array<string | null> = [];
  let field = '';
  let quoted = false;
  let wasQuoted = false;
  const pushField = () => {
    row.push(!wasQuoted && field === 'NULL' ? null : field);
    field = '';
    wasQuoted = false;
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      wasQuoted = true;
    } else if (ch === '\t') {
      pushField();
    } else if (ch === '\n') {
      pushField();
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  pushField();
  rows.push(row);
  return rows;
}
