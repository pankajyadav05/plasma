/**
 * Pending-edits ownership (U39 / advisor simplification #1).
 *
 * Owns: committing the buffered inline-edit tray via one worker
 * `commitEditBatch` (U05) with connectionGen checks (U01), and reverting
 * optimistic cells by re-running table data queries. Tab refresh after
 * commit/revert uses the table-query helper passed in as a dep.
 */
import { ipc } from '@/lib/ipc';
import { buildUpdateSql } from '@/lib/table-query';
import type { PendingEdit, QueryTab } from './session';

/**
 * Zustand set/get are typed loosely here so this module can compose into
 * the full SessionState store without importing it (avoids cycles).
 */
// biome-ignore lint/suspicious/noExplicitAny: slice composed into SessionState
type Set = (partial: any, ...args: any[]) => void;
// biome-ignore lint/suspicious/noExplicitAny: slice composed into SessionState
type Get = () => any;

export type PendingEditsDeps = {
  runTableDataQuery: (set: Set, get: Get, tabId: string) => Promise<void>;
};

export async function commitPendingEdits(
  set: Set,
  get: Get,
  deps: PendingEditsDeps,
): Promise<void> {
  const state = get();
  const edits = state.pendingEdits as PendingEdit[];
  if (edits.length === 0) return;
  // U01: every edit must still target the live connection generation.
  const liveGen = state.connectionGen as number;
  const mismatched = edits.filter((e) => e.connectionGen !== liveGen);
  if (mismatched.length > 0 || liveGen <= 0) {
    throw new Error(
      'pending edits belong to a previous connection — discard them before committing',
    );
  }
  set({ pendingEditsBusy: true });
  try {
    // U05: one worker request owns BEGIN/UPDATEs/COMMIT (or SAVEPOINT
    // when a user transaction is already open). Never a sequence of
    // unrelated IPC calls that can commit foreign work.
    const updates = edits.map((e) => {
      const { sql, params } = buildUpdateSql({
        schema: e.schema,
        table: e.table,
        set: { [e.column]: e.newValue },
        pkValues: e.pkValues,
      });
      return { sql, params };
    });
    const res = await ipc.query.commitEditBatch({
      connectionGen: liveGen,
      updates,
    });
    set({ pendingEdits: [], txnState: res.state });
    // Refresh every still-open tab that had pending edits. Edits whose
    // origin tab was closed are preserved through commit (U01) but have
    // nothing to refresh.
    const tabIds = new Set(edits.map((e) => e.tabId));
    for (const id of tabIds) {
      const tab = get().tabs.find((t: QueryTab) => t.id === id) as QueryTab | undefined;
      if (tab && tab.kind === 'table') {
        void deps.runTableDataQuery(set, get, id);
      }
    }
  } finally {
    set({ pendingEditsBusy: false });
  }
}

export async function revertPendingEdits(
  set: Set,
  get: Get,
  deps: PendingEditsDeps,
): Promise<void> {
  const state = get();
  const tabIds = new Set((state.pendingEdits as PendingEdit[]).map((e) => e.tabId));
  set({ pendingEdits: [] });
  // Re-run the data query for each affected tab so the optimistic
  // mirrored cells reset to their server values.
  for (const id of tabIds) {
    const tab = get().tabs.find((t: QueryTab) => t.id === id) as QueryTab | undefined;
    if (tab && tab.kind === 'table') {
      void deps.runTableDataQuery(set, get, id);
    }
  }
}
