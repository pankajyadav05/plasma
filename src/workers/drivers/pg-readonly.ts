import type { TxnStatus } from './pg-txn';

/**
 * SC-02: server-side read-only enforcement that survives `RESET ALL`,
 * `DISCARD ALL`, `set_config(...)` and `DO` blocks.
 *
 * A transaction's read-only flag is fixed when the transaction starts, so
 * `SET default_transaction_read_only = on` once at connect time is not
 * enough: anything that clears the GUC makes the next transaction
 * read-write. Instead, before EVERY user statement:
 *
 *  - outside a transaction (`I`): re-assert the GUC, so the transaction the
 *    statement is about to start (implicit or the user's own BEGIN) is
 *    read-only;
 *  - inside a transaction (`T`): the flag is already fixed, so verify
 *    `transaction_read_only`. A transaction flipped to read-write (for
 *    example `SET TRANSACTION READ WRITE` as its own statement) is rolled
 *    back and the statement is refused;
 *  - aborted (`E`): nothing can write, and SHOW would fail; skip.
 */
export interface ReadOnlyClient {
  query(text: string): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export const READ_ONLY_SWITCHED_MESSAGE =
  'Read-only connection: this transaction was switched to read-write, so it has been rolled back.';

export async function enforceReadOnlySession(
  client: ReadOnlyClient,
  status: TxnStatus,
): Promise<void> {
  if (status === 'E') return;
  if (status === 'I') {
    await client.query('SET default_transaction_read_only = on');
    return;
  }
  let res: Awaited<ReturnType<ReadOnlyClient['query']>>;
  try {
    res = await client.query('SHOW transaction_read_only');
  } catch (err) {
    // The driver's view of the status can lag the server's by one message
    // after a failed statement; an aborted transaction cannot write.
    if ((err as { code?: string }).code === '25P02') return;
    throw err;
  }
  const value = res.rows[0]?.transaction_read_only;
  if (value !== 'on') {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw new Error(READ_ONLY_SWITCHED_MESSAGE);
  }
}
