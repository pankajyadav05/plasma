/**
 * Pure parsing helpers for "Import into a table": an incremental CSV/TSV
 * parser, delimiter / header detection, a streaming JSON-array element
 * splitter, NDJSON line splitting and column type inference.
 *
 * Everything is chunk-oriented (`push(text)` returns the rows completed so
 * far) so the worker can stream multi-gigabyte files without holding them
 * in memory, and the main process can reuse the same code to build the
 * preview from the first few hundred KB.
 */

export type ImportFormat = 'csv' | 'tsv' | 'json' | 'ndjson' | 'sql';

export function formatFromPath(path: string): ImportFormat | null {
  const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  switch (ext) {
    case 'csv':
    case 'txt':
      return 'csv';
    case 'tsv':
    case 'tab':
      return 'tsv';
    case 'json':
      return 'json';
    case 'ndjson':
    case 'jsonl':
      return 'ndjson';
    case 'sql':
      return 'sql';
    default:
      return null;
  }
}

// ─── CSV ─────────────────────────────────────────────────────────────

export interface CsvOptions {
  delimiter: string;
  /** Quote character; empty string disables quoting. */
  quote: string;
  /** Unquoted cells equal to this become null. `null` disables. */
  nullString: string | null;
}

export type Cell = string | null;

/**
 * Incremental RFC 4180-style parser. Quotes may be doubled (`""`) to
 * escape themselves. Rows end at LF, CRLF or a lone CR; empty lines are
 * skipped. State survives across `push` calls, so a quoted field (or a
 * CRLF) may be split between chunks anywhere.
 */
export class CsvParser {
  private readonly delimiter: string;
  private readonly quote: string;
  private readonly nullString: string | null;
  private row: Cell[] = [];
  private field = '';
  private fieldQuoted = false;
  private inQuotes = false;
  /** Saw a quote while in quotes; next char decides escape vs. close. */
  private quotePending = false;
  private crPending = false;
  private rowHasContent = false;

  constructor(opts: CsvOptions) {
    if (opts.delimiter.length !== 1) throw new Error('The delimiter must be one character');
    if (opts.quote.length > 1) throw new Error('The quote must be one character or empty');
    if (opts.quote === opts.delimiter) throw new Error('Quote and delimiter must differ');
    this.delimiter = opts.delimiter;
    this.quote = opts.quote;
    this.nullString = opts.nullString;
  }

  private endField(): void {
    const value = this.field;
    const isNull = !this.fieldQuoted && this.nullString !== null && value === this.nullString;
    this.row.push(isNull ? null : value);
    this.field = '';
    this.fieldQuoted = false;
  }

  private endRow(out: Cell[][]): void {
    if (this.rowHasContent || this.row.length > 0 || this.field !== '' || this.fieldQuoted) {
      this.endField();
      out.push(this.row);
    }
    this.row = [];
    this.rowHasContent = false;
  }

  push(chunk: string): Cell[][] {
    const out: Cell[][] = [];
    const { delimiter, quote } = this;
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i] as string;
      if (this.crPending) {
        this.crPending = false;
        if (ch === '\n') continue;
      }
      if (this.quotePending) {
        this.quotePending = false;
        if (ch === quote) {
          this.field += quote;
          continue;
        }
        this.inQuotes = false; // it was the closing quote; handle `ch` normally
      }
      if (this.inQuotes) {
        if (quote && ch === quote) this.quotePending = true;
        else this.field += ch;
        continue;
      }
      if (quote && ch === quote && this.field === '' && !this.fieldQuoted) {
        this.inQuotes = true;
        this.fieldQuoted = true;
        this.rowHasContent = true;
      } else if (ch === delimiter) {
        this.rowHasContent = true;
        this.endField();
      } else if (ch === '\n') {
        this.endRow(out);
      } else if (ch === '\r') {
        this.crPending = true;
        this.endRow(out);
      } else {
        this.field += ch;
        this.rowHasContent = true;
      }
    }
    return out;
  }

  /** Flush the last row when the file does not end with a newline. */
  end(): Cell[][] {
    const out: Cell[][] = [];
    if (this.quotePending) {
      this.quotePending = false;
      this.inQuotes = false;
    }
    if (this.inQuotes) throw new Error('The file ends inside a quoted field (unbalanced quote)');
    this.endRow(out);
    return out;
  }
}

/** Parse a whole (small) string. Used by previews and tests. */
export function parseCsv(text: string, opts: CsvOptions): Cell[][] {
  const p = new CsvParser(opts);
  return [...p.push(text), ...p.end()];
}

/** Guess the delimiter from the first lines of a file. */
export function detectDelimiter(sample: string, preferred?: string): string {
  const candidates = [',', '\t', ';', '|'];
  const lines = sample
    .split(/\r\n|\n|\r/)
    .filter((l) => l.length > 0)
    .slice(0, 12);
  if (lines.length === 0) return preferred ?? ',';
  let best = preferred ?? ',';
  let bestScore = 0;
  for (const d of candidates) {
    const counts = lines.map((l) => countOutsideQuotes(l, d));
    const first = counts[0] ?? 0;
    if (first === 0) continue;
    const consistent = counts.filter((c) => c === first).length;
    const score = consistent * 1000 + first;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

function countOutsideQuotes(line: string, d: string): number {
  let n = 0;
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === d && !q) n++;
  }
  return n;
}

// ─── type inference ──────────────────────────────────────────────────

const INT_RE = /^[+-]?(0|[1-9]\d*)$/;
const NUM_RE = /^[+-]?((0|[1-9]\d*)(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/;
const BOOL_RE = /^(true|false|t|f|yes|no)$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TS_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?\s*(Z|[+-]\d{2}(:?\d{2})?)?$/;
const TS_TZ_RE = /(Z|[+-]\d{2}(:?\d{2})?)$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type InferredType =
  | 'boolean'
  | 'integer'
  | 'bigint'
  | 'numeric'
  | 'date'
  | 'timestamp'
  | 'timestamptz'
  | 'uuid'
  | 'jsonb'
  | 'text';

const INT4_MAX = 2147483647n;
const INT8_MAX = 9223372036854775807n;

function looksLikeJson(v: string): boolean {
  const t = v.trim();
  if (!((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']')))) {
    return false;
  }
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

/** Accumulates evidence about one column and reports the narrowest type that fits. */
export class TypeInferrer {
  private seen = 0;
  private bool = true;
  private int = true;
  private int4 = true;
  private int8 = true;
  private num = true;
  private date = true;
  private ts = true;
  private tz = false;
  private uuid = true;
  private json = true;

  add(value: string | null): void {
    if (value === null) return;
    const v = value.trim();
    if (v === '') return;
    this.seen++;
    if (this.bool && !BOOL_RE.test(v)) this.bool = false;
    if (this.int) {
      if (!INT_RE.test(v)) this.int = false;
      else {
        const big = BigInt(v);
        const abs = big < 0n ? -big : big;
        if (abs > INT4_MAX) this.int4 = false;
        if (abs > INT8_MAX) this.int8 = false;
      }
    }
    if (this.num && !NUM_RE.test(v)) this.num = false;
    if (this.date && !DATE_RE.test(v)) this.date = false;
    if (this.ts) {
      if (!TS_RE.test(v)) this.ts = false;
      else if (TS_TZ_RE.test(v)) this.tz = true;
    }
    if (this.uuid && !UUID_RE.test(v)) this.uuid = false;
    if (this.json && !looksLikeJson(v)) this.json = false;
  }

  result(): InferredType {
    if (this.seen === 0) return 'text';
    if (this.bool) return 'boolean';
    if (this.int) return this.int4 ? 'integer' : this.int8 ? 'bigint' : 'numeric';
    if (this.num) return 'numeric';
    if (this.date) return 'date';
    if (this.ts) return this.tz ? 'timestamptz' : 'timestamp';
    if (this.uuid) return 'uuid';
    if (this.json) return 'jsonb';
    return 'text';
  }
}

export function inferColumnTypes(
  rows: readonly (readonly Cell[])[],
  width: number,
): InferredType[] {
  const inf = Array.from({ length: width }, () => new TypeInferrer());
  for (const row of rows) for (let c = 0; c < width; c++) inf[c]?.add(row[c] ?? null);
  return inf.map((i) => i.result());
}

/**
 * Does the first row look like a header? It does when no cell is empty or
 * a duplicate, none looks like data of a non-text type, and either a later
 * row has typed data or nothing contradicts it (all-text files default to
 * "has header", which is what nearly every export produces).
 */
export function detectHeader(rows: readonly (readonly Cell[])[]): boolean {
  const first = rows[0];
  if (!first || first.length === 0) return false;
  const names = first.map((c) => (c ?? '').trim());
  if (names.some((n) => n === '')) return false;
  if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) return false;
  const firstTypes = names.map((n) => {
    const t = new TypeInferrer();
    t.add(n);
    return t.result();
  });
  if (firstTypes.some((t) => t !== 'text')) return false;
  return true;
}

/** A safe, unique, lower-case column name for a create-table import. */
export function sanitizeColumnName(raw: string, index: number, used: Set<string>): string {
  let base = raw
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_]+/gu, '_')
    .replace(/^_+|_+$/g, '');
  if (!base) base = `column_${index + 1}`;
  if (/^\d/.test(base)) base = `_${base}`;
  if (new TextEncoder().encode(base).length > 55) base = base.slice(0, 55);
  let name = base;
  for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
  used.add(name);
  return name;
}

// ─── JSON ────────────────────────────────────────────────────────────

/**
 * Splits the text of a top-level JSON array of objects into one string per
 * element without parsing the whole document. Feed chunks with `push`;
 * each returned string is a complete `{…}` ready for JSON.parse.
 */
export class JsonArrayStream {
  private started = false;
  private done = false;
  private depth = 0;
  private inString = false;
  private escape = false;
  private buf = '';

  push(chunk: string): string[] {
    const out: string[] = [];
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i] as string;
      if (this.done) {
        if (!/\s/.test(ch)) throw new Error('Unexpected content after the closing ]');
        continue;
      }
      if (!this.started) {
        if (/\s/.test(ch) || ch === '﻿') continue;
        if (ch !== '[') {
          throw new Error(
            ch === '{'
              ? 'Expected a JSON array of objects (or NDJSON), found a single object'
              : 'Expected a JSON array of objects',
          );
        }
        this.started = true;
        continue;
      }
      if (this.depth === 0) {
        if (/\s/.test(ch) || ch === ',') continue;
        if (ch === ']') {
          this.done = true;
          continue;
        }
        if (ch !== '{') throw new Error('Every array element must be an object');
        this.depth = 1;
        this.buf = '{';
        continue;
      }
      this.buf += ch;
      if (this.inString) {
        if (this.escape) this.escape = false;
        else if (ch === '\\') this.escape = true;
        else if (ch === '"') this.inString = false;
        continue;
      }
      if (ch === '"') this.inString = true;
      else if (ch === '{' || ch === '[') this.depth++;
      else if (ch === '}' || ch === ']') {
        this.depth--;
        if (this.depth === 0) {
          out.push(this.buf);
          this.buf = '';
        }
      }
    }
    return out;
  }

  end(): void {
    if (!this.started) throw new Error('The file is empty');
    if (!this.done || this.depth !== 0) throw new Error('The JSON array is not closed');
  }
}

/** Splits text into non-empty lines across chunks (NDJSON). */
export class LineSplitter {
  private tail = '';
  push(chunk: string): string[] {
    const parts = (this.tail + chunk).split(/\r\n|\n|\r/);
    this.tail = parts.pop() ?? '';
    return parts.filter((l) => l.trim() !== '');
  }
  end(): string[] {
    const t = this.tail.trim();
    this.tail = '';
    return t ? [t] : [];
  }
}

export type JsonObject = Record<string, unknown>;

export function parseJsonObject(text: string): JsonObject {
  const v: unknown = JSON.parse(text);
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error('Expected a JSON object');
  }
  return v as JsonObject;
}

/** JSON value → the text a parameterised INSERT should send. */
export function jsonCell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return JSON.stringify(v);
}

/** Union of keys across objects, in first-seen order. */
export function jsonKeys(objects: readonly JsonObject[]): string[] {
  const keys = new Set<string>();
  for (const o of objects) for (const k of Object.keys(o)) keys.add(k);
  return [...keys];
}
