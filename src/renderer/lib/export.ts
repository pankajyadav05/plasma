import type { ColumnMeta, QueryResult } from '@shared/protocol';

/**
 * Result set export helpers. All synchronous — streams are M3 territory.
 * Writes to an in-browser Blob and triggers a download via a synthetic
 * anchor click. Works in Electron renderer without any main-process help.
 */

export type ExportFormat = 'csv' | 'json' | 'sql';

export function exportResult(result: QueryResult, format: ExportFormat, filename = 'plasma') {
  let content: string;
  let mime: string;
  let extension: string;

  switch (format) {
    case 'csv':
      content = toCsv(result);
      mime = 'text/csv;charset=utf-8';
      extension = 'csv';
      break;
    case 'json':
      content = toJson(result);
      mime = 'application/json;charset=utf-8';
      extension = 'json';
      break;
    case 'sql':
      content = toSqlInserts(result);
      mime = 'text/plain;charset=utf-8';
      extension = 'sql';
      break;
  }

  download(content, `${filename}.${extension}`, mime);
}

function toCsv(result: QueryResult): string {
  const header = result.columns.map((c) => csvEscape(c.name)).join(',');
  const body = result.rows.map((row) => row.map(csvEscape).join(','));
  return [header, ...body].join('\r\n');
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  let str: string;
  if (typeof value === 'object') {
    try {
      str = JSON.stringify(value);
    } catch {
      str = String(value);
    }
  } else {
    str = String(value);
  }
  // Quote if contains comma, quote, newline, or carriage return
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toJson(result: QueryResult): string {
  const objects = result.rows.map((row) => {
    const obj: Record<string, unknown> = {};
    result.columns.forEach((col, i) => {
      obj[col.name] = row[i];
    });
    return obj;
  });
  return JSON.stringify(objects, null, 2);
}

function toSqlInserts(result: QueryResult): string {
  // We don't know the table name — emit as placeholder `target_table`.
  const colList = result.columns.map((c) => `"${c.name.replace(/"/g, '""')}"`).join(', ');
  const lines: string[] = [];
  for (const row of result.rows) {
    const vals = row.map((v) => sqlLiteral(v, result.columns)).join(', ');
    lines.push(`INSERT INTO target_table (${colList}) VALUES (${vals});`);
  }
  return lines.join('\n');
}

function sqlLiteral(value: unknown, _columns: ColumnMeta[]): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return `'${value.toISOString()}'`;
  if (typeof value === 'object') {
    try {
      return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
    } catch {
      return `'${String(value).replace(/'/g, "''")}'`;
    }
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

function download(content: string, filename: string, mime: string) {
  // Prepend UTF-8 BOM for CSV so Excel opens it correctly
  const prefix = mime.startsWith('text/csv') ? '\uFEFF' : '';
  const blob = new Blob([prefix + content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Give the browser a tick before revoking so the download actually starts
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Copy a single cell value to the clipboard. Normalizes the same way
 * the grid renders it (null → empty string, objects → JSON).
 */
export async function copyCellToClipboard(value: unknown): Promise<void> {
  let str: string;
  if (value === null || value === undefined) str = '';
  else if (typeof value === 'object') {
    try {
      str = JSON.stringify(value);
    } catch {
      str = String(value);
    }
  } else {
    str = String(value);
  }
  await navigator.clipboard.writeText(str);
}
