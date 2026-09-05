/**
 * Pure SQL builders for query-history list/filter. Kept free of Electron /
 * better-sqlite3 so vitest can cover the filter clauses without a native
 * binding or app bootstrap.
 */

export type HistoryStatusFacet = 'all' | 'ok' | 'error';
export type HistoryDurationFacet = 'all' | 'fast' | 'medium' | 'slow';

/** Duration facet thresholds (ms). Fast < 100, medium 100–1000, slow > 1000. */
export const HISTORY_DURATION_MS = {
  fastMax: 100,
  mediumMax: 1000,
} as const;

export interface HistoryListOpts {
  limit?: number;
  connectionId?: string;
  /** Case-insensitive substring match against SQL text (server-side LIKE). */
  search?: string;
  status?: HistoryStatusFacet;
  duration?: HistoryDurationFacet;
}

export interface HistoryListQuery {
  sql: string;
  params: Array<string | number>;
}

/** Escape `\`, `%`, and `_` so user input is matched literally under LIKE. */
export function escapeLike(raw: string): string {
  return raw.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Build a SELECT against `query_history` that uses the existing
 * `(connection_id, executed_at)` index when a connection filter is set,
 * plus optional LIKE / status / duration facets.
 */
export function buildHistoryListQuery(opts: HistoryListOpts = {}): HistoryListQuery {
  const limit = Math.max(1, Math.min(opts.limit ?? 500, 5000));
  const where: string[] = [];
  const params: Array<string | number> = [];

  if (opts.connectionId) {
    where.push('connection_id = ?');
    params.push(opts.connectionId);
  }

  const search = opts.search?.trim();
  if (search) {
    // ESCAPE '\' so literal %/_ from the user don't act as wildcards.
    where.push(`sql LIKE ? ESCAPE '\\'`);
    params.push(`%${escapeLike(search)}%`);
  }

  if (opts.status === 'ok') {
    where.push('error IS NULL');
  } else if (opts.status === 'error') {
    where.push('error IS NOT NULL');
  }

  if (opts.duration === 'fast') {
    where.push('duration_ms IS NOT NULL AND duration_ms < ?');
    params.push(HISTORY_DURATION_MS.fastMax);
  } else if (opts.duration === 'medium') {
    where.push('duration_ms IS NOT NULL AND duration_ms >= ? AND duration_ms <= ?');
    params.push(HISTORY_DURATION_MS.fastMax, HISTORY_DURATION_MS.mediumMax);
  } else if (opts.duration === 'slow') {
    where.push('duration_ms IS NOT NULL AND duration_ms > ?');
    params.push(HISTORY_DURATION_MS.mediumMax);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const sql = `SELECT * FROM query_history
             ${whereSql}
             ORDER BY executed_at DESC
             LIMIT ?`;
  params.push(limit);
  return { sql, params };
}
