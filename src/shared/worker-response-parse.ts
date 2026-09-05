/**
 * Hot-path worker response parsing (U15 step 3).
 *
 * Full `WorkerResponse.safeParse` walks every cell of every row via Zod.
 * For `queryResult` we validate the envelope + column metadata and trust
 * `rows` as an array-of-arrays already produced by our worker.
 */

import { ColumnMeta, type QueryResult, WorkerResponse } from './protocol';

export type ParseWorkerResponseResult =
  | { ok: true; data: WorkerResponse }
  | { ok: false; error: string; id: string | null };

function asRecord(raw: unknown): Record<string, unknown> | null {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return null;
}

/** Pull a correlation id off an untyped message (also used by U20). */
export function extractCorrelatedId(raw: unknown): string | null {
  const obj = asRecord(raw);
  if (!obj) return null;
  return typeof obj.id === 'string' && obj.id.length > 0 ? obj.id : null;
}

/**
 * Shallow-validate a queryResult payload without per-cell Zod walks.
 * Returns null when the shape is wrong so the caller can fall back or error.
 */
export function parseQueryResultEnvelope(raw: unknown): Extract<
  WorkerResponse,
  { kind: 'queryResult' }
> | null {
  const obj = asRecord(raw);
  if (!obj || obj.kind !== 'queryResult') return null;
  if (typeof obj.id !== 'string' || obj.id.length === 0) return null;

  const resultObj = asRecord(obj.result);
  if (!resultObj) return null;
  if (!Array.isArray(resultObj.columns) || !Array.isArray(resultObj.rows)) return null;
  if (typeof resultObj.rowCount !== 'number' || typeof resultObj.durationMs !== 'number') {
    return null;
  }

  const columnsParsed = ColumnMeta.array().safeParse(resultObj.columns);
  if (!columnsParsed.success) return null;

  // Trust row tuples from the worker — only confirm outer + first-row shape.
  const rowsUnknown = resultObj.rows;
  if (rowsUnknown.length > 0 && !Array.isArray(rowsUnknown[0])) return null;

  const truncated =
    typeof resultObj.truncated === 'boolean' ? resultObj.truncated : false;
  const command = typeof resultObj.command === 'string' ? resultObj.command : undefined;

  const result: QueryResult = {
    columns: columnsParsed.data,
    rows: rowsUnknown as unknown[][],
    rowCount: resultObj.rowCount,
    durationMs: resultObj.durationMs,
    truncated,
    ...(command !== undefined ? { command } : {}),
  };

  return { kind: 'queryResult', id: obj.id, result };
}

/**
 * Parse a worker → main message. queryResult uses the envelope fast path;
 * everything else goes through the full discriminated union.
 */
export function parseWorkerResponse(raw: unknown): ParseWorkerResponseResult {
  const obj = asRecord(raw);
  if (obj?.kind === 'queryResult') {
    const fast = parseQueryResultEnvelope(raw);
    if (fast) return { ok: true, data: fast };
    return {
      ok: false,
      error: 'invalid queryResult envelope',
      id: extractCorrelatedId(raw),
    };
  }

  // Broadcast progress chunks — validate lightly (rows trusted).
  if (obj?.kind === 'queryChunk') {
    const parsed = WorkerResponse.safeParse(raw);
    // Prefer a shallow path if full parse would walk cells — but QueryChunk
    // schema already uses a lightweight rows check (see protocol).
    if (parsed.success) return { ok: true, data: parsed.data };
    return {
      ok: false,
      error: parsed.error.message,
      id: extractCorrelatedId(raw),
    };
  }

  const parsed = WorkerResponse.safeParse(raw);
  if (parsed.success) return { ok: true, data: parsed.data };
  return {
    ok: false,
    error: parsed.error.message,
    id: extractCorrelatedId(raw),
  };
}
