import { buildBeforeSelect, parseDml, withReturning } from '@shared/dml-parse';
import type { ColumnMeta, SafeRunReport } from '@shared/protocol';
import { SAFE_RUN_ROW_CAP } from '@shared/protocol';
import { looksLikeWriteSql } from '@shared/sql-statements';
import type { TxnStatus } from './pg-txn';

/**
 * Safe Run (worker side): run one write inside a held-open transaction (a
 * savepoint when the user already has one) and describe what it did.
 *
 *   1. BEGIN / SAVEPOINT
 *   2. optional plain EXPLAIN for the planner's row estimate
 *   3. UPDATE / DELETE: SELECT … FOR UPDATE of the rows about to change
 *   4. the statement itself, with RETURNING appended when it has none
 *
 * The transaction is left open; `finishSafeRun` commits or rolls it back.
 * Every auxiliary step (probing the catalog, EXPLAIN, the BEFORE snapshot)
 * runs under its own savepoint, so a failure there degrades the report
 * instead of aborting the user's write.
 */

const SP_RUN = 'plasma_safe_run';
const SP_STEP = 'plasma_safe_step';
const CTID_COL = '__plasma_ctid';
const ABORTED_MESSAGE =
  'The current transaction has failed (aborted). Roll it back before running a Safe Run.';

export interface CappedRead {
  columns: ColumnMeta[];
  rows: unknown[][];
  /** Rows the server produced (counted past the cap, up to a ceiling). */
  total: number;
  /** False when counting stopped at the ceiling. */
  exact: boolean;
  /** Command tag row count for statements that return no rows. */
  commandRowCount: number | undefined;
}

export interface SafeRunDeps {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  /** Cursor read that keeps the first `cap` rows and counts the rest. */
  readCapped(sql: string, cap: number): Promise<CappedRead>;
  status: TxnStatus;
}

export interface SafeRunStart {
  runId: string;
  sql: string;
  explain: boolean;
  rowCap?: number;
}

export type SafeRunBody = Omit<SafeRunReport, 'expiresAt' | 'timeoutSec' | 'txnState'>;

/** Run `fn` under a savepoint; any failure is undone and reported as null. */
async function attempt<T>(deps: SafeRunDeps, fn: () => Promise<T>): Promise<T | null> {
  await deps.query(`SAVEPOINT ${SP_STEP}`);
  try {
    const out = await fn();
    await deps.query(`RELEASE SAVEPOINT ${SP_STEP}`);
    return out;
  } catch {
    try {
      await deps.query(`ROLLBACK TO SAVEPOINT ${SP_STEP}`);
      await deps.query(`RELEASE SAVEPOINT ${SP_STEP}`);
    } catch {
      // The connection is gone; the caller's next query reports it.
    }
    return null;
  }
}

function stripCtid(read: CappedRead): { read: CappedRead; ctids: string[] | null } {
  if (read.columns[0]?.name === CTID_COL) {
    return {
      ctids: read.rows.map((r) => String(r[0])),
      read: { ...read, columns: read.columns.slice(1), rows: read.rows.map((r) => r.slice(1)) },
    };
  }
  const last = read.columns.length - 1;
  if (last >= 0 && read.columns[last]?.name === CTID_COL) {
    return {
      ctids: read.rows.map((r) => String(r[last])),
      read: {
        ...read,
        columns: read.columns.slice(0, last),
        rows: read.rows.map((r) => r.slice(0, last)),
      },
    };
  }
  return { read, ctids: null };
}

interface KeyInfo {
  kind: SafeRunReport['keyKind'];
  columns: string[];
}

async function findKey(deps: SafeRunDeps, oid: number, ctidOk: boolean): Promise<KeyInfo> {
  const pk = await attempt(deps, () =>
    deps.query(
      `SELECT a.attname::text AS name
         FROM pg_index i
         JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
        WHERE i.indrelid = $1::oid AND i.indisprimary
        ORDER BY k.ord`,
      [oid],
    ),
  );
  if (pk && pk.rows.length > 0) return { kind: 'pk', columns: pk.rows.map((r) => String(r.name)) };

  // A plain unique index over NOT NULL columns identifies rows just as well.
  const uq = await attempt(deps, () =>
    deps.query(
      `SELECT i.indexrelid::int8 AS idx, a.attname::text AS name, k.ord
         FROM pg_index i
         JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord) ON k.attnum > 0
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
        WHERE i.indrelid = $1::oid AND i.indisunique AND i.indimmediate AND i.indisvalid
          AND i.indpred IS NULL AND i.indexprs IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM unnest(i.indkey::int2[]) x
             WHERE x = 0 OR NOT (SELECT attnotnull FROM pg_attribute
                                  WHERE attrelid = i.indrelid AND attnum = x))
        ORDER BY i.indnatts, i.indexrelid, k.ord`,
      [oid],
    ),
  );
  if (uq && uq.rows.length > 0) {
    const first = String(uq.rows[0]!.idx);
    return {
      kind: 'unique',
      columns: uq.rows.filter((r) => String(r.idx) === first).map((r) => String(r.name)),
    };
  }
  return { kind: ctidOk ? 'ctid' : 'none', columns: [] };
}

function planRows(plan: unknown): number | null {
  const root = Array.isArray(plan) ? plan[0] : plan;
  let node = (root as { Plan?: Record<string, unknown> } | undefined)?.Plan;
  // A ModifyTable node reports 0 rows when nothing is RETURNed; its child
  // is the scan that finds the rows to change.
  while (node && node['Node Type'] === 'ModifyTable') {
    const kids = node.Plans;
    node = Array.isArray(kids) ? (kids[0] as Record<string, unknown> | undefined) : undefined;
  }
  const rows = node?.['Plan Rows'];
  return typeof rows === 'number' && Number.isFinite(rows) ? rows : null;
}

/** Begin, run and describe. Leaves the transaction open on success; rolls it back on error. */
export async function startSafeRun(
  deps: SafeRunDeps,
  req: SafeRunStart,
): Promise<{ body: SafeRunBody; nested: boolean }> {
  const cap = req.rowCap ?? SAFE_RUN_ROW_CAP;
  const parsed = parseDml(req.sql);
  if (parsed.kind === 'other') {
    throw new Error(
      parsed.reason === 'more than one statement'
        ? 'Safe Run takes exactly one statement.'
        : 'Safe Run takes a single INSERT, UPDATE, DELETE or MERGE statement.',
    );
  }
  if (parsed.kind === 'cte' && !looksLikeWriteSql(parsed.sql)) {
    throw new Error('Safe Run takes a statement that changes data; this one only reads.');
  }
  if (deps.status === 'E') throw new Error(ABORTED_MESSAGE);

  const nested = deps.status === 'T';
  await deps.query(nested ? `SAVEPOINT ${SP_RUN}` : 'BEGIN');
  try {
    const started = Date.now();
    const notes: string[] = [];

    const ver = await attempt(deps, () => deps.query('SHOW server_version_num'));
    const serverVersionNum = Number(Object.values(ver?.rows[0] ?? {})[0] ?? 0) || 0;

    // The target relation: what kind it is and how its rows are identified.
    let relkind: string | null = null;
    let oid: number | null = null;
    let hasChildren = false;
    if (parsed.target) {
      const rel = await attempt(deps, () =>
        deps.query(
          `SELECT c.oid::int8 AS oid, c.relkind::text AS relkind, c.relhassubclass AS kids
             FROM pg_class c WHERE c.oid = to_regclass($1)`,
          [parsed.target!.sql],
        ),
      );
      const row = rel?.rows[0];
      if (row) {
        oid = Number(row.oid);
        relkind = String(row.relkind);
        hasChildren = row.kids === true;
      }
    }
    const plainTable = relkind === 'r' && !hasChildren;
    const key: KeyInfo =
      oid !== null && relkind !== null && (relkind === 'r' || relkind === 'p')
        ? await findKey(deps, oid, plainTable)
        : { kind: 'none', columns: [] };

    // Planner estimate. Plain EXPLAIN: the statement is parsed and planned, never run.
    let estimateRows: number | null = null;
    if (req.explain) {
      const plan = await attempt(deps, () =>
        deps.query(`EXPLAIN (FORMAT JSON) ${parsed.sql.replace(/\s*;\s*$/, '')}`),
      );
      estimateRows = planRows(plan?.rows[0]?.['QUERY PLAN']);
    }

    // BEFORE rows: only for a single plain table, so the SELECT is exactly the write's row set.
    let before: CappedRead | null = null;
    let beforeCtids: string[] | null = null;
    const snapshotOk = parsed.beforeSnapshot && (relkind === 'r' || relkind === 'p');
    if (parsed.kind === 'update' || parsed.kind === 'delete') {
      const sel = snapshotOk
        ? buildBeforeSelect(parsed, { ctid: key.kind === 'ctid' && plainTable })
        : null;
      if (sel) {
        const read = await attempt(deps, () => deps.readCapped(sel, cap));
        if (read) {
          const stripped = stripCtid(read);
          before = stripped.read;
          beforeCtids = stripped.ctids;
        } else {
          notes.push('The rows before the change could not be read; showing the result only.');
        }
      } else {
        const why = parsed.reason ?? (relkind === null ? 'the target table was not found' : null);
        if (why) notes.push(`Rows before the change are not shown: ${why}.`);
        else if (relkind !== 'r' && relkind !== 'p') {
          notes.push('Rows before the change are not shown: the target is not a plain table.');
        }
      }
    }

    // The write itself.
    const wantCtid = key.kind === 'ctid' && plainTable;
    let finalSql = withReturning(parsed, { ctid: wantCtid, serverVersionNum });
    if (finalSql === null) {
      finalSql = parsed.sql.replace(/\s*;\s*$/, '');
      if (parsed.kind === 'merge' && !parsed.hasReturning && serverVersionNum < 170000) {
        notes.push('MERGE ... RETURNING needs PostgreSQL 17; only the row count is shown.');
      }
      if (parsed.hasReturning && (parsed.kind === 'update' || parsed.kind === 'delete')) {
        notes.push('The statement has its own RETURNING; its columns are shown.');
      }
    }
    const written = await deps.readCapped(finalSql, cap);
    const afterStripped = stripCtid(written);
    const afterRead = afterStripped.read;
    const returnsRows = afterRead.columns.length > 0;
    const affected = returnsRows ? written.total : (written.commandRowCount ?? 0);

    const snapshot = before !== null;
    const body: SafeRunBody = {
      runId: req.runId,
      kind: parsed.kind as SafeRunBody['kind'],
      statement: parsed.sql,
      nested,
      affected,
      affectedExact: written.exact,
      estimateRows,
      mode: snapshot ? 'diff' : 'after-only',
      note: notes.length > 0 ? notes.join(' ') : null,
      keyKind: snapshot ? key.kind : 'none',
      keyColumns: key.columns,
      beforeColumns: before?.columns ?? [],
      before: before?.rows ?? null,
      beforeCtids: beforeCtids,
      beforeTotal: before?.total ?? 0,
      afterColumns: afterRead.columns,
      after: afterRead.rows,
      afterCtids: afterStripped.ctids,
      afterTotal: returnsRows ? written.total : 0,
      durationMs: Date.now() - started,
    };
    return { body, nested };
  } catch (err) {
    await rollbackSafe(deps, nested);
    throw err;
  }
}

async function rollbackSafe(deps: Pick<SafeRunDeps, 'query'>, nested: boolean): Promise<void> {
  try {
    if (nested) {
      await deps.query(`ROLLBACK TO SAVEPOINT ${SP_RUN}`);
      await deps.query(`RELEASE SAVEPOINT ${SP_RUN}`);
    } else {
      await deps.query('ROLLBACK');
    }
  } catch {
    // The connection is gone or already rolled back; the caller reports the original problem.
  }
}

/** Commit (COMMIT / RELEASE) or roll back (ROLLBACK / ROLLBACK TO + RELEASE). */
export async function finishSafeRun(
  deps: Pick<SafeRunDeps, 'query'>,
  nested: boolean,
  action: 'commit' | 'rollback',
): Promise<void> {
  if (action === 'rollback') {
    if (nested) {
      await deps.query(`ROLLBACK TO SAVEPOINT ${SP_RUN}`);
      await deps.query(`RELEASE SAVEPOINT ${SP_RUN}`);
    } else {
      await deps.query('ROLLBACK');
    }
    return;
  }
  await deps.query(nested ? `RELEASE SAVEPOINT ${SP_RUN}` : 'COMMIT');
}

export { rollbackSafe as rollbackSafeRun };
