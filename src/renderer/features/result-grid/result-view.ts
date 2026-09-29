/**
 * Which pane the results area shows after a multi-statement run that
 * failed part-way (E6 / VF4): the successful statements keep their own
 * result tabs and the failure gets an "Error" tab. Selecting a result tab
 * hides the error panel for that run only (keyed by `queryGeneration`,
 * so the next run starts on the error again if it fails).
 */
import { useSession } from '@/stores/session';

export interface TabLike {
  kind: string;
  queryError: string | null;
  queryResults?: unknown[];
  queryGeneration?: number;
  errorTabHiddenGen?: number;
}

/** True when the result area should show the error panel. */
export function isErrorTabActive(tab: TabLike | null | undefined): boolean {
  if (!tab?.queryError) return false;
  if (tab.kind !== 'sql' || !((tab.queryResults?.length ?? 0) > 0)) return true;
  return tab.errorTabHiddenGen !== (tab.queryGeneration ?? 0);
}

/** True when a failed run also produced results the user can switch to. */
export function hasPartialResults(tab: TabLike | null | undefined): boolean {
  return Boolean(tab?.queryError && tab.kind === 'sql' && (tab.queryResults?.length ?? 0) > 0);
}

function patchTab(tabId: string, patch: Record<string, unknown>): void {
  useSession.setState((s) => ({
    tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t)),
  }));
}

/** Show the successful results of a partially failed run. */
export function hideErrorTab(tab: TabLike & { id: string }): void {
  patchTab(tab.id, { errorTabHiddenGen: tab.queryGeneration ?? 0 });
}

/** Bring the error panel back. */
export function showErrorTab(tab: { id: string }): void {
  patchTab(tab.id, { errorTabHiddenGen: -1 });
}
