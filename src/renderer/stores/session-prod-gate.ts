/**
 * Prod-gate helpers (U39, F8, A7).
 *
 * The confirm dialog is driven by `prodGate` in the session store.
 * `runQuery` arms it for the editor; this module adds the promise-based
 * variant used by every other place that runs user-originated SQL
 * (Notebook, Mock data, Explain ANALYZE) so none of them bypasses the
 * prod-tag confirmation.
 */
import { splitSqlStatements } from '@/lib/sql-split';
import { looksDestructive } from './session-sql-heuristics';

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

/** True when any statement in `sql` looks destructive. */
export function scriptLooksDestructive(sql: string): boolean {
  return splitSqlStatements(sql).some((s) => looksDestructive(s.text));
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
  if (!isProdTagged(get)) return Promise.resolve(true);
  if (!opts?.force && !scriptLooksDestructive(sql)) return Promise.resolve(true);
  if (get().prodGate != null) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    externalResolve = resolve;
    set({
      prodGate: {
        sql,
        tabId: get().activeTabId ?? '',
        connectionGen: get().connectionGen ?? 0,
        kind: 'external',
        summary: opts?.summary,
      },
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
