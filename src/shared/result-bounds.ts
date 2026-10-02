/**
 * Worker-side result bounds (U15 step 1).
 *
 * Arbitrary SQL used to buffer the entire pg result before IPC. Cap rows
 * and estimated payload bytes while reading via pg-cursor so worker/main/
 * renderer heaps stay bounded. `truncated: true` on QueryResult tells the
 * UI the result is a prefix, not the full set.
 */

/** Soft cap on rows retained from a single query. */
export const MAX_RESULT_ROWS = 10_000;

/** Soft cap on estimated retained payload bytes (UTF-16-ish). */
export const MAX_RESULT_BYTES = 32 * 1024 * 1024; // 32 MiB

/** Hard ceiling for a user-configured byte cap (P2-3). */
export const MAX_RESULT_BYTES_CEILING = 256 * 1024 * 1024; // 256 MiB

/** Rows requested per pg-cursor EXECUTE (upper bound). */
export const RESULT_CURSOR_CHUNK = 500;

/** First read is small: row width is unknown until something arrives. */
export const FIRST_CURSOR_CHUNK = 100;

/** Target estimated size of one cursor read. */
const TARGET_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Rows to ask for next, from the weight of the batch just read: wide rows
 * (big text/jsonb/bytea) shrink the read so one fetch can't buffer
 * hundreds of megabytes before the byte cap is checked.
 */
export function nextCursorChunk(lastBatch: readonly unknown[][]): number {
  if (lastBatch.length === 0) return FIRST_CURSOR_CHUNK;
  let bytes = 0;
  for (const row of lastBatch) bytes += estimateRowBytes(row);
  const avg = Math.max(1, bytes / lastBatch.length);
  return Math.max(1, Math.min(RESULT_CURSOR_CHUNK, Math.floor(TARGET_CHUNK_BYTES / avg)));
}

export type BoundAccumulateState = {
  rows: unknown[][];
  bytes: number;
  truncated: boolean;
};

export function emptyBoundState(): BoundAccumulateState {
  return { rows: [], bytes: 0, truncated: false };
}

/** Rough per-cell size for the byte budget — not a wire encoding. */
export function estimateCellBytes(cell: unknown): number {
  if (cell === null || cell === undefined) return 4;
  switch (typeof cell) {
    case 'string':
      return cell.length * 2;
    case 'number':
    case 'boolean':
      return 8;
    case 'bigint':
      return 24;
    case 'object': {
      if (cell instanceof Date) return 24;
      if (typeof Buffer !== 'undefined' && Buffer.isBuffer(cell)) return cell.byteLength;
      if (ArrayBuffer.isView(cell)) return cell.byteLength;
      try {
        return JSON.stringify(cell).length * 2;
      } catch {
        return 64;
      }
    }
    default:
      return String(cell).length * 2;
  }
}

export function estimateRowBytes(row: unknown[]): number {
  let n = 8; // row overhead
  for (const cell of row) n += estimateCellBytes(cell);
  return n;
}

/**
 * Append rows from a cursor batch until row/byte caps trip.
 * Returns whether the caller should stop reading (cap hit or empty batch).
 */
export function appendBoundedRows(
  state: BoundAccumulateState,
  batch: readonly unknown[][],
  maxRows: number = MAX_RESULT_ROWS,
  maxBytes: number = MAX_RESULT_BYTES,
): boolean {
  if (batch.length === 0) return true;
  for (const row of batch) {
    const rowBytes = estimateRowBytes(row as unknown[]);
    if (state.rows.length >= maxRows || state.bytes + rowBytes > maxBytes) {
      state.truncated = true;
      return true;
    }
    state.rows.push(row as unknown[]);
    state.bytes += rowBytes;
  }
  return false;
}
