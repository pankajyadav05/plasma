import type { ColumnMeta } from "./protocol";

/**
 * Incremental CSV / JSON / SQL INSERT formatting (U16).
 *
 * Keeps assembly off the renderer hot path: callers stream batches into a
 * sink (file write stream or string collector) without building one giant
 * in-memory string up front.
 */

export type ExportFormat = "csv" | "json" | "sql";

export function exportExtension(format: ExportFormat): string {
  switch (format) {
    case "csv":
      return "csv";
    case "json":
      return "json";
    case "sql":
      return "sql";
  }
}

export function exportMime(format: ExportFormat): string {
  switch (format) {
    case "csv":
      return "text/csv;charset=utf-8";
    case "json":
      return "application/json;charset=utf-8";
    case "sql":
      return "text/plain;charset=utf-8";
  }
}

export type ExportSink = (chunk: string) => void | Promise<void>;

export type ExportStreamer = {
  begin(): void;
  writeRows(rows: readonly unknown[][]): void;
  end(): void;
};

/** UTF-8 BOM so Excel opens CSV correctly. */
export const CSV_BOM = "\uFEFF";

export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  let str: string;
  if (typeof value === "object") {
    try {
      str = JSON.stringify(value);
    } catch {
      str = String(value);
    }
  } else {
    str = String(value);
  }
  if (/[",\r\n]/.test(str)) {
    return "\"" + str.replace(/"/g, "\"\"") + "\"";
  }
  return str;
}

export function formatCsvHeader(columns: readonly ColumnMeta[]): string {
  return columns.map((c) => csvEscape(c.name)).join(",");
}

export function formatCsvRow(row: readonly unknown[]): string {
  return row.map(csvEscape).join(",");
}

export function rowToObject(
  columns: readonly ColumnMeta[],
  row: readonly unknown[],
): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  columns.forEach((col, i) => {
    obj[col.name] = row[i];
  });
  return obj;
}

export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date) return "'" + value.toISOString() + "'";
  if (typeof value === "object") {
    try {
      return "'" + JSON.stringify(value).replace(/'/g, "''") + "'::jsonb";
    } catch {
      return "'" + String(value).replace(/'/g, "''") + "'";
    }
  }
  return "'" + String(value).replace(/'/g, "''") + "'";
}

export function formatSqlInsert(
  columns: readonly ColumnMeta[],
  row: readonly unknown[],
  tableName = "target_table",
): string {
  const colList = columns.map((c) => "\"" + c.name.replace(/"/g, "\"\"") + "\"").join(", ");
  const vals = row.map((v) => sqlLiteral(v)).join(", ");
  return "INSERT INTO " + tableName + " (" + colList + ") VALUES (" + vals + ");";
}

/**
 * Create a streamer that emits formatted text into sink without retaining
 * prior batches. JSON is emitted as a pretty-printed array.
 */
export function createExportStreamer(
  format: ExportFormat,
  columns: readonly ColumnMeta[],
  sink: ExportSink,
): ExportStreamer {
  let rowIndex = 0;

  if (format === "csv") {
    return {
      begin() {
        void sink(CSV_BOM);
        void sink(formatCsvHeader(columns) + "\r\n");
      },
      writeRows(rows) {
        if (rows.length === 0) return;
        const body = rows.map((row) => formatCsvRow(row)).join("\r\n");
        void sink(body + "\r\n");
        rowIndex += rows.length;
      },
      end() {
        void rowIndex;
      },
    };
  }

  if (format === "json") {
    return {
      begin() {
        void sink("[\n");
      },
      writeRows(rows) {
        for (const row of rows) {
          const prefix = rowIndex === 0 ? "  " : ",\n  ";
          const json = JSON.stringify(rowToObject(columns, row), null, 2).replace(
            /\n/g,
            "\n  ",
          );
          void sink(prefix + json);
          rowIndex++;
        }
      },
      end() {
        void sink(rowIndex === 0 ? "\n]\n" : "\n]\n");
      },
    };
  }

  return {
    begin() {},
    writeRows(rows) {
      if (rows.length === 0) return;
      const body = rows.map((row) => formatSqlInsert(columns, row)).join("\n");
      void sink(body + "\n");
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
): string {
  const parts: string[] = [];
  const streamer = createExportStreamer(format, columns, (chunk) => {
    parts.push(chunk);
  });
  streamer.begin();
  streamer.writeRows(rows);
  streamer.end();
  return parts.join("");
}
