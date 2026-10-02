/**
 * Pure helpers for bounded Redis value retrieval (U17).
 *
 * Hashes use HSCAN with a field cap instead of HGETALL. Strings and
 * RedisJSON are gated by STRLEN / MEMORY USAGE so multi-megabyte values
 * are not pulled into the worker/renderer heaps wholesale.
 */

import { type RedisCell, escapeBytes } from '@shared/redis-cell';

/** Soft cap on string / JSON payload bytes before we refuse to fetch. */
export const MAX_STRING_BYTES = 1_048_576; // 1 MiB

export type LargeValueStub = {
  truncated: true;
  sizeBytes: number;
  /** Human-readable reason the UI can show in place of the body. */
  error: string;
  /** First LARGE_PREVIEW_BYTES of the value (GETRANGE), when available. */
  preview?: RedisCell | null;
};

/** True when a measured size exceeds the fetch budget. null/undefined → unknown → do not gate. */
export function exceedsFetchBudget(
  sizeBytes: number | null | undefined,
  maxBytes: number = MAX_STRING_BYTES,
): boolean {
  return typeof sizeBytes === 'number' && Number.isFinite(sizeBytes) && sizeBytes > maxBytes;
}

/** Stub returned instead of the raw string/JSON when the value is too large. */
export function largeValueStub(
  sizeBytes: number,
  maxBytes: number = MAX_STRING_BYTES,
): LargeValueStub {
  return {
    truncated: true,
    sizeBytes,
    error: `value too large (${formatBytes(sizeBytes)}); not fetched (limit ${formatBytes(maxBytes)})`,
  };
}

/** Pair HSCAN's flat [field, value, field, value, ...] reply into tuples. */
export function pairsFromHscanFlat(flat: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    out.push([flat[i]!, flat[i + 1]!]);
  }
  return out;
}

/**
 * Append one HSCAN page into `items`, stopping once `cap` fields are held.
 * Returns whether the caller should stop scanning (cap reached).
 */
export function accumulateHashFields(
  items: [string, string][],
  flat: string[],
  cap: number,
): boolean {
  for (const pair of pairsFromHscanFlat(flat)) {
    if (items.length >= cap) return true;
    items.push(pair);
  }
  return items.length >= cap;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

// ───────────────────────── Binary-safe cells (R11 / R12) ─────────────────────────

/** Per-element transport cap for collection members / field values. */
export const MAX_ELEMENT_BYTES = 64 * 1024;
/** Soft budget for all element bytes in one key page. */
export const MAX_PAGE_BYTES = 4 * 1024 * 1024;
/** Preview size for strings that exceed MAX_STRING_BYTES. */
export const LARGE_PREVIEW_BYTES = 64 * 1024;

const utf8 = new TextDecoder('utf-8', { fatal: true });

function tryUtf8(buf: Uint8Array): string | null {
  try {
    return utf8.decode(buf);
  } catch {
    return null;
  }
}

/**
 * Encode one Redis value for IPC. Valid UTF-8 within `maxBytes` → plain
 * string; otherwise an object with base64 bytes or a text preview and the
 * real size. Never a lossy decode.
 */
export function encodeCell(
  input: Buffer | string | null | undefined,
  maxBytes: number = MAX_ELEMENT_BYTES,
  totalBytes?: number,
): RedisCell | null {
  if (input === null || input === undefined) return null;
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  const size = totalBytes ?? buf.length;
  if (buf.length <= maxBytes && size <= buf.length) {
    const text = tryUtf8(buf);
    if (text !== null) return text;
    return { $binary: buf.toString('base64'), $bytes: size };
  }
  // Truncated preview. Trim up to 3 trailing bytes so a multi-byte
  // character cut in half doesn't turn valid text into "binary".
  const slice = buf.subarray(0, Math.min(maxBytes, buf.length));
  for (let trim = 0; trim <= 3 && trim < slice.length; trim++) {
    const text = tryUtf8(slice.subarray(0, slice.length - trim));
    if (text !== null) return { $text: text, $bytes: size, $truncated: true };
  }
  return { $binary: slice.toString('base64'), $bytes: size, $truncated: true };
}

/** Bytes an encoded cell costs on the wire (approximate). */
export function cellCost(c: RedisCell | null): number {
  if (c === null) return 0;
  if (typeof c === 'string') return c.length;
  return (c.$binary?.length ?? 0) + (c.$text?.length ?? 0) + 32;
}

/** Render a reply for the CLI: Buffers become text, or redis-cli style escapes when binary. */
export function serializeCliReply(reply: unknown): unknown {
  if (reply === null || reply === undefined) return null;
  if (Buffer.isBuffer(reply)) {
    const text = tryUtf8(reply);
    return text !== null ? text : `"${escapeBytes(reply)}"`;
  }
  if (Array.isArray(reply)) return reply.map(serializeCliReply);
  if (typeof reply === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(reply as Record<string, unknown>)) {
      out[k] = serializeCliReply(v);
    }
    return out;
  }
  return reply;
}

/** Elements fetched by the first read of a list / sorted set page. */
export const FIRST_ELEMENT_WINDOW = 25;

/**
 * How many elements to fetch next, from the average element weight seen so
 * far (or MEMORY USAGE / length for the first read). Keeps a page of huge
 * elements from being pulled whole before MAX_PAGE_BYTES is applied (P2-10).
 */
export function elementWindow(
  avgBytes: number | null,
  max: number,
  first = false,
  budget: number = MAX_PAGE_BYTES,
): number {
  const ceiling = first ? Math.min(max, FIRST_ELEMENT_WINDOW) : max;
  if (avgBytes === null || !Number.isFinite(avgBytes) || avgBytes <= 0) return ceiling;
  // Aim for a quarter of the page budget per round trip.
  return Math.max(1, Math.min(ceiling, Math.floor(budget / 4 / avgBytes)));
}
