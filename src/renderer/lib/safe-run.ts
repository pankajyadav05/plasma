/**
 * Safe Run policy: which statements go through it, and how loud the
 * review should be. Pure, so the rules are unit-tested.
 */
import { parseDml } from '@shared/dml-parse';
import {
  SAFE_RUN_DEFAULT_ROW_THRESHOLD,
  SAFE_RUN_DEFAULT_TIMEOUT_SEC,
  type Settings,
} from '@shared/protocol';
import { planSafeRunScript } from '@shared/safe-run-script';
import { looksLikeWriteSql } from '@shared/sql-statements';

type SafeRunSettings = Partial<
  Pick<
    Settings,
    'connectionAlwaysSafeRun' | 'connectionTags' | 'safeRunRowThreshold' | 'safeRunTimeoutSec'
  >
>;

/**
 * "Always Safe Run writes" for a connection: its own choice, else on for
 * connections tagged Prod.
 */
export function alwaysSafeRun(
  settings: SafeRunSettings | undefined,
  connectionId: string | null | undefined,
): boolean {
  if (!connectionId) return false;
  const own = settings?.connectionAlwaysSafeRun?.[connectionId];
  if (own !== undefined) return own;
  return settings?.connectionTags?.[connectionId] === 'prod';
}

/** True for one INSERT / UPDATE / DELETE / MERGE statement. */
export function isPlainDml(sql: string): boolean {
  const k = parseDml(sql).kind;
  return k === 'insert' || k === 'update' || k === 'delete' || k === 'merge';
}

/** True when Safe Run can take `sql` at all (adds data-modifying CTEs). */
export function isSafeRunnable(sql: string): boolean {
  const p = parseDml(sql);
  if (p.kind === 'cte') return looksLikeWriteSql(sql);
  return p.kind === 'insert' || p.kind === 'update' || p.kind === 'delete' || p.kind === 'merge';
}

/** A plain Run of `sql` should go through Safe Run on this connection. */
export function shouldAutoSafeRun(opts: {
  settings: SafeRunSettings | undefined;
  connectionId: string | null | undefined;
  engine: string | null | undefined;
  readOnly: boolean | undefined;
  sql: string;
}): boolean {
  if ((opts.engine ?? 'postgres') !== 'postgres') return false;
  if (opts.readOnly === true) return false;
  if (!alwaysSafeRun(opts.settings, opts.connectionId)) return false;
  if (isPlainDml(opts.sql)) return true;
  // Several statements, all of them writes Safe Run takes (2 to 20): one script Safe Run
  // instead of autocommit. A script that mixes in anything else keeps the normal Run.
  const plan = planSafeRunScript(opts.sql);
  return plan.ok && plan.statements.length > 1;
}

export function safeRunThreshold(settings: SafeRunSettings | undefined): number {
  const n = settings?.safeRunRowThreshold;
  return typeof n === 'number' && n > 0 ? n : SAFE_RUN_DEFAULT_ROW_THRESHOLD;
}

export function safeRunTimeoutSec(settings: SafeRunSettings | undefined): number {
  const n = settings?.safeRunTimeoutSec;
  return typeof n === 'number' && n >= 5 ? n : SAFE_RUN_DEFAULT_TIMEOUT_SEC;
}

/** The planner expected far fewer rows than the statement touched. */
export const ESTIMATE_MISS_FACTOR = 10;

export interface SafeRunWarning {
  /** Above the threshold: Commit turns destructive. */
  large: boolean;
  /** Actual rows far exceed the planner's estimate. */
  estimateMiss: boolean;
  messages: string[];
}

export function safeRunWarning(
  affected: number,
  estimateRows: number | null,
  threshold: number,
  exact = true,
): SafeRunWarning {
  const large = affected > threshold;
  const estimateMiss =
    estimateRows !== null &&
    affected >= 100 &&
    affected > Math.max(1, estimateRows) * ESTIMATE_MISS_FACTOR;
  const messages: string[] = [];
  const shown = `${affected.toLocaleString('en-US')}${exact ? '' : '+'}`;
  if (large) {
    messages.push(
      `This touches ${shown} rows, more than your Safe Run threshold of ${threshold.toLocaleString('en-US')}.`,
    );
  }
  if (estimateMiss && estimateRows !== null) {
    messages.push(
      `The planner expected about ${Math.round(estimateRows).toLocaleString('en-US')} rows but ${shown} changed. Check the WHERE clause.`,
    );
  }
  return { large, estimateMiss, messages };
}

/** `m:ss` for a countdown; never negative. */
export function formatCountdown(msLeft: number): string {
  const total = Math.max(0, Math.ceil(msLeft / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Statements of a script report that ran and are pending. */
export function pendingStatementCount(report: { steps?: { status: string }[] }): number {
  return report.steps ? report.steps.filter((st) => st.status === 'done').length : 1;
}

/**
 * Label of the explicit partial commit after a failure. Undo only ever
 * removes the last statement that ran, so what is pending is always 1..m.
 */
export function partialCommitLabel(done: number): string {
  return done <= 1 ? 'Commit 1' : `Commit 1\u2013${done}`;
}

/** "3 statements" / "1 statement". */
export function statementsLabel(n: number): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'statement' : 'statements'}`;
}

/** "5 rows" / "1 row", with a trailing + when the count stopped early. */
export function rowsLabel(n: number, exact = true): string {
  return `${n.toLocaleString('en-US')}${exact ? '' : '+'} ${n === 1 ? 'row' : 'rows'}`;
}
