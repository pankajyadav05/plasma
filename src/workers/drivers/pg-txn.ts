import type { TxnState } from '@shared/protocol';
import { isSingleSqlStatement } from '@shared/sql-statements';

/**
 * Transaction-aware helpers for the Postgres driver (C7, C31, F2, F4, F5).
 *
 * The transaction status always comes from the server: every
 * ReadyForQuery message carries `I` (idle), `T` (in a transaction block)
 * or `E` (in a failed transaction block). Nothing here guesses from SQL
 * text, so `-- note\nBEGIN`, `END`, `ABORT`, `COMMIT AND CHAIN`,
 * `ROLLBACK TO SAVEPOINT` and aborted transactions are all tracked
 * correctly.
 */
export type TxnStatus = 'I' | 'T' | 'E';

export function txnStateFromStatus(status: TxnStatus): TxnState {
  if (status === 'T') return 'active';
  if (status === 'E') return 'error';
  return 'none';
}

/** Minimal slice of `pg.Client` the helpers need (lets tests fake it). */
export interface SimpleClient {
  query(
    config: string | { text: string; values?: unknown[] },
  ): Promise<{ rowCount: number | null }>;
}

export interface EditUpdate {
  sql: string;
  params?: unknown[];
  label?: string;
}

const ABORTED_MESSAGE =
  'The current transaction has failed (aborted). Roll it back before running this.';

function pgErrorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as Error & { detail?: string; code?: string };
  const parts = [e.message];
  if (e.detail) parts.push(e.detail);
  // Callers append their own full stop.
  return parts.join(' — ').replace(/[.\s]+$/, '');
}

function describeEdit(updates: readonly EditUpdate[], i: number): string {
  const label = updates[i]?.label;
  return `Edit ${i + 1} of ${updates.length}${label ? ` (${label})` : ''}`;
}

/**
 * Apply a grid edit batch atomically.
 *
 * - Idle session → `BEGIN … COMMIT`.
 * - Inside the user's own transaction → `SAVEPOINT … RELEASE`, so the
 *   user's transaction stays open and is never committed by the tray.
 * - Aborted transaction → refused; nothing is sent.
 *
 * Every UPDATE must report `rowCount === 1`. Zero means the row changed or
 * was deleted since it was loaded (or the key no longer matches); more than
 * one means the key is not unique. Either way, and on any Postgres error,
 * the whole batch is rolled back and the error names the failing edit.
 */
export async function runEditBatch(
  client: SimpleClient,
  status: TxnStatus,
  updates: readonly EditUpdate[],
): Promise<number> {
  if (status === 'E') throw new Error(ABORTED_MESSAGE);
  const nested = status === 'T';
  await client.query(nested ? 'SAVEPOINT plasma_edit_batch' : 'BEGIN');
  try {
    for (let i = 0; i < updates.length; i++) {
      const update = updates[i]!;
      let rowCount: number | null;
      try {
        ({ rowCount } = await client.query({ text: update.sql, values: update.params }));
      } catch (err) {
        throw new Error(
          `${describeEdit(updates, i)} failed: ${pgErrorText(err)}. Nothing was saved.`,
        );
      }
      if (rowCount !== 1) {
        const n = rowCount ?? 0;
        const why =
          n === 0
            ? 'matched no row — it may have been changed or deleted since it was loaded'
            : `matched ${n} rows — the key does not identify a single row`;
        throw new Error(`${describeEdit(updates, i)} ${why}. Nothing was saved.`);
      }
    }
    await client.query(nested ? 'RELEASE SAVEPOINT plasma_edit_batch' : 'COMMIT');
    return updates.length;
  } catch (err) {
    try {
      if (nested) {
        await client.query('ROLLBACK TO SAVEPOINT plasma_edit_batch');
        await client.query('RELEASE SAVEPOINT plasma_edit_batch');
      } else {
        await client.query('ROLLBACK');
      }
    } catch {
      // The connection is gone or already rolled back; the original error matters.
    }
    throw err;
  }
}

/** EXPLAIN text for one statement. ANALYZE adds timing and buffers. */
export function buildExplainSql(sql: string, analyze: boolean): string {
  const stripped = sql.trim().replace(/;\s*$/, '');
  if (!isSingleSqlStatement(stripped)) {
    throw new Error('Explain takes exactly one statement.');
  }
  const options = analyze ? 'ANALYZE, BUFFERS, VERBOSE, FORMAT JSON' : 'VERBOSE, FORMAT JSON';
  return `EXPLAIN (${options}) ${stripped}`;
}

/**
 * Run EXPLAIN safely. Plain EXPLAIN never executes the statement. With
 * ANALYZE the statement does execute, so it always runs inside a
 * transaction that is rolled back (a savepoint when the user already has
 * a transaction open) — whatever it inserts, updates or deletes is undone.
 */
export async function runExplain<R>(
  client: SimpleClient,
  status: TxnStatus,
  sql: string,
  analyze: boolean,
  exec: (text: string) => Promise<R>,
): Promise<R> {
  const text = buildExplainSql(sql, analyze);
  if (!analyze) return exec(text);
  if (status === 'E') throw new Error(ABORTED_MESSAGE);
  const nested = status === 'T';
  await client.query(nested ? 'SAVEPOINT plasma_explain' : 'BEGIN');
  try {
    return await exec(text);
  } finally {
    if (nested) {
      await client.query('ROLLBACK TO SAVEPOINT plasma_explain');
      await client.query('RELEASE SAVEPOINT plasma_explain');
    } else {
      await client.query('ROLLBACK');
    }
  }
}
