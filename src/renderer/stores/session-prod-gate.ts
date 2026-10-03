/**
 * Prod-gate helpers (U39, F8, A7).
 *
 * The confirm dialog is driven by `prodGate` in the session store.
 * `runQuery` arms it for the editor; this module adds the promise-based
 * variant used by every other place that runs user-originated SQL
 * (Notebook, Mock data, Explain ANALYZE) so none of them bypasses the
 * prod-tag confirmation.
 */
import { clickhouseMutation } from '@shared/clickhouse-mutation';
import { engineCaps } from '@shared/sql-dialect';
import { type GateDecision, effectiveSafeMode, safeModeDecision } from './safe-mode';
import type { SliceCreator } from './session-types';

/**
 * Zustand set/get are typed loosely here so this module can compose into
 * the full SessionState store without importing it (avoids cycles).
 */
// biome-ignore lint/suspicious/noExplicitAny: slice composed into SessionState
type Set = (partial: any, ...args: any[]) => void;
// biome-ignore lint/suspicious/noExplicitAny: slice composed into SessionState
type Get = () => any;

let externalResolve: ((ok: boolean) => void) | null = null;

/** True when the active connection is tagged `prod`. */
export function isProdTagged(get: Get): boolean {
  const state = get();
  const connId = state.activeConfig?.id as string | undefined;
  return (connId ? state.settings?.connectionTags?.[connId] : undefined) === 'prod';
}

/**
 * What the gate does with `sql` on the active connection: the connection's
 * safe-mode level plus the prod tag's own confirmation.
 */
export function evaluateGate(get: Get, sql: string, force = false): GateDecision {
  const state = get();
  const level = effectiveSafeMode(state.settings, state.activeConfig?.id);
  const decision = safeModeDecision({ sql, force, prodTagged: isProdTagged(get), level });
  // ClickHouse mutations are asynchronous and cannot be undone: always ask first.
  if (
    decision.kind === 'run' &&
    engineCaps(state.activeConfig?.engine).asyncMutations &&
    clickhouseMutation(sql)
  ) {
    return { kind: 'confirm', reason: 'safe-mode', level };
  }
  return decision;
}

/** Stash `sql` and show the confirm dialog for the editor's run (resumed by `confirmProdGate`). */
export function armProdGate(
  set: Set,
  get: Get,
  gate: {
    sql: string;
    tabId: string;
    reason: 'prod' | 'safe-mode';
    kind?: 'external';
    summary?: string;
    /** Offset of `sql` in the tab buffer, so a resumed run maps errors correctly (R-14). */
    base?: number;
    /** Resume as a Safe Run (dry run) instead of a plain run. */
    safe?: boolean;
  },
): void {
  set({ prodGate: { ...gate, connectionGen: get().connectionGen ?? 0 } });
}

/**
 * Ask for prod confirmation outside the editor. Resolves `true` straight
 * away when the connection isn't prod-tagged or the SQL is harmless
 * (unless `force`), otherwise shows the prod-gate dialog and resolves
 * with the user's choice. A second request while one is pending is
 * refused rather than queued.
 */
export function requestProdConfirm(
  set: Set,
  get: Get,
  sql: string,
  opts?: { force?: boolean; summary?: string },
): Promise<boolean> {
  return requestProdConfirmDetailed(set, get, sql, opts).then((o) => o.ok);
}

/**
 * Outcome of a gate check outside the editor. `refused` carries the safe-mode
 * message so dialogs can say WHY nothing ran instead of silently doing
 * nothing (R-09); `declined` is the user pressing Cancel.
 */
export type UserSqlOutcome =
  | { ok: true }
  | { ok: false; reason: 'refused'; message: string }
  | { ok: false; reason: 'declined'; message: string };

export function requestProdConfirmDetailed(
  set: Set,
  get: Get,
  sql: string,
  opts?: { force?: boolean; summary?: string },
): Promise<UserSqlOutcome> {
  const decision = evaluateGate(get, sql, opts?.force);
  if (decision.kind === 'run') return Promise.resolve({ ok: true });
  if (decision.kind === 'refuse') {
    return Promise.resolve({ ok: false, reason: 'refused', message: decision.message });
  }
  if (get().prodGate != null) {
    return Promise.resolve({
      ok: false,
      reason: 'declined',
      message: 'Another confirmation is already open — answer it first.',
    });
  }
  return new Promise<UserSqlOutcome>((resolve) => {
    externalResolve = (ok) =>
      resolve(
        ok ? { ok: true } : { ok: false, reason: 'declined', message: 'Cancelled — nothing ran.' },
      );
    armProdGate(set, get, {
      sql,
      tabId: get().activeTabId ?? '',
      kind: 'external',
      reason: decision.reason,
      summary: opts?.summary,
    });
  });
}

/** Settle a pending `requestProdConfirm` (confirm → true, cancel → false). */
export function settleExternalProdGate(ok: boolean): void {
  const resolve = externalResolve;
  externalResolve = null;
  resolve?.(ok);
}

export function cancelProdGate(set: Set): void {
  set({ prodGate: null });
  settleExternalProdGate(false);
}

// ─── Slice ───────────────────────────────────────────────────────────

export interface ProdGateSlice {
  /**
   * When the user fires a destructive query (DELETE/TRUNCATE/DROP/
   * UPDATE without WHERE) against a prod-tagged connection, runQuery
   * stashes the pending SQL here and renders a confirm dialog. The
   * user's choice resumes (or aborts) the run.
   */
  prodGate: {
    sql: string;
    tabId: string;
    connectionGen: number;
    /**
     * 'commitEdits' = the grid's pending-changes tray (resumes the commit).
     * 'external' = Notebook / Mock data / Explain waiting on `confirmUserSql`.
     */
    kind?: 'commitEdits' | 'external';
    /** Why it's asking: the PROD tag, or the connection's safe-mode level. */
    reason?: 'prod' | 'safe-mode';
    summary?: string;
    base?: number;
    safe?: boolean;
  } | null;
  /** Resume a prod-gated runQuery after user confirms. */
  confirmProdGate(): void;
  cancelProdGate(): void;
  /**
   * Prod-gate check for user SQL run outside the editor (Notebook, Mock
   * data, Explain ANALYZE). Resolves true when it may run. `force` asks
   * even for non-destructive SQL (e.g. inserting mock rows).
   */
  confirmUserSql(sql: string, opts?: { force?: boolean; summary?: string }): Promise<boolean>;
  /** Same gate, but says why it did not pass (safe-mode refusal vs. cancelled). */
  confirmUserSqlDetailed(
    sql: string,
    opts?: { force?: boolean; summary?: string },
  ): Promise<UserSqlOutcome>;
}

export const createProdGateSlice: SliceCreator<ProdGateSlice> = (set, get) => ({
  prodGate: null,

  confirmProdGate() {
    const gate = get().prodGate;
    if (!gate) return;
    set({ prodGate: null });
    if (gate.kind === 'external') {
      settleExternalProdGate((get().connectionGen ?? 0) === gate.connectionGen);
      return;
    }
    // F8: the approved SQL only ever runs on the connection and tab it was
    // approved for. A reconnect in between voids the approval.
    if ((get().connectionGen ?? 0) !== gate.connectionGen) return;
    if (gate.kind === 'commitEdits') {
      // The grid's pending-changes tray: resume the confirmed commit.
      // Failures land in `pendingEditsError` for the grid to show.
      void get()
        .commitPendingEdits({ confirmed: true, tabId: gate.tabId })
        .catch(() => undefined);
      return;
    }
    // Re-enter runQuery with the captured payload so a selection/statement
    // run does not re-resolve from a moved caret (and so the gate does not
    // loop on the same destructive script). runQuery targets the active
    // tab, so bring the origin tab back first — or drop it if it's gone.
    if (get().activeTabId !== gate.tabId) {
      if (!get().tabs.some((t) => t.id === gate.tabId)) return;
      set({ activeTabId: gate.tabId });
    }
    if (gate.safe) {
      void get().runSafeRun({ sql: gate.sql, base: gate.base, gated: true });
      return;
    }
    void get().runQuery({ sql: gate.sql, base: gate.base });
  },

  confirmUserSql(sql, opts) {
    return requestProdConfirm(set, get, sql, opts);
  },

  confirmUserSqlDetailed(sql, opts) {
    return requestProdConfirmDetailed(set, get, sql, opts);
  },

  cancelProdGate() {
    cancelProdGate(set);
  },
});
