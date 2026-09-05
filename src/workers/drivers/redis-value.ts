/**
 * Pure helpers for bounded Redis value retrieval (U17).
 *
 * Hashes use HSCAN with a field cap instead of HGETALL. Strings and
 * RedisJSON are gated by STRLEN / MEMORY USAGE so multi-megabyte values
 * are not pulled into the worker/renderer heaps wholesale.
 */

/** Soft cap on string / JSON payload bytes before we refuse to fetch. */
export const MAX_STRING_BYTES = 1_048_576; // 1 MiB

export type LargeValueStub = {
  truncated: true;
  sizeBytes: number;
  /** Human-readable reason the UI can show in place of the body. */
  error: string;
};

/** True when a measured size exceeds the fetch budget. null/undefined → unknown → do not gate. */
export function exceedsFetchBudget(
  sizeBytes: number | null | undefined,
  maxBytes: number = MAX_STRING_BYTES,
): boolean {
  return typeof sizeBytes === 'number' && Number.isFinite(sizeBytes) && sizeBytes > maxBytes;
}

/** Stub returned instead of the raw string/JSON when the value is too large. */
export function largeValueStub(sizeBytes: number, maxBytes: number = MAX_STRING_BYTES): LargeValueStub {
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
