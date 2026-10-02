/**
 * Value conversion behind the smart cell editors (pure). Every editor edits
 * Postgres *text* — the same representation the grid shows and commits
 * (see cell-edit.ts) — and these helpers convert between that text and the
 * structured views the editors present: a JSON tree, array elements,
 * date / time pickers, a tri-state boolean, bytea hex / base64.
 */
import type { SchemaInfo } from '@shared/protocol';
import { arrayElementType } from './cell-edit';

// ─── Which editor a column gets ──────────────────────────────────────

export type SmartEditorKind =
  | 'json'
  | 'array'
  | 'date'
  | 'time'
  | 'timestamp'
  | 'timestamptz'
  | 'enum'
  | 'bool'
  | 'uuid'
  | 'bytea'
  | 'text';

function baseType(typeName: string | null | undefined): string {
  return (typeName ?? '')
    .replace(/\(.*\)/, '')
    .trim()
    .toLowerCase();
}

/** Enum labels for a type name (schema-qualified or bare), or null. */
export function enumLabelsFor(
  schema: Pick<SchemaInfo, 'types'> | null | undefined,
  typeName: string | null | undefined,
): string[] | null {
  if (!schema || !typeName) return null;
  const t = baseType(typeName);
  const hit = (schema.types ?? []).find(
    (ty) =>
      ty.kind === 'enum' &&
      (ty.name.toLowerCase() === t || `${ty.schema}.${ty.name}`.toLowerCase() === t),
  );
  return hit?.values && hit.values.length > 0 ? hit.values : null;
}

/** Which smart editor handles a column type (`text` = the plain inline input). */
export function smartEditorKind(
  typeName: string | null | undefined,
  enumValues?: readonly string[] | null,
): SmartEditorKind {
  const t = baseType(typeName);
  if (arrayElementType(typeName) !== null) return 'array';
  switch (t) {
    case 'json':
    case 'jsonb':
      return 'json';
    case 'date':
      return 'date';
    case 'time':
    case 'timetz':
    case 'time without time zone':
    case 'time with time zone':
      return 'time';
    case 'timestamp':
    case 'timestamp without time zone':
      return 'timestamp';
    case 'timestamptz':
    case 'timestamp with time zone':
      return 'timestamptz';
    case 'bool':
    case 'boolean':
      return 'bool';
    case 'uuid':
      return 'uuid';
    case 'bytea':
      return 'bytea';
  }
  if (enumValues && enumValues.length > 0) return 'enum';
  return 'text';
}

// ─── JSON ────────────────────────────────────────────────────────────

export type JsonParse = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Find the first syntax error of a JSON document: `{ at, message }`, or null
 * when the scanner finds none. (Engines differ in whether `JSON.parse` errors
 * carry a position, so the location is found here.)
 */
export function locateJsonError(text: string): { at: number; message: string } | null {
  let i = 0;
  const ws = () => {
    while (i < text.length && /[ \t\r\n]/.test(text[i]!)) i++;
  };
  const fail = (message: string) => ({ at: Math.min(i, text.length), message });
  type Err = { at: number; message: string };
  const value = (): Err | null => {
    ws();
    const c = text[i];
    if (c === undefined) return fail('Unexpected end of JSON');
    if (c === '{') {
      i++;
      ws();
      if (text[i] === '}') {
        i++;
        return null;
      }
      for (;;) {
        ws();
        if (text[i] !== '"')
          return fail(
            text[i] === undefined
              ? 'Unexpected end of JSON'
              : `Expected a string key but found '${text[i]}'`,
          );
        const k = str();
        if (k) return k;
        ws();
        if (text[i] !== ':')
          return fail(
            text[i] === undefined
              ? 'Unexpected end of JSON'
              : `Expected ':' but found '${text[i]}'`,
          );
        i++;
        const v = value();
        if (v) return v;
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') {
          i++;
          return null;
        }
        return fail(
          text[i] === undefined
            ? 'Unexpected end of JSON'
            : `Expected ',' or '}' but found '${text[i]}'`,
        );
      }
    }
    if (c === '[') {
      i++;
      ws();
      if (text[i] === ']') {
        i++;
        return null;
      }
      for (;;) {
        const v = value();
        if (v) return v;
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') {
          i++;
          return null;
        }
        return fail(
          text[i] === undefined
            ? 'Unexpected end of JSON'
            : `Expected ',' or ']' but found '${text[i]}'`,
        );
      }
    }
    if (c === '"') return str();
    const lit = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      text.slice(i),
    );
    if (lit) {
      i += lit[0].length;
      return null;
    }
    return fail(`Unexpected token '${c}'`);
  };
  const str = (): Err | null => {
    i++; // opening quote
    while (i < text.length) {
      const c = text[i]!;
      if (c === '"') {
        i++;
        return null;
      }
      if (c === '\\') {
        i++;
        if (!/["\\/bfnrtu]/.test(text[i] ?? '')) return fail('Bad escaped character');
      } else if (c < ' ') {
        return fail('Bad control character in string');
      }
      i++;
    }
    return fail('Unterminated string');
  };
  const err = value();
  if (err) return err;
  ws();
  if (i < text.length) return fail(`Unexpected token '${text[i]}' after the JSON value`);
  return null;
}

/** Parse JSON text; the error names the line and column of the first problem. */
export function parseJson(text: string): JsonParse {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    const found = locateJsonError(text);
    if (!found) return { ok: false, error: err instanceof Error ? err.message : String(err) };
    const before = text.slice(0, found.at);
    const line = before.split('\n').length;
    const col = found.at - before.lastIndexOf('\n');
    return { ok: false, error: `${found.message} (line ${line}, column ${col})` };
  }
}

/** Pretty-printed JSON text, or null when `text` is not valid JSON. */
export function prettyJson(text: string): string | null {
  const p = parseJson(text);
  return p.ok ? (JSON.stringify(p.value, null, 2) ?? 'null') : null;
}

/** Compact JSON text, or null when `text` is not valid JSON. */
export function minifyJson(text: string): string | null {
  const p = parseJson(text);
  return p.ok ? (JSON.stringify(p.value) ?? 'null') : null;
}

export type JsonPath = ReadonlyArray<string | number>;

/** Immutable set at `path` (the root is replaced for an empty path). */
export function jsonSetAt(root: unknown, path: JsonPath, value: unknown): unknown {
  if (path.length === 0) return value;
  const [head, ...rest] = path as [string | number, ...Array<string | number>];
  if (Array.isArray(root)) {
    const next = root.slice();
    next[Number(head)] = jsonSetAt(root[Number(head)], rest, value);
    return next;
  }
  const obj = root && typeof root === 'object' ? (root as Record<string, unknown>) : {};
  return { ...obj, [String(head)]: jsonSetAt(obj[String(head)], rest, value) };
}

/** Immutable delete of the key / array item at `path`. */
export function jsonDeleteAt(root: unknown, path: JsonPath): unknown {
  if (path.length === 0) return root;
  const [head, ...rest] = path as [string | number, ...Array<string | number>];
  if (rest.length > 0) {
    const child = Array.isArray(root)
      ? root[Number(head)]
      : (root as Record<string, unknown> | null)?.[String(head)];
    return jsonSetAt(root, [head], jsonDeleteAt(child, rest));
  }
  if (Array.isArray(root)) return root.filter((_, i) => i !== Number(head));
  if (root && typeof root === 'object') {
    const { [String(head)]: _gone, ...others } = root as Record<string, unknown>;
    return others;
  }
  return root;
}

/**
 * Interpret text typed into a tree leaf: a valid JSON literal (`12`, `true`,
 * `null`, `"x"`) keeps its type, anything else is a plain string.
 */
export function parseJsonLeaf(text: string): unknown {
  const t = text.trim();
  if (t === '') return '';
  try {
    const v = JSON.parse(t);
    return typeof v === 'object' && v !== null ? text : v;
  } catch {
    return text;
  }
}

/** Text shown for a leaf in the tree editor (strings are quoted, so `"1"` ≠ `1`). */
export function jsonLeafText(value: unknown): string {
  return JSON.stringify(value) ?? 'null';
}

// ─── Arrays ──────────────────────────────────────────────────────────

export type ArrayParse =
  | { ok: true; elements: Array<string | null> }
  | { ok: false; reason: string };

/**
 * Parse a one-dimensional Postgres array literal. Multi-dimensional arrays
 * and explicit bounds (`[0:2]={…}`) are reported as not editable as a list.
 */
export function parsePgArray(text: string): ArrayParse {
  const s = text.trim();
  if (s.startsWith('[')) return { ok: false, reason: 'arrays with explicit bounds' };
  if (!s.startsWith('{') || !s.endsWith('}')) return { ok: false, reason: 'not an array literal' };
  const inner = s.slice(1, -1);
  if (inner.trim() === '') return { ok: true, elements: [] };
  const out: Array<string | null> = [];
  let i = 0;
  while (i <= inner.length) {
    while (inner[i] === ' ' || inner[i] === '\t') i++;
    if (inner[i] === '{') return { ok: false, reason: 'multi-dimensional arrays' };
    let value = '';
    let quoted = false;
    if (inner[i] === '"') {
      quoted = true;
      i++;
      while (i < inner.length && inner[i] !== '"') {
        if (inner[i] === '\\') i++;
        value += inner[i] ?? '';
        i++;
      }
      if (inner[i] !== '"') return { ok: false, reason: 'unterminated quote' };
      i++;
      while (inner[i] === ' ' || inner[i] === '\t') i++;
    } else {
      const start = i;
      while (i < inner.length && inner[i] !== ',') {
        if (inner[i] === '{' || inner[i] === '}') return { ok: false, reason: 'unexpected brace' };
        if (inner[i] === '\\') i++;
        i++;
      }
      value = inner.slice(start, i).trim().replace(/\\(.)/g, '$1');
    }
    out.push(!quoted && value.toUpperCase() === 'NULL' ? null : value);
    if (i >= inner.length) break;
    if (inner[i] !== ',') return { ok: false, reason: 'unexpected character' };
    i++;
    if (i >= inner.length) {
      // trailing comma → one more empty element is a syntax error in Postgres
      return { ok: false, reason: 'trailing comma' };
    }
  }
  return { ok: true, elements: out };
}

function quoteArrayElement(s: string): string {
  if (s === '' || /^null$/i.test(s) || /[{}",\\\s]/.test(s)) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return s;
}

/** One-dimensional array literal from elements (null = SQL NULL element). */
export function formatPgArray(elements: ReadonlyArray<string | null>): string {
  return `{${elements.map((e) => (e === null ? 'NULL' : quoteArrayElement(e))).join(',')}}`;
}

const INT_RE = /^[+-]?\d+$/;
const NUM_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$|^[+-]?(?:nan|infinity)$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validation message for one typed element (null = fine or not checkable here). */
export function validateScalar(
  typeName: string | null | undefined,
  text: string,
  enumValues?: readonly string[] | null,
): string | null {
  if (enumValues && enumValues.length > 0) {
    return enumValues.includes(text) ? null : `"${text}" is not one of the enum labels`;
  }
  const t = baseType(typeName);
  switch (t) {
    case 'int2':
    case 'int4':
    case 'int8':
    case 'smallint':
    case 'integer':
    case 'bigint':
      return INT_RE.test(text.trim()) ? null : 'Expected a whole number';
    case 'float4':
    case 'float8':
    case 'numeric':
    case 'real':
    case 'double precision':
    case 'decimal':
      return NUM_RE.test(text.trim()) ? null : 'Expected a number';
    case 'bool':
    case 'boolean':
      return parseBool(text) === undefined ? 'Expected true or false' : null;
    case 'uuid':
      return isUuid(text.trim())
        ? null
        : 'Expected a UUID like 123e4567-e89b-12d3-a456-426614174000';
    case 'date':
    case 'time':
    case 'timetz':
    case 'timestamp':
    case 'timestamptz':
      return checkTemporal(t, text);
    default:
      return null;
  }
}

// ─── Booleans ────────────────────────────────────────────────────────

/** true / false / null for NULL, undefined when the text isn't a Postgres boolean. */
export function parseBool(text: string | null): boolean | null | undefined {
  if (text === null) return null;
  switch (text.trim().toLowerCase()) {
    case 't':
    case 'true':
    case 'y':
    case 'yes':
    case 'on':
    case '1':
      return true;
    case 'f':
    case 'false':
    case 'n':
    case 'no':
    case 'off':
    case '0':
      return false;
    default:
      return undefined;
  }
}

export type TriState = true | false | null;

/** NULL → true → false → NULL. */
export function cycleBool(state: TriState, backwards = false): TriState {
  const order: TriState[] = [null, true, false];
  const i = order.indexOf(state);
  return order[(i + (backwards ? order.length - 1 : 1)) % order.length] as TriState;
}

export function boolText(state: TriState): string | null {
  return state === null ? null : state ? 'true' : 'false';
}

// ─── UUID ────────────────────────────────────────────────────────────

export function isUuid(text: string): boolean {
  return UUID_RE.test(text);
}

/** A random (v4) UUID; `random` is injectable for tests. */
export function generateUuid(random?: (n: number) => Uint8Array): string {
  if (!random && typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = random ? random(16) : (crypto.getRandomValues(new Uint8Array(16)) as Uint8Array);
  const b = Uint8Array.from(bytes);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ─── Dates, times, timestamps ────────────────────────────────────────

export interface TemporalParts {
  /** `YYYY-MM-DD` or ''. */
  date: string;
  /** `HH:MM[:SS[.ffffff]]` or ''. */
  time: string;
  /** `Z`, `+05:30`, `-08` … or ''. */
  tz: string;
}

const SPECIAL_TEMPORAL = new Set([
  'infinity',
  '-infinity',
  'now',
  'today',
  'tomorrow',
  'yesterday',
  'epoch',
  'allballs',
]);

const DATE_RE = /^(\d{4,})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?$/;
const TZ_RE = /^(?:Z|[+-]\d{2}(?::?\d{2}(?::?\d{2})?)?)$/i;

/** Split Postgres date / time / timestamp text into picker parts; null when not splittable. */
export function splitTemporal(text: string, typeName: string): TemporalParts | null {
  const t = baseType(typeName);
  const s = text.trim();
  if (t === 'date') {
    return DATE_RE.test(s) ? { date: s, time: '', tz: '' } : null;
  }
  const tzMatch = /(Z|[+-]\d{2}(?::?\d{2}(?::?\d{2})?)?)$/i.exec(s);
  const hasTzType = t === 'timestamptz' || t === 'timetz';
  const tz = hasTzType && tzMatch ? tzMatch[1]! : '';
  const withoutTz = tz ? s.slice(0, s.length - tz.length).trimEnd() : s;
  if (t === 'time' || t === 'timetz') {
    return TIME_RE.test(withoutTz) ? { date: '', time: withoutTz, tz } : null;
  }
  const m = /^(\d{4,}-\d{2}-\d{2})[ T](.+)$/.exec(withoutTz);
  if (!m || !TIME_RE.test(m[2]!)) return null;
  return { date: m[1]!, time: m[2]!, tz };
}

/** Assemble Postgres text from picker parts. */
export function joinTemporal(parts: TemporalParts, typeName: string): string {
  const t = baseType(typeName);
  if (t === 'date') return parts.date;
  const time = normaliseTime(parts.time);
  if (t === 'time' || t === 'timetz') return `${time}${t === 'timetz' ? parts.tz : ''}`;
  return `${parts.date} ${time}${t === 'timestamptz' ? parts.tz : ''}`.trim();
}

/** `HH:MM` → `HH:MM:00` (pickers drop empty seconds). */
export function normaliseTime(time: string): string {
  if (/^\d{2}:\d{2}$/.test(time)) return `${time}:00`;
  return time;
}

/** Value for `<input type="datetime-local" step="1">` (no zone) or '' when unparseable. */
export function toDatetimeLocal(text: string, typeName: string): string {
  const p = splitTemporal(text, typeName);
  if (!p || !p.date) return '';
  return `${p.date}T${normaliseTime(p.time).replace(/(\.\d{3})\d+/, '$1')}`;
}

/** Back from a datetime-local value, keeping `tz` for timestamptz. */
export function fromDatetimeLocal(value: string, tz: string, typeName: string): string {
  const [date = '', time = ''] = value.split('T');
  return joinTemporal({ date, time, tz }, typeName);
}

/** Warning for text the structured picker can't make sense of (null = fine). */
export function checkTemporal(typeName: string, text: string): string | null {
  const s = text.trim();
  if (SPECIAL_TEMPORAL.has(s.toLowerCase())) return null;
  const parts = splitTemporal(s, typeName);
  if (!parts) return `Not a recognised ${baseType(typeName)} — the server will try to parse it`;
  const t = baseType(typeName);
  if (parts.date) {
    const m = DATE_RE.exec(parts.date)!;
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const days = new Date(Date.UTC(2000, mo, 0)).getUTCDate();
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    const max = mo === 2 ? (leap ? 29 : 28) : days;
    if (mo < 1 || mo > 12 || d < 1 || d > max) return `${parts.date} is not a real calendar date`;
  }
  if (parts.time && t !== 'date') {
    const m = TIME_RE.exec(parts.time)!;
    const [h, mi, se] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
    const midnight24 = h === 24 && mi === 0 && se === 0;
    if ((h > 23 && !midnight24) || mi > 59 || se > 59) return `${parts.time} is not a valid time`;
  }
  if (parts.tz && !TZ_RE.test(parts.tz)) return `Unrecognised time zone offset ${parts.tz}`;
  return null;
}

/** `+05:30` style offset for a JS offset in minutes east of UTC. */
export function formatOffset(minutesEast: number): string {
  const sign = minutesEast < 0 ? '-' : '+';
  const abs = Math.abs(minutesEast);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = abs % 60;
  return mm ? `${sign}${hh}:${String(mm).padStart(2, '0')}` : `${sign}${hh}`;
}

/** "Now" in the picker's text form, using the local clock (and local offset for timestamptz). */
export function nowText(typeName: string, now: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const date = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  const time = `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
  const tz = formatOffset(-now.getTimezoneOffset());
  switch (baseType(typeName)) {
    case 'date':
      return date;
    case 'time':
      return time;
    case 'timetz':
      return `${time}${tz}`;
    case 'timestamptz':
      return `${date} ${time}${tz}`;
    default:
      return `${date} ${time}`;
  }
}

/** The offset written in a timestamptz / timetz value ('' when none). */
export function offsetOf(text: string, typeName: string): string {
  return splitTemporal(text, typeName)?.tz ?? '';
}

/** Short zone label for the picker footer, e.g. "UTC+05:30 (Asia/Kolkata)". */
export function localZoneLabel(now: Date = new Date()): string {
  let name = '';
  try {
    name = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    // no Intl zone data
  }
  const off = formatOffset(-now.getTimezoneOffset());
  return name ? `UTC${off} (${name})` : `UTC${off}`;
}

// ─── bytea ───────────────────────────────────────────────────────────

/** Largest bytea (in bytes) the editor lets you change; bigger values are view-only. */
export const BYTEA_EDIT_MAX_BYTES = 4096;

/** Decode `\xDEADBEEF` hex text; null when it isn't hex-format bytea. */
export function byteaToBytes(text: string): Uint8Array | null {
  if (!/^\\x(?:[0-9a-fA-F]{2})*$/.test(text)) return null;
  const hex = text.slice(2);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToByteaText(bytes: ArrayLike<number>): string {
  let out = '\\x';
  for (let i = 0; i < bytes.length; i++) out += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  return out;
}

/** Size in bytes of a hex-format bytea text, or null. */
export function byteaSize(text: string): number | null {
  return /^\\x(?:[0-9a-fA-F]{2})*$/.test(text) ? (text.length - 2) / 2 : null;
}

export function byteaEditable(text: string | null): boolean {
  if (text === null) return true;
  const size = byteaSize(text);
  return size !== null && size <= BYTEA_EDIT_MAX_BYTES;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** Strict base64 decode (whitespace ignored); null when invalid. */
export function base64ToBytes(text: string): Uint8Array | null {
  const s = text.replace(/\s+/g, '');
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Hex view: `de ad be ef`, 16 bytes per line. */
export function formatHexView(bytes: Uint8Array): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    lines.push(
      [...bytes.subarray(i, i + 16)].map((b) => b.toString(16).padStart(2, '0')).join(' '),
    );
  }
  return lines.join('\n');
}

/** Parse hex typed by a user (`de ad`, `0xdead`, `\xDEAD`); null when not hex. */
export function parseHexInput(text: string): Uint8Array | null {
  const s = text.replace(/\s+/g, '').replace(/^\\x/i, '').replace(/^0x/i, '');
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) return null;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Human size, e.g. "1.5 KB". */
export function formatByteSize(n: number): string {
  if (n < 1024) return `${n} byte${n === 1 ? '' : 's'}`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
