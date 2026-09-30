/**
 * Cell value ⇄ Postgres text conversion for the result grid.
 *
 * node-postgres hands the renderer parsed JS values: json/jsonb become
 * objects and arrays become JS arrays, bytea a Uint8Array and interval a
 * `{ days, hours, … }` object (dates already arrive as Postgres text). Editing
 * those with `String(value)` produced `[object Object]`, `1,2` or
 * `Tue Sep 29 …` — garbage the server either rejects or, worse, stores.
 *
 * Here every value is rendered as its **Postgres text representation**,
 * which is both what the grid shows and what the inline editor starts
 * with. Commits send that text as an untyped bind parameter, so the
 * server parses it with the target column's input function. NULL stays
 * `null` end to end — it is never collapsed into `''`.
 */

/** Strip `varchar(50)` decoration and lower-case a pg type name. */
function baseType(typeName: string | undefined | null): string {
  return (typeName ?? '')
    .replace(/\(.*\)/, '')
    .trim()
    .toLowerCase();
}

/** Element type of an array type name (`_int4` / `int4[]`), else null. */
export function arrayElementType(typeName: string | undefined | null): string | null {
  const t = baseType(typeName);
  if (t.endsWith('[]')) return t.slice(0, -2);
  if (t.startsWith('_')) return t.slice(1);
  return null;
}

function isJsonType(t: string): boolean {
  return t === 'json' || t === 'jsonb';
}

function bytesToHex(bytes: ArrayLike<number>): string {
  let out = '\\x';
  for (let i = 0; i < bytes.length; i++) out += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  return out;
}

/** `{ "0": 222, "1": 173 }` — a Uint8Array after a JSON round-trip. */
function isIndexedByteObject(v: object): v is Record<string, number> {
  const keys = Object.keys(v);
  return (
    keys.length > 0 &&
    keys.every((k, i) => k === String(i)) &&
    keys.every((k) => {
      const n = (v as Record<string, unknown>)[k];
      return typeof n === 'number' && n >= 0 && n <= 255;
    })
  );
}

const INTERVAL_KEYS = ['years', 'months', 'days', 'hours', 'minutes', 'seconds', 'milliseconds'];

function isIntervalObject(v: object): v is Record<string, number> {
  const keys = Object.keys(v);
  return keys.every(
    (k) => INTERVAL_KEYS.includes(k) && typeof (v as Record<string, unknown>)[k] === 'number',
  );
}

/** Interval → ISO 8601 duration (`P1Y2M3DT4H5M6.5S`), which Postgres accepts. */
function formatInterval(v: Record<string, number>): string {
  const { years = 0, months = 0, days = 0, hours = 0, minutes = 0 } = v;
  const seconds = (v.seconds ?? 0) + (v.milliseconds ?? 0) / 1000;
  let date = '';
  if (years) date += `${years}Y`;
  if (months) date += `${months}M`;
  if (days) date += `${days}D`;
  let time = '';
  if (hours) time += `${hours}H`;
  if (minutes) time += `${minutes}M`;
  if (seconds) time += `${Number(seconds.toFixed(6))}S`;
  if (!date && !time) return 'PT0S';
  return `P${date}${time ? `T${time}` : ''}`;
}

/** Quote one element of an array literal when Postgres requires it. */
function quoteArrayElement(s: string): string {
  if (s === '' || /^null$/i.test(s) || /[{}",\\\s]/.test(s)) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return s;
}

/** JS array → Postgres array literal (`{1,2,NULL,"a b"}`). */
export function toPgArrayLiteral(values: readonly unknown[], elementType: string | null): string {
  const parts = values.map((v) => {
    if (v === null || v === undefined) return 'NULL';
    if (Array.isArray(v)) return toPgArrayLiteral(v, elementType);
    const text = cellToText(v, elementType ?? undefined);
    return quoteArrayElement(text ?? '');
  });
  return `{${parts.join(',')}}`;
}

/**
 * Postgres text for a cell value, or `null` for SQL NULL. `typeName` is
 * the column's `dataTypeName` (used for json, date and array handling).
 */
export function cellToText(value: unknown, typeName?: string | null): string | null {
  if (value === null || value === undefined) return null;
  const t = baseType(typeName);
  if (isJsonType(t)) {
    // pg normally parses the document — re-serialise it (a JSON string
    // scalar keeps its quotes, which is what the column holds). If the
    // worker already sent raw JSON text (a string that parses to a
    // non-string), keep it verbatim.
    if (typeof value === 'string') {
      try {
        if (typeof JSON.parse(value) !== 'string') return value;
      } catch {
        // not JSON text → a parsed string scalar; fall through
      }
    }
    try {
      return JSON.stringify(value) ?? 'null';
    } catch {
      return String(value);
    }
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return toPgArrayLiteral(value, arrayElementType(typeName));
  if (value instanceof Uint8Array) return bytesToHex(value);
  if (typeof value === 'object') {
    if (t === 'bytea' && isIndexedByteObject(value)) {
      return bytesToHex(Object.values(value));
    }
    const buf = value as { type?: unknown; data?: unknown };
    if (buf.type === 'Buffer' && Array.isArray(buf.data)) return bytesToHex(buf.data as number[]);
    if (t === 'interval' && isIntervalObject(value)) return formatInterval(value);
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * Normalise text for no-op comparison: JSON documents compare by value
 * (whitespace / key spacing doesn't count as a change).
 */
function normaliseForCompare(text: string, typeName?: string | null): string {
  if (isJsonType(baseType(typeName))) {
    try {
      return JSON.stringify(JSON.parse(text));
    } catch {
      return text;
    }
  }
  return text;
}

/**
 * True when committing `next` over `original` would change nothing —
 * such edits are never queued (A1: clicking in and out of a cell must
 * not record `SET col = ''`).
 */
export function isNoopEdit(
  original: unknown,
  next: string | null,
  typeName?: string | null,
): boolean {
  const before = cellToText(original, typeName);
  if (before === null || next === null) return before === next;
  return normaliseForCompare(before, typeName) === normaliseForCompare(next, typeName);
}

/** Bind-parameter form of a cell value (text or explicit null). */
export function cellToParam(value: unknown, typeName?: string | null): string | null {
  return cellToText(value, typeName);
}
