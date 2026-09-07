/**
 * Pure helpers for the OpenSearch driver (U22).
 *
 * Kept free of the client so unit tests can pin:
 * - SQL plugin fallback only on missing-endpoint (404)
 * - collision-free, request-local aggregation IDs for fieldStats
 */

import type { OsFieldStats } from '@shared/protocol';

/**
 * True when the OpenSearch/ES client error reports HTTP 404 — the only
 * case where falling back from `/_plugins/_sql` to legacy `/_sql` is
 * appropriate. Auth failures, bad SQL, timeouts, etc. must surface as-is.
 */
export function isMissingSqlEndpointError(err: unknown): boolean {
  const status = readHttpStatus(err);
  return status === 404;
}

function readHttpStatus(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as {
    statusCode?: unknown;
    meta?: { statusCode?: unknown; body?: { status?: unknown } };
  };
  // Prefer the client's statusCode getter when present (ResponseError prefers
  // meta.body.status, then meta.statusCode).
  if (typeof e.statusCode === 'number') return e.statusCode;
  // Mirror that preference for plain meta shapes used in tests/mocks.
  if (e.meta?.body && typeof e.meta.body.status === 'number') return e.meta.body.status;
  if (e.meta && typeof e.meta.statusCode === 'number') return e.meta.statusCode;
  return null;
}

/**
 * Build cardinality + terms aggregations keyed by request-local IDs
 * (`card_0`, `top_0`, …). Index-based IDs never collide across fields
 * like `user.id` vs `user_id` (which lossy sanitization would merge).
 */
export function buildFieldStatsAggs(fields: string[]): Record<string, unknown> {
  const aggs: Record<string, unknown> = {};
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    aggs[`card_${i}`] = { cardinality: { field } };
    aggs[`top_${i}`] = { terms: { field, size: 10 } };
  }
  return aggs;
}

/** Aggregation alias for the cardinality bucket of field `fields[i]`. */
export function fieldStatsCardKey(index: number): string {
  return `card_${index}`;
}

/** Aggregation alias for the terms bucket of field `fields[i]`. */
export function fieldStatsTopKey(index: number): string {
  return `top_${index}`;
}

/**
 * Map one field's aggregation reply into OsFieldStats using the same
 * request-local index that `buildFieldStatsAggs` used.
 */
export function readFieldStat(
  field: string,
  index: number,
  aggData: Record<string, unknown>,
  type: string | null,
): OsFieldStats {
  const card = aggData[fieldStatsCardKey(index)] as { value?: number } | undefined;
  const top = aggData[fieldStatsTopKey(index)] as
    | { buckets?: Array<{ key: unknown; doc_count: number }> }
    | undefined;
  return {
    field,
    type,
    cardinality: card && typeof card.value === 'number' ? Math.round(card.value) : null,
    topValues: (top?.buckets ?? []).map((b) => ({
      value: String(b.key),
      count: b.doc_count,
    })),
    isTime: type === 'date' || type === 'date_nanos',
  };
}
