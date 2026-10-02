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
  return isPlainDml(opts.sql);
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
