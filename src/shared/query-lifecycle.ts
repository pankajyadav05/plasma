/**
 * Query lifecycle: the explicit state of one tab's run, as a pure state
 * machine (C1). The store feeds it events; the UI only reads `phase`.
 *
 *   idle ─start─▶ queued ─begin─▶ running ─ok──────▶ succeeded
 *                                   │  │ └─error───▶ failed
 *                                   │  └─lost──────▶ disconnected | unknown (writes)
 *                                   └─cancel─▶ cancelling ─▶ cancelled | succeeded | failed
 *
 * Terminal phases never change on a late event (a result arriving after
 * the user already saw "cancelled" must not flip the tab back).
 */
import { isConnectionLostMessage } from './connection-loss';

export type QueryPhase =
  | 'idle'
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'cancelled'
  | 'failed'
  | 'succeeded'
  | 'disconnected'
  | 'unknown';

export interface QueryLifecycle {
  phase: QueryPhase;
  /** When the current phase began (epoch ms). */
  since: number;
  /** When the run itself started executing (epoch ms); survives `cancelling`. */
  startedAt?: number;
  /** Total run time once settled. */
  elapsedMs?: number;
  /** Failure / loss text (already cleaned). */
  message?: string;
  /** Cancelling: the cancel signal was refused or found nothing to stop. */
  cancelNote?: string;
  /** Succeeded after a cancel request: the statement finished first. */
  finishedBeforeCancel?: boolean;
  /** Unknown / disconnected: the statement text, for "Check the data". */
  sql?: string;
}

export const IDLE_LIFECYCLE: QueryLifecycle = { phase: 'idle', since: 0 };

export type LifecycleEvent =
  | { type: 'queue'; now: number }
  | { type: 'begin'; now: number }
  | { type: 'cancel'; now: number }
  /** The worker said nothing was in flight to cancel (already done or not started). */
  | { type: 'cancelNothing'; now: number }
  | { type: 'cancelFailed'; now: number; message: string }
  | { type: 'succeed'; now: number }
  | { type: 'fail'; now: number; message: string; isWrite?: boolean; sql?: string }
  | { type: 'reset' };

/** Phases in which work is (or may be) in flight on the connection. */
export function isBusyPhase(phase: QueryPhase): boolean {
  return phase === 'queued' || phase === 'running' || phase === 'cancelling';
}

export function isSettledPhase(phase: QueryPhase): boolean {
  return !isBusyPhase(phase) && phase !== 'idle';
}

const NOT_APPLIED_UNKNOWN = /may or may not have been applied/i;
const TXN_ROLLED_BACK = /rolled back/i;

export const CANCELLED_NOTE = 'Cancelled before it finished.';

/** What a failed run turned into: the phase plus the user-facing text. */
export function classifyFailure(
  message: string,
  opts: { isWrite?: boolean; wasCancelling?: boolean },
): { phase: 'failed' | 'cancelled' | 'disconnected' | 'unknown'; message: string } {
  const lost = isConnectionLostMessage(message) || /^connection lost/i.test(message);
  if (NOT_APPLIED_UNKNOWN.test(message)) {
    // Main refused to replay a statement the dead session may have run.
    return {
      phase: TXN_ROLLED_BACK.test(message) ? 'disconnected' : 'unknown',
      message,
    };
  }
  if (lost) {
    if (opts.isWrite && !TXN_ROLLED_BACK.test(message)) {
      return {
        phase: 'unknown',
        message:
          'The connection dropped after this statement was sent. It may or may not have been applied.',
      };
    }
    return {
      phase: 'disconnected',
      message: TXN_ROLLED_BACK.test(message)
        ? message
        : 'The connection dropped while this query was running. Nothing was changed by a read.',
    };
  }
  if (opts.wasCancelling) return { phase: 'cancelled', message: CANCELLED_NOTE };
  return { phase: 'failed', message };
}

export function reduceLifecycle(prev: QueryLifecycle, event: LifecycleEvent): QueryLifecycle {
  if (event.type === 'reset') return IDLE_LIFECYCLE;
  const now = event.now;
  switch (event.type) {
    case 'queue':
      return { phase: 'queued', since: now };
    case 'begin':
      if (prev.phase === 'queued' || prev.phase === 'idle' || isSettledPhase(prev.phase)) {
        return { phase: 'running', since: now, startedAt: now };
      }
      return prev;
    case 'cancel':
      // Only a running statement can be cancelled; the cancel signal would
      // otherwise hit whatever runs next on the connection.
      if (prev.phase !== 'running') return prev;
      return { ...prev, phase: 'cancelling', since: now };
    case 'cancelNothing':
      if (prev.phase !== 'cancelling') return prev;
      // Back to running, the result is probably already on its way.
      return { ...prev, phase: 'running', since: prev.startedAt ?? now };
    case 'cancelFailed':
      if (prev.phase !== 'cancelling') return prev;
      return { ...prev, cancelNote: event.message };
    case 'succeed': {
      if (!isBusyPhase(prev.phase)) return prev;
      return {
        phase: 'succeeded',
        since: now,
        startedAt: prev.startedAt,
        elapsedMs: prev.startedAt != null ? now - prev.startedAt : undefined,
        finishedBeforeCancel: prev.phase === 'cancelling' || undefined,
      };
    }
    case 'fail': {
      if (!isBusyPhase(prev.phase)) return prev;
      const c = classifyFailure(event.message, {
        isWrite: event.isWrite,
        wasCancelling: prev.phase === 'cancelling',
      });
      return {
        phase: c.phase,
        since: now,
        startedAt: prev.startedAt,
        elapsedMs: prev.startedAt != null ? now - prev.startedAt : undefined,
        message: c.message,
        sql: c.phase === 'unknown' || c.phase === 'disconnected' ? event.sql : undefined,
      };
    }
  }
}

/** Cancel stuck this long: offer to drop the connection to stop it. */
export const CANCEL_STUCK_MS = 5_000;

export function cancelIsStuck(l: QueryLifecycle, now: number): boolean {
  return l.phase === 'cancelling' && now - l.since >= CANCEL_STUCK_MS;
}

/** "1.2s" under a minute, then "1m 05s". */
export function formatElapsed(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < 60_000) return `${(safe / 1000).toFixed(1)}s`;
  const m = Math.floor(safe / 60_000);
  const s = Math.floor((safe % 60_000) / 1000);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

/** Short label for the status chip / announcer. */
export function phaseLabel(phase: QueryPhase): string {
  switch (phase) {
    case 'queued':
      return 'Queued';
    case 'running':
      return 'Running';
    case 'cancelling':
      return 'Cancelling';
    case 'cancelled':
      return 'Cancelled';
    case 'failed':
      return 'Failed';
    case 'succeeded':
      return 'Done';
    case 'disconnected':
      return 'Disconnected';
    case 'unknown':
      return 'Outcome unknown';
    default:
      return '';
  }
}

/** The table a write statement targets, for "Check the data". */
export function writeTarget(sql: string): { schema?: string; table: string } | null {
  const m =
    /^\s*(?:insert\s+into|update(?:\s+only)?|delete\s+from(?:\s+only)?|merge\s+into|truncate(?:\s+table)?)\s+((?:"[^"]+"|[\w$]+)(?:\s*\.\s*(?:"[^"]+"|[\w$]+))?)/i.exec(
      sql,
    );
  if (!m) return null;
  const unq = (s: string) => (s.startsWith('"') ? s.slice(1, -1).replace(/""/g, '"') : s);
  const parts = m[1]!.split('.').map((p) => unq(p.trim()));
  return parts.length === 2 ? { schema: parts[0], table: parts[1]! } : { table: parts[0]! };
}

/** Lifecycle for a patch that only touches the legacy run flag (older call sites). */
export function lifecycleFromLegacyPatch(
  prev: QueryLifecycle | undefined,
  patch: { queryRunState?: 'idle' | 'running'; queryError?: string | null; runStartedAt?: number },
  hasError: boolean,
  now: number,
): QueryLifecycle | undefined {
  if (patch.queryRunState === undefined) return undefined;
  const cur = prev ?? IDLE_LIFECYCLE;
  if (patch.queryRunState === 'running') {
    return {
      phase: 'running',
      since: patch.runStartedAt ?? now,
      startedAt: patch.runStartedAt ?? now,
    };
  }
  if (isBusyPhase(cur.phase)) {
    return hasError
      ? reduceLifecycle(cur, { type: 'fail', now, message: patch.queryError ?? 'Failed' })
      : reduceLifecycle(cur, { type: 'succeed', now });
  }
  // A failure raised before anything ran (gate refusal, blocked by Safe Run).
  if (hasError) return { phase: 'failed', since: now, message: patch.queryError ?? undefined };
  return cur.phase === 'idle' ? cur : IDLE_LIFECYCLE;
}
