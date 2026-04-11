import { getDb } from './db';

/**
 * Query history — records every executed query (success or failure)
 * in SQLite for later recall. Capped at 5000 entries; oldest are
 * pruned on insert.
 */

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

export function listHistory(opts: { limit?: number; connectionId?: string } = {}): HistoryEntry[] {
  const limit = opts.limit ?? 500;
  const db = getDb();
  const rows = opts.connectionId
    ? db
        .prepare<[string, number], HistoryRow>(
          `SELECT * FROM query_history
             WHERE connection_id = ?
             ORDER BY executed_at DESC
             LIMIT ?`,
        )
        .all(opts.connectionId, limit)
    : db
        .prepare<[number], HistoryRow>(
          `SELECT * FROM query_history
             ORDER BY executed_at DESC
             LIMIT ?`,
        )
        .all(limit);
  return rows.map(fromRow);
}

export function clearHistory(): void {
  getDb().prepare('DELETE FROM query_history').run();
}
