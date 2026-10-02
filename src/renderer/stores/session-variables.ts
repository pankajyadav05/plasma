/**
 * Query-variable state helpers for the Variables bar. Values live on the
 * SQL tab (`queryVars`), so each tab remembers its own; per-variable
 * history is a persisted setting shared by all tabs.
 *
 * Plain functions over `useSession` (not a slice) so the run pipeline in
 * `session-query` never imports the store it is part of.
 */
import { listVariables, variableProblem } from '@/lib/query-variables';
import type { VariableValue } from '@shared/sql-variables';
import { useSession } from './session';

function patchTab(tabId: string, patch: Record<string, unknown>): void {
  useSession.setState((s) => ({
    tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t)),
  }));
}

/** Set one variable's typed value. Editing counts as reviewing the values. */
export function setQueryVar(tabId: string, name: string, value: VariableValue): void {
  useSession.setState((s) => ({
    tabs: s.tabs.map((t) =>
      t.id === tabId
        ? {
            ...t,
            queryVars: { ...(t.queryVars ?? {}), [name]: value },
            varsReviewed: true,
            varsAttention: null,
          }
        : t,
    ),
  }));
}

export function setVarsBarOpen(tabId: string, open: boolean): void {
  patchTab(tabId, open ? { varsBarOpen: true } : { varsBarOpen: false, varsAttention: null });
}

/** Called by the bar's Run button: the user has seen the values. */
export function markVarsReviewed(tabId: string): void {
  patchTab(tabId, { varsReviewed: true, varsAttention: null });
}

/**
 * Gate for anything that runs `sql` outside `runQuery` (Explain, Safe Run):
 * true when its variables all have valid, reviewed values. Otherwise opens
 * the Variables bar with the reason and returns false.
 */
export function ensureVariablesReady(
  tab: { id: string; queryVars?: Record<string, VariableValue>; varsReviewed?: boolean },
  sql: string,
): boolean {
  if (listVariables(sql).length === 0) return true;
  const problem = variableProblem(sql, tab.queryVars ?? {});
  if (!problem && tab.varsReviewed === true) return true;
  patchTab(tab.id, { varsBarOpen: true, varsAttention: problem });
  return false;
}
