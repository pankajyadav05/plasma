import { getDb } from './db';
import { type HistoryListOpts, buildHistoryListQuery } from './history-query';

/**
 * Query history — records every executed query (success or failure)
 * in SQLite for later recall. Capped at 5000 entries; oldest are
 * pruned on insert.
 *
 * List/search is server-side (U35): LIKE + connection/status/duration
 * facets, using the existing `(connection_id, executed_at)` index.
 */

export type { HistoryListOpts } from './history-query';
export {
  HISTORY_DURATION_MS,
  buildHistoryListQuery,
  escapeLike,
  type HistoryDurationFacet,
  type HistoryStatusFacet,
} from './history-query';

const MAX_HISTORY_ROWS = 5000;

export interface HistoryEntry {
  id: number;
  connectionId: string | null;
  sql: string;
  rowCount: number | null;
  durationMs: number | null;
  error: string | null;
  executedAt: number;
}

interface HistoryRow {
  id: number;
  connection_id: string | null;
  sql: string;
  row_count: number | null;
  duration_ms: number | null;
  error: string | null;
  executed_at: number;
}

function fromRow(r: HistoryRow): HistoryEntry {
  return {
    id: r.id,
    connectionId: r.connection_id,
    sql: r.sql,
    rowCount: r.row_count,
    durationMs: r.duration_ms,
    error: r.error,
    executedAt: r.executed_at,
  };
}

export function recordHistory(entry: Omit<HistoryEntry, 'id'>): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO query_history
         (connection_id, sql, row_count, duration_ms, error, executed_at)
         VALUES (@connectionId, @sql, @rowCount, @durationMs, @error, @executedAt)`,
    ).run(entry);
    // Prune if we're over the cap
    db.prepare(
      `DELETE FROM query_history
         WHERE id IN (
           SELECT id FROM query_history
             ORDER BY executed_at DESC
             LIMIT -1 OFFSET ?
         )`,
    ).run(MAX_HISTORY_ROWS);
  });
  tx();
}

export function listHistory(opts: HistoryListOpts = {}): HistoryEntry[] {
  const db = getDb();
  const { sql, params } = buildHistoryListQuery(opts);
  const rows = db.prepare<unknown[], HistoryRow>(sql).all(...params);
  return rows.map(fromRow);
}

/**
 * Most recent successful (or any) statement for a connection — used by
 * ⌘↑ recall when the editor buffer is empty (psql muscle memory).
 */
export function latestHistory(opts: {
  connectionId?: string;
  preferOk?: boolean;
} = {}): HistoryEntry | null {
  const preferOk = opts.preferOk !== false;
  const entries = listHistory({
    limit: preferOk ? 20 : 1,
    connectionId: opts.connectionId,
    status: preferOk ? 'ok' : 'all',
  });
  if (entries.length > 0) return entries[0]!;
  if (preferOk) {
    const any = listHistory({ limit: 1, connectionId: opts.connectionId });
    return any[0] ?? null;
  }
  return null;
}

export function clearHistory(): void {
  getDb().prepare('DELETE FROM query_history').run();
}
