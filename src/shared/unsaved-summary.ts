import type { AppUnsavedState } from './protocol';

/**
 * What would be lost if Plasma closed or restarted right now, as short noun
 * phrases ("3 unsaved grid edits"). One source for the window-close guard and
 * for the "Restart to update" confirmation, so both name exactly the same
 * things. Empty when nothing is at stake.
 *
 * Unsaved SQL text is normally not on this list: the tab strip is written to
 * disk and comes back after the restart. Only text that persistence cannot
 * keep (`unsavedSqlTabs`) is listed.
 */
export function describeLoss(state: AppUnsavedState): string[] {
  const parts: string[] = [];
  if (state.openTransaction) parts.push('an open transaction (it will be rolled back)');
  if (state.pendingEdits > 0) {
    parts.push(`${state.pendingEdits} unsaved grid edit${state.pendingEdits === 1 ? '' : 's'}`);
  }
  if (state.safeRunPending)
    parts.push('a Safe Run waiting for Commit or Roll back (it will be rolled back)');
  if (state.runningQuery) parts.push('a query that is still running (it will be cancelled)');
  const tabs = state.unsavedSqlTabs ?? 0;
  if (tabs > 0) {
    parts.push(`${tabs} SQL tab${tabs === 1 ? '' : 's'} with unsaved text that cannot be restored`);
  }
  return parts;
}

/** "a and b" / "a, b and c". */
export function joinLoss(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
