/**
 * Apply a validated table view (see `@shared/table-view`) to a table tab and
 * undo it again. Goes through the same reload path the grid itself uses, so
 * it works for a tab that is not the active one. Nothing here persists: the
 * hidden columns stay out of per-table column state and the page size does
 * not touch the `defaultPageSize` setting.
 */
import type { Filter, TableSort } from '@/lib/table-query';
import { useSession } from '@/stores/session';
import { columnsForTable, patchTabById } from '@/stores/session-tab-model';
import { reloadTableTab } from '@/stores/session-table-query';
import type { SessionState } from '@/stores/session-types';
import type { TableViewSpec } from '@shared/table-view';

/** What `applyTableView` changed, so `restoreTableView` can put it back. */
export interface TableViewSnapshot {
  hiddenColumns: Set<string>;
  /** Columns hidden by an agent view, which never reach persisted column state. */
  agentHiddenColumns: Set<string>;
  tableSort: TableSort[];
  filters: Filter[];
  pageSize: number;
  page: number;
}

let filterSeq = 0;
const freshFilterId = () => `ai-view-${Date.now().toString(36)}-${filterSeq++}`;

const setFn = (fn: (s: SessionState) => Partial<SessionState>) => useSession.setState(fn as never);

function reload(tabId: string): Promise<void> {
  return reloadTableTab(setFn, useSession.getState, tabId);
}

/**
 * Set the view on `tabId` and reload it once (resolves after the page query
 * finished). Returns the prior state. Throws when the tab is not a table tab.
 */
export async function applyTableView(
  tabId: string,
  view: TableViewSpec,
): Promise<TableViewSnapshot> {
  const state = useSession.getState();
  const tab = state.tabs.find((t) => t.id === tabId);
  if (!tab || tab.kind !== 'table' || !tab.tableSchema || !tab.tableName) {
    throw new Error('The table tab is no longer open.');
  }
  const snapshot: TableViewSnapshot = {
    hiddenColumns: new Set(tab.hiddenColumns),
    agentHiddenColumns: new Set(tab.agentHiddenColumns ?? []),
    tableSort: tab.tableSort.map((s: TableSort) => ({ ...s })),
    filters: tab.filters.map((f: Filter) => ({ ...f })),
    pageSize: tab.pageSize,
    page: tab.page,
  };

  const patch: Record<string, unknown> = { page: 0, selectedRows: new Set<number>() };
  if (view.columns != null) {
    const keep = new Set(view.columns);
    const all = columnsForTable(state.schema, tab.tableSchema, tab.tableName);
    const hidden = new Set(all.filter((c) => !keep.has(c)));
    patch.hiddenColumns = hidden;
    // What the user had hidden is theirs; the rest is the view's and stays out of saved column state.
    patch.agentHiddenColumns = new Set(
      [...hidden].filter(
        (c) => !snapshot.hiddenColumns.has(c) || snapshot.agentHiddenColumns.has(c),
      ),
    );
  }
  if (view.sort !== undefined) {
    patch.tableSort = view.sort.map((s) => ({ column: s.column, direction: s.direction }));
  }
  if (view.filters !== undefined) {
    // Filters the user switched off are not part of what the model saw: they stay.
    patch.filters = [
      ...view.filters.map((f) => ({ ...f, id: freshFilterId() })),
      ...tab.filters.filter((f: Filter) => f.enabled === false).map((f: Filter) => ({ ...f })),
    ];
  }
  if (view.limit != null) patch.pageSize = view.limit;

  patchTabById(setFn, tabId, patch);
  await reload(tabId);
  return snapshot;
}

/** Put a snapshot back and reload. A closed tab is a no-op. */
export async function restoreTableView(tabId: string, snapshot: TableViewSnapshot): Promise<void> {
  const tab = useSession.getState().tabs.find((t) => t.id === tabId);
  if (!tab || tab.kind !== 'table') return;
  patchTabById(setFn, tabId, {
    hiddenColumns: new Set(snapshot.hiddenColumns),
    agentHiddenColumns: new Set(snapshot.agentHiddenColumns),
    tableSort: snapshot.tableSort.map((s) => ({ ...s })),
    filters: snapshot.filters.map((f) => ({ ...f })),
    pageSize: snapshot.pageSize,
    page: snapshot.page,
    selectedRows: new Set<number>(),
  });
  await reload(tabId);
}
