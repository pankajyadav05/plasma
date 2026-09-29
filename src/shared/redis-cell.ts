/**
 * Binary-safe Redis values over IPC (R12).
 *
 * Redis values are byte strings. Decoding them as UTF-8 unconditionally
 * mangles protobuf / msgpack / compressed payloads — and writing the
 * mangled text back destroys the value. The worker therefore ships every
 * element as a `RedisCell`:
 *
 *   - a plain `string` when the bytes are valid UTF-8 and small, or
 *   - an object carrying base64 bytes (`$binary`) and/or a text preview,
 *     plus the true size and whether it was truncated for transport.
 *
 * Only plain-string cells are editable as text in the UI.
 */

export interface RedisCellObject {
  /** Base64 of the (possibly truncated) bytes when they are not valid UTF-8. */
  $binary?: string;
  /** UTF-8 text of the (possibly truncated) bytes when they are valid. */
  $text?: string;
  /** Full size of the value in bytes. */
  $bytes: number;
  /** The payload was cut to a preview for transport. */
  $truncated?: boolean;
}

export type RedisCell = string | RedisCellObject;

export function isCellObject(v: unknown): v is RedisCellObject {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as RedisCellObject).$bytes === 'number' &&
    ('$binary' in (v as object) || '$text' in (v as object))
  );
}

/** Plain, complete UTF-8 text — safe to edit and write back. */
export function isEditableCell(c: unknown): c is string {
  return typeof c === 'string';
}

export function isBinaryCell(c: unknown): boolean {
  return isCellObject(c) && typeof c.$binary === 'string';
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = globalThis.atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** redis-cli style escaping: printable ASCII verbatim, the rest as \xHH. */
export function escapeBytes(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    if (b === 0x5c) out += '\\\\';
    else if (b === 0x22) out += '\\"';
    else if (b === 0x0a) out += '\\n';
    else if (b === 0x0d) out += '\\r';
    else if (b === 0x09) out += '\\t';
    else if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b);
    else out += `\\x${b.toString(16).padStart(2, '0')}`;
  }
  return out;
}

export function hexBytes(bytes: Uint8Array, group = 2): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const row = bytes.slice(i, i + 16);
    const hex = Array.from(row, (b) => b.toString(16).padStart(2, '0'));
    const grouped: string[] = [];
    for (let j = 0; j < hex.length; j += group) grouped.push(hex.slice(j, j + group).join(''));
    const ascii = Array.from(row, (b) =>
      b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.',
    ).join('');
    parts.push(
      `${i.toString(16).padStart(8, '0')}  ${grouped.join(' ').padEnd(39, ' ')}  ${ascii}`,
    );
  }
  return parts.join('\n');
}

/** Raw bytes of a cell (UTF-8 encoded for text). */
export function cellBytes(c: RedisCell | null | undefined): Uint8Array {
  if (c == null) return new Uint8Array();
  if (typeof c === 'string') return new TextEncoder().encode(c);
  if (typeof c.$binary === 'string') return base64ToBytes(c.$binary);
  return new TextEncoder().encode(c.$text ?? '');
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

/** One-line display text for grids / Details. */
export function cellText(c: unknown): string | null {
  if (c === null || c === undefined) return null;
  if (typeof c === 'string') return c;
  if (!isCellObject(c)) return typeof c === 'object' ? JSON.stringify(c) : String(c);
  const body =
    typeof c.$binary === 'string' ? escapeBytes(base64ToBytes(c.$binary)) : (c.$text ?? '');
  return c.$truncated ? `${body}… (${fmtSize(c.$bytes)})` : body;
}

/** Short description of a non-plain cell for badges / tooltips. */
export function cellNote(c: unknown): string | null {
  if (!isCellObject(c)) return null;
  const parts: string[] = [];
  if (typeof c.$binary === 'string') parts.push('binary');
  if (c.$truncated) parts.push(`preview of ${fmtSize(c.$bytes)}`);
  else parts.push(fmtSize(c.$bytes));
  return parts.join(' · ');
}
