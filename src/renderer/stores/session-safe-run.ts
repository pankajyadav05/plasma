/**
 * Safe Run slice: a dry run for writes. The worker runs the statement (or a
 * script of up to 20 statements) in one transaction (or savepoint) and holds
 * it open; this slice owns the review that follows and the Commit / Roll back
 * decision, plus "Undo last statement" for scripts.
 *
 * One Safe Run exists at a time because it owns the primary connection:
 * the worker refuses every other statement on it until the run ends.
 */
import { ipc } from '@/lib/ipc';
import { safeRunTimeoutSec } from '@/lib/safe-run';
import { resolveRunTarget } from '@/lib/sql-split';
import type { QueryResult, SafeRunReport } from '@shared/protocol';
import { classifyFailure } from '@shared/query-lifecycle';
import { planSafeRunScript } from '@shared/safe-run-script';
import { armProdGate, evaluateGate } from './session-prod-gate';
import { activeTab, patchTabById, resultPatch } from './session-tab-model';
import type { SliceCreator } from './session-types';
import { useWorkbench } from './workbench';

export type SafeRunPhase =
  | 'running' // the statement is executing
  | 'review' // held open, waiting for Commit / Roll back
  | 'finishing' // COMMIT / ROLLBACK in flight
  | 'committed'
  | 'rolledBack'
  | 'failed';

/** Why a run ended without the user pressing Roll back. */
export type SafeRunEndReason = 'user' | 'timeout' | 'disconnect' | 'tab';

/** What the in-flight `finishing` phase is doing. */
export type SafeRunFinishing = 'commit' | 'commitPartial' | 'rollback' | 'undo';

export interface SafeRunState {
  tabId: string;
  sql: string;
  phase: SafeRunPhase;
  report: SafeRunReport | null;
  error: string | null;
  endReason: SafeRunEndReason | null;
  /** A COMMIT was on its way when the connection dropped: it may or may not have been saved. */
  outcomeUnknown: boolean;
  /** A message that does not end the review (an undo that did not go through). */
  notice: string | null;
  /** Set while `phase` is `finishing`. */
  finishing: SafeRunFinishing | null;
  connectionGen: number;
  /** Identifies this run in async continuations. */
  token: number;
  /** Bumped when something tried to run while a Safe Run is pending. */
  nudge: number;
}

const PENDING: ReadonlySet<SafeRunPhase> = new Set(['running', 'review', 'finishing']);

/** A Safe Run holds the primary connection. */
export function safeRunPending(sr: SafeRunState | null | undefined): sr is SafeRunState {
  return sr != null && PENDING.has(sr.phase);
}

export const SAFE_RUN_BLOCKED_NOTE =
  'A Safe Run is waiting for Commit or Roll back. Other statements on this connection are paused until you decide.';

export interface SafeRunSlice {
  safeRun: SafeRunState | null;
  /**
   * Dry-run the statement at the cursor / selection (or `opts.sql`): execute
   * it in a held-open transaction and show what it changed.
   */
  runSafeRun(opts?: { sql?: string; base?: number; gated?: boolean }): Promise<void>;
  /** Commit everything. Refused for a script that stopped at a failed statement. */
  commitSafeRun(): Promise<void>;
  /** Commit only the statements that succeeded before a failed one (explicit, separate action). */
  commitSafeRunPartial(): Promise<void>;
  /** Script runs: roll back the last statement that ran and keep the earlier ones pending. */
  undoSafeRun(): Promise<void>;
  rollbackSafeRun(reason?: SafeRunEndReason): Promise<void>;
  /** Close the panel. A pending run is rolled back first. */
  dismissSafeRun(): void;
  /** Tell the user something ran while a Safe Run holds the connection. */
  noteSafeRunBlocked(tabId: string): void;
}

let tokenSeq = 0;

const COMMIT_UNKNOWN =
  'The connection dropped while the commit was being sent. The changes may or may not have been saved. Check the data before running anything again.';

export const createSafeRunSlice: SliceCreator<SafeRunSlice> = (set, get, api) => {
  const patchRun = (token: number, patch: Partial<SafeRunState>) => {
    const cur = get().safeRun;
    if (!cur || cur.token !== token) return;
    set({ safeRun: { ...cur, ...patch } });
  };

  const fail = (token: number, error: string) =>
    patchRun(token, {
      phase: 'failed',
      error,
      finishing: null,
      report: get().safeRun?.report ?? null,
    });

  /** Show the finished write(s) in the tab like any other DML result. */
  const publishResult = (tabId: string, report: SafeRunReport) => {
    const one = (r: {
      kind: SafeRunReport['kind'];
      affected: number;
      durationMs: number;
      statement: string;
    }): QueryResult => ({
      columns: [],
      rows: [],
      rowCount: r.affected,
      durationMs: r.durationMs,
      command: r.kind === 'cte' ? 'WITH' : r.kind.toUpperCase(),
      sql: r.statement,
    });
    const results = report.steps
      ? report.steps.filter((st) => st.status === 'done').map(one)
      : [one(report)];
    patchTabById(set, tabId, {
      ...resultPatch(results, 0),
      queryError: null,
      queryErrorSql: null,
      queryErrorRange: null,
      queryRunState: 'idle',
    });
  };

  // The panel is bound to its tab and its connection. When either goes
  // away, the work is gone (or about to be): make the UI say so.
  api.subscribe((state) => {
    const sr = state.safeRun;
    if (!sr) return;
    if (!state.tabs.some((t) => t.id === sr.tabId)) {
      if (safeRunPending(sr)) void state.rollbackSafeRun('tab');
      else set({ safeRun: null });
      return;
    }
    const lost =
      state.connectionState !== 'connected' || (state.connectionGen ?? 0) !== sr.connectionGen;
    if (lost && safeRunPending(sr)) {
      // A COMMIT that was already sent may have reached the server before the
      // connection went: the honest answer is "unknown", never "rolled back".
      if (
        sr.phase === 'finishing' &&
        (sr.finishing === 'commit' || sr.finishing === 'commitPartial')
      ) {
        set({
          safeRun: {
            ...sr,
            phase: 'failed',
            endReason: 'disconnect',
            outcomeUnknown: true,
            finishing: null,
            error: COMMIT_UNKNOWN,
          },
        });
        return;
      }
      set({
        safeRun: {
          ...sr,
          phase: 'rolledBack',
          endReason: 'disconnect',
          finishing: null,
          error: 'The connection changed, so the transaction was rolled back. Nothing was saved.',
        },
      });
    }
  });

  const finishCommit = async (action: 'commit' | 'commitPartial') => {
    const sr = get().safeRun;
    if (!sr || sr.phase !== 'review' || !sr.report) return;
    const { token, report } = sr;
    patchRun(token, { phase: 'finishing', finishing: action, notice: null });
    try {
      const out = await ipc.query.safeRunFinish({ runId: report.runId, action });
      if ((get().connectionGen ?? 0) === sr.connectionGen) set({ txnState: out.txnState });
      if (out.outcome === 'committed') {
        patchRun(token, { phase: 'committed', endReason: 'user', finishing: null });
        publishResult(sr.tabId, report);
      } else {
        patchRun(token, {
          phase: 'rolledBack',
          endReason: out.reason ?? 'user',
          finishing: null,
          error:
            out.reason === 'timeout'
              ? 'The review window ran out, so the change was rolled back. Nothing was saved.'
              : null,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A reply lost on the way back from COMMIT is not "nothing saved".
      const lost = classifyFailure(message, { isWrite: true, commitLike: true });
      if (lost.phase === 'unknown') {
        patchRun(token, {
          phase: 'failed',
          endReason: 'disconnect',
          outcomeUnknown: true,
          finishing: null,
          error: COMMIT_UNKNOWN,
        });
        return;
      }
      patchRun(token, { finishing: null });
      fail(token, `Commit failed: ${message}. Nothing was saved.`);
    }
  };

  return {
    safeRun: null,

    noteSafeRunBlocked(tabId) {
      const sr = get().safeRun;
      if (!safeRunPending(sr)) return;
      patchTabById(set, tabId, {
        queryRunState: 'idle',
        queryError: SAFE_RUN_BLOCKED_NOTE,
        queryErrorSql: null,
        queryErrorRange: null,
      });
      set({ safeRun: { ...sr, nudge: sr.nudge + 1 } });
    },

    async runSafeRun(opts) {
      const state = get();
      const tab = activeTab(state);
      if (!tab || tab.kind !== 'sql') return;
      if (state.connectionState !== 'connected') return;
      if (safeRunPending(state.safeRun)) {
        get().noteSafeRunBlocked(tab.id);
        return;
      }

      let script: string;
      if (opts?.sql != null) {
        script = opts.sql;
      } else {
        const saved = useWorkbench.getState().carets[tab.id];
        const caret = saved && saved.bufferLength === tab.sql.length ? saved : null;
        const target = resolveRunTarget(tab.sql, 'smart', caret);
        if (!target) return;
        script = target.sql;
      }
      if (script.trim().length === 0) return;

      const token = ++tokenSeq;
      const gen = state.connectionGen ?? 0;
      const base: SafeRunState = {
        tabId: tab.id,
        sql: script,
        phase: 'failed',
        report: null,
        error: null,
        endReason: null,
        outcomeUnknown: false,
        notice: null,
        finishing: null,
        connectionGen: gen,
        token,
        nudge: 0,
      };
      const refuse = (message: string) => set({ safeRun: { ...base, error: message } });

      if (state.activeConfig?.readOnly === true) {
        refuse('This connection is read-only, so Safe Run is not available.');
        return;
      }
      const plan = planSafeRunScript(script);
      if (!plan.ok) {
        refuse(plan.message);
        return;
      }

      // The prod gate and safe mode apply exactly as they do to Run.
      if (!opts?.gated) {
        const decision = evaluateGate(get, script);
        if (decision.kind === 'refuse') {
          refuse(decision.message);
          return;
        }
        if (decision.kind === 'confirm') {
          if (state.prodGate === null) {
            armProdGate(set, get, {
              sql: script,
              tabId: tab.id,
              reason: decision.reason,
              base: opts?.base,
              safe: true,
            });
          }
          return;
        }
      }

      set({ safeRun: { ...base, phase: 'running' } });
      try {
        const report = await ipc.query.safeRun({
          sql: script,
          connectionGen: gen,
          timeoutSec: safeRunTimeoutSec(get().settings),
          explain: true,
        });
        const cur = get().safeRun;
        const stale =
          !cur ||
          cur.token !== token ||
          cur.phase !== 'running' ||
          (get().connectionGen ?? 0) !== gen;
        if (stale) {
          // Dismissed or superseded while it ran: do not leave it open.
          await ipc.query
            .safeRunFinish({ runId: report.runId, action: 'rollback' })
            .catch(() => undefined);
          return;
        }
        patchRun(token, { phase: 'review', report });
      } catch (err) {
        const cur = get().safeRun;
        if (cur?.token !== token || cur.phase !== 'running') return;
        fail(token, err instanceof Error ? err.message : String(err));
      }
    },

    async commitSafeRun() {
      const sr = get().safeRun;
      // A script that stopped at a failed statement is never committed by this
      // path: only the explicit "Commit the statements that succeeded" button does.
      if (sr?.report?.failedAt != null) return;
      await finishCommit('commit');
    },

    async commitSafeRunPartial() {
      const sr = get().safeRun;
      if (sr?.report?.failedAt == null) return;
      await finishCommit('commitPartial');
    },

    async undoSafeRun() {
      const sr = get().safeRun;
      if (!sr || sr.phase !== 'review' || !sr.report?.steps) return;
      const { token, report } = sr;
      patchRun(token, { phase: 'finishing', finishing: 'undo', notice: null });
      try {
        const res = await ipc.query.safeRunUndo({ runId: report.runId });
        const cur = get().safeRun;
        if (res.report && (!cur || cur.token !== token)) {
          // Closed while the undo ran: do not leave the rest of the script open.
          await ipc.query
            .safeRunFinish({ runId: report.runId, action: 'rollback' })
            .catch(() => undefined);
          return;
        }
        if (res.outcome) {
          // The last statement left was undone: that is a roll back of the whole run.
          if ((get().connectionGen ?? 0) === sr.connectionGen) {
            set({ txnState: res.outcome.txnState });
          }
          patchRun(token, {
            phase: 'rolledBack',
            endReason: res.outcome.reason ?? 'user',
            finishing: null,
            error:
              res.outcome.reason === 'timeout'
                ? 'The review window ran out, so the change was rolled back. Nothing was saved.'
                : null,
          });
          return;
        }
        patchRun(token, { phase: 'review', finishing: null, report: res.report });
      } catch (err) {
        // The run may well still be open: go back to the review so it can be rolled back.
        patchRun(token, {
          phase: 'review',
          finishing: null,
          notice: `Undo did not go through: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },

    async rollbackSafeRun(reason = 'user') {
      const sr = get().safeRun;
      if (!sr || !safeRunPending(sr)) return;
      const { token, report } = sr;
      if (!report) {
        // Still executing: stop it. The worker rolls back when the statement errors,
        // and runSafeRun discards a report that arrives for a cleared run.
        void ipc.query.cancel().catch(() => undefined);
        set({
          safeRun: reason === 'tab' ? null : { ...sr, phase: 'rolledBack', endReason: reason },
        });
        return;
      }
      if (sr.phase === 'finishing') return;
      patchRun(token, { phase: 'finishing', finishing: 'rollback', notice: null });
      try {
        const out = await ipc.query.safeRunFinish({ runId: report.runId, action: 'rollback' });
        if ((get().connectionGen ?? 0) === sr.connectionGen) set({ txnState: out.txnState });
        const endReason: SafeRunEndReason =
          reason === 'timeout' || out.reason === 'timeout' ? 'timeout' : reason;
        if (reason === 'tab') {
          const cur = get().safeRun;
          if (cur?.token === token) set({ safeRun: null });
          return;
        }
        patchRun(token, {
          phase: 'rolledBack',
          endReason,
          error:
            endReason === 'timeout'
              ? 'The review window ran out, so the change was rolled back. Nothing was saved.'
              : null,
        });
      } catch (err) {
        if (reason === 'tab') {
          const cur = get().safeRun;
          if (cur?.token === token) set({ safeRun: null });
          return;
        }
        fail(token, `Roll back failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    dismissSafeRun() {
      const sr = get().safeRun;
      if (!sr) return;
      if (safeRunPending(sr)) {
        void get()
          .rollbackSafeRun('tab')
          .finally(() => {
            if (get().safeRun?.token === sr.token) set({ safeRun: null });
          });
        return;
      }
      set({ safeRun: null });
    },
  };
};
