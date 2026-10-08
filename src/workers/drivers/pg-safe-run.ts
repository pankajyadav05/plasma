import { type DmlParse, buildBeforeSelect, parseDml, withReturning } from '@shared/dml-parse';
import type { ColumnMeta, SafeRunReport, SafeRunStep } from '@shared/protocol';
import { SAFE_RUN_ROW_CAP, SAFE_RUN_TOTAL_ROW_CAP } from '@shared/protocol';
import { planSafeRunScript } from '@shared/safe-run-script';
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
  /** Server notices raised since the last call (script steps keep their own). */
  takeNotices?(): string[];
}

export interface SafeRunStart {
  runId: string;
  sql: string;
  explain: boolean;
  rowCap?: number;
}

export type SafeRunBody = Omit<SafeRunReport, 'expiresAt' | 'timeoutSec' | 'txnState'>;

/** What one statement reports, without the run-level fields. */
type StatementBody = Omit<
  SafeRunStep,
  'index' | 'status' | 'error' | 'beforeTruncated' | 'afterTruncated' | 'notices'
>;

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

interface StatementOpts {
  explain: boolean;
  beforeCap: number;
  afterCap: number;
}

/**
 * Describe and run one parsed write inside the open transaction: catalog
 * probe, optional EXPLAIN, BEFORE rows, the statement itself. Every
 * auxiliary step runs under its own savepoint (see `attempt`); only the
 * write itself can throw.
 */
async function runStatement(
  deps: SafeRunDeps,
  parsed: DmlParse,
  opts: StatementOpts,
): Promise<StatementBody> {
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
  if (opts.explain) {
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
      const read = await attempt(deps, () => deps.readCapped(sel, opts.beforeCap));
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
  const written = await deps.readCapped(finalSql, opts.afterCap);
  const afterStripped = stripCtid(written);
  const afterRead = afterStripped.read;
  const returnsRows = afterRead.columns.length > 0;
  const affected = returnsRows ? written.total : (written.commandRowCount ?? 0);

  const snapshot = before !== null;
  const body: StatementBody = {
    kind: parsed.kind as StatementBody['kind'],
    statement: parsed.sql,
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
  return body;
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
    const stmt = await runStatement(deps, parsed, {
      explain: req.explain,
      beforeCap: cap,
      afterCap: cap,
    });
    return { body: { runId: req.runId, nested, ...stmt }, nested };
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

// ─── Scripts: several writes, one transaction ──────────────────────────

const MAX_NOTICE_CHARS = 300;
const MAX_NOTICES_PER_STEP = 5;

/** Savepoint taken before statement `n` (1-based) of a script. */
export const scriptSavepoint = (n: number): string => `plasma_sr_${n}`;

export interface SafeRunScriptStart {
  runId: string;
  /** The whole script as the user selected it; split and re-checked here. */
  sql: string;
  explain: boolean;
}

/** The live state of a script run, kept by the driver between calls. */
export interface SafeRunScriptState {
  /** The script, trimmed: the `statement` of the run-level report. */
  text: string;
  steps: SafeRunStep[];
  /** Statement number the script stopped at, or null when all ran. */
  failedAt: number | null;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function emptyStep(index: number, sql: string, status: SafeRunStep['status']): SafeRunStep {
  const p = parseDml(sql);
  return {
    index,
    status,
    error: null,
    kind: (p.kind === 'other' ? 'cte' : p.kind) as SafeRunStep['kind'],
    statement: p.sql || sql,
    affected: 0,
    affectedExact: true,
    estimateRows: null,
    mode: 'after-only',
    note: null,
    keyKind: 'none',
    keyColumns: [],
    beforeColumns: [],
    before: null,
    beforeCtids: null,
    beforeTotal: 0,
    afterColumns: [],
    after: [],
    afterCtids: null,
    afterTotal: 0,
    durationMs: 0,
    beforeTruncated: false,
    afterTruncated: false,
    notices: [],
  };
}

function drainNotices(deps: SafeRunDeps): string[] {
  const all = deps.takeNotices?.() ?? [];
  return all
    .slice(0, MAX_NOTICES_PER_STEP)
    .map((m) => (m.length > MAX_NOTICE_CHARS ? `${m.slice(0, MAX_NOTICE_CHARS)}…` : m));
}

/**
 * Run a script of writes in order inside one transaction (a savepoint when
 * the user already has one). Each statement gets its own savepoint. When a
 * statement fails, its savepoint is rolled back, the script stops, and the
 * earlier statements stay pending for the user to decide on. The only
 * exception is statement 1 failing: nothing is pending then, so the whole
 * run is rolled back and the error thrown, like a single statement.
 *
 * Later statements see the effects of earlier ones, so their BEFORE rows
 * are as of that point in the script.
 */
export async function startSafeRunScript(
  deps: SafeRunDeps,
  req: SafeRunScriptStart,
): Promise<{ state: SafeRunScriptState; nested: boolean }> {
  const plan = planSafeRunScript(req.sql);
  if (!plan.ok) throw new Error(plan.message);
  const statements = plan.statements;
  if (deps.status === 'E') throw new Error(ABORTED_MESSAGE);

  const nested = deps.status === 'T';
  await deps.query(nested ? `SAVEPOINT ${SP_RUN}` : 'BEGIN');

  const steps = statements.map((sql, i) => emptyStep(i + 1, sql, 'notRun'));
  let failedAt: number | null = null;
  let keptBefore = 0;
  let keptAfter = 0;
  try {
    for (let i = 0; i < statements.length; i++) {
      const n = i + 1;
      const parsed = parseDml(statements[i]!);
      await deps.query(`SAVEPOINT ${scriptSavepoint(n)}`);
      drainNotices(deps);
      // Both sides get the same cap so a diff stays pairable: the smaller of the
      // per-statement cap and what is left of the run's total on either side.
      const cap = Math.max(
        0,
        Math.min(SAFE_RUN_ROW_CAP, SAFE_RUN_TOTAL_ROW_CAP - Math.max(keptBefore, keptAfter)),
      );
      try {
        const stmt = await runStatement(deps, parsed, {
          explain: req.explain,
          beforeCap: cap,
          afterCap: cap,
        });
        steps[i] = {
          ...stmt,
          index: n,
          status: 'done',
          error: null,
          beforeTruncated: stmt.beforeTotal > (stmt.before?.length ?? 0),
          afterTruncated: stmt.afterTotal > stmt.after.length,
          notices: drainNotices(deps),
        };
        keptBefore += stmt.before?.length ?? 0;
        keptAfter += stmt.after.length;
      } catch (err) {
        // The statement failed: undo just its own work. If even that fails the
        // connection is gone, and the outer handler reports the original error.
        try {
          await deps.query(`ROLLBACK TO SAVEPOINT ${scriptSavepoint(n)}`);
          await deps.query(`RELEASE SAVEPOINT ${scriptSavepoint(n)}`);
        } catch {
          throw err;
        }
        steps[i] = {
          ...emptyStep(n, statements[i]!, 'failed'),
          error: errText(err),
          notices: drainNotices(deps),
        };
        failedAt = n;
        break;
      }
    }
  } catch (err) {
    await rollbackSafe(deps, nested);
    throw err;
  }

  if (failedAt === 1) {
    // Nothing succeeded, so nothing is worth holding open.
    await rollbackSafe(deps, nested);
    throw new Error(`Statement 1 failed: ${steps[0]!.error}. Nothing was run.`);
  }
  return { state: { text: req.sql.trim(), steps, failedAt }, nested };
}

/**
 * Roll back the last statement that ran and drop it from the report. The
 * caller has checked that at least two statements are still pending (undoing
 * the only one is a plain roll back of the whole run).
 */
export async function undoLastScriptStatement(
  deps: Pick<SafeRunDeps, 'query'>,
  state: SafeRunScriptState,
): Promise<void> {
  const at = state.steps.map((s) => s.status).lastIndexOf('done');
  if (at < 0) throw new Error('There is no statement to undo.');
  const n = state.steps[at]!.index;
  await deps.query(`ROLLBACK TO SAVEPOINT ${scriptSavepoint(n)}`);
  await deps.query(`RELEASE SAVEPOINT ${scriptSavepoint(n)}`);
  state.steps.splice(at, 1);
}

export const doneSteps = (state: SafeRunScriptState): SafeRunStep[] =>
  state.steps.filter((s) => s.status === 'done');

/** The run-level fields of a script report; the row images live in the steps. */
export function scriptReportBody(
  runId: string,
  nested: boolean,
  state: SafeRunScriptState,
): SafeRunBody {
  const done = doneSteps(state);
  const first = state.steps[0]!;
  const note =
    'Statements ran in order in one transaction. Each statement sees the changes made by the ones before it, so its BEFORE rows are as of that point.';
  return {
    runId,
    nested,
    kind: first.kind,
    statement: state.text,
    affected: done.reduce((n, s) => n + s.affected, 0),
    affectedExact: done.every((s) => s.affectedExact),
    estimateRows: null,
    mode: 'after-only',
    note,
    keyKind: 'none',
    keyColumns: [],
    beforeColumns: [],
    before: null,
    beforeCtids: null,
    beforeTotal: 0,
    afterColumns: [],
    after: [],
    afterCtids: null,
    afterTotal: 0,
    durationMs: state.steps.reduce((n, s) => n + s.durationMs, 0),
    steps: state.steps,
    failedAt: state.failedAt,
  };
}
