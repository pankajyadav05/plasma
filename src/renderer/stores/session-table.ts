/**
 * Postgres table-browsing slice: opening table tabs, paging / sorting /
 * filtering / column visibility, grid selection and the buffered
 * row-editing tray. The server queries live in `session-table-query.ts`,
 * the tray logic in `session-pending-edits.ts`.
 */
import type { EditConflict } from '@/lib/edit-conflicts';
import type { Filter, TableSort } from '@/lib/table-query';
import {
  closeEditConflicts as closeEditConflictsAction,
  commitPendingEdits as commitPendingEditsAction,
  discardPendingEdit as discardPendingEditAction,
  duplicateValues,
  queueCellEdit,
  queueCellEdits,
  queueInsert,
  queueInserts,
  queueRowDeletes,
  resolveEditConflict as resolveEditConflictAction,
  revertPendingEdits as revertPendingEditsAction,
  tabsWithEdits,
  updatePendingInsert as updatePendingInsertAction,
  updatePendingInserts as updatePendingInsertsAction,
} from './session-pending-edits';
import type { BulkEditResult, CellEditInput } from './session-pending-edits';
import type { PendingEditsByTab, PendingEditsError } from './session-pending-edits';
import {
  activeTab,
  columnMetaFor,
  createTableTab,
  loadTableColumnStateInto,
  patchActiveTab,
  persistTableColumnState,
  toggled,
} from './session-tab-model';
import {
  loadTableTab,
  reloadTableTab,
  runTableCountQuery,
  runTableDataQuery,
} from './session-table-query';
import { isPreviewTab } from './session-tabs';
import type { QueryTab, SliceCreator } from './session-types';

// Debounce handle for column-width drag persistence. During a drag we
// rewrite the tab's columnWidths on every pointermove — we only want
// to hit IPC + disk once, when the user actually lets go.
let columnWidthPersistTimer: ReturnType<typeof setTimeout> | null = null;

export interface TableSlice {
  // ── Pending edits (buffered inline-edit tray) ──
  /** Staged grid edits per tab id (R-01/R-02). */
  pendingEditsByTab: PendingEditsByTab;
  pendingEditsBusy: boolean;
  /** Last commit failure: Postgres message + the edits whose statement failed. */
  pendingEditsError: PendingEditsError | null;
  /** Rows that changed on the server since they were loaded, found by the last commit (B1). */
  editConflicts: { tabId: string; items: EditConflict[] } | null;
  /** The conflict review dialog is showing. */
  editConflictsOpen: boolean;
  /**
   * Open a table tab. Single clicks open a reusable *preview* tab (italic)
   * that the next preview open replaces; `preview: false` pins it.
   */
  openTable(schema: string, table: string, opts?: { newTab?: boolean; preview?: boolean }): void;
  /**
   * `also` adds equality filters for the other columns of a composite
   * foreign key (F7); values there are Postgres text.
   */
  openForeignRow(
    refSchema: string,
    refTable: string,
    refColumn: string,
    value: unknown,
    also?: Array<{ column: string; value: string }>,
  ): void;
  setPage(page: number): void;
  setPageSize(pageSize: number): void;
  setSort(index: number): void;

  toggleRowSelected(idx: number): void;
  setSelectedRows(rows: Set<number>): void;
  clearSelectedRows(): void;
  setSelectedCell(cell: { row: number; col: number } | null): void;
  setColumnWidth(index: number, width: number): void;

  // Table-tab specific
  addFilter(filter: Filter): Promise<void>;
  updateFilter(id: string, patch: Partial<Filter>): Promise<void>;
  removeFilter(id: string): Promise<void>;
  clearFilters(): Promise<void>;
  setHiddenColumns(hidden: Set<string>): Promise<void>;
  toggleColumnHidden(column: string): Promise<void>;
  showAllColumns(): Promise<void>;
  toggleStickyColumn(column: string): void;
  clearStickyColumns(): void;
  refreshTable(): Promise<void>;

  // Row editing (table tabs, edit mode only)
  updateCell(rowIndex: number, columnIndex: number, newValue: string | null): Promise<void>;
  insertRow(values: Record<string, string | null>): Promise<void>;
  deleteRow(rowIndex: number): Promise<void>;
  /** Toggle pending deletion of rows (indices into the tab's result rows). */
  deleteRows(rowIndices: number[]): void;
  /** Queue an INSERT copying the row (PKs with defaults left to the server). */
  duplicateRow(rowIndex: number): void;
  updatePendingInsert(id: string, column: string, value: string | null): void;
  /** Bulk edits (set value / fill / paste / find & replace): one store update, reports what was staged. */
  updateCells(edits: CellEditInput[]): BulkEditResult;
  /** Queue several INSERTs at once (pasted rows); returns how many were queued. */
  insertRows(rows: Array<Record<string, string | null>>): number;
  updatePendingInserts(changes: Array<{ id: string; column: string; value: string | null }>): void;
  discardPendingEdit(id: string): void;
  // Pending edits (buffered inline-edit tray)
  /** Commits ONLY the edits of `tabId` (default: the active tab). */
  commitPendingEdits(opts?: { confirmed?: boolean; tabId?: string }): Promise<void>;
  /** Discards the edits of `tabId` (default: the active tab). */
  revertPendingEdits(opts?: { tabId?: string }): Promise<void>;
  /** Keep my change (re-staged on the server's values) or take theirs (drop mine) for one row. */
  resolveEditConflict(conflictId: string, choice: 'mine' | 'theirs'): void;
  /** Close the conflict review (edits stay staged). */
  closeEditConflicts(): void;
  /** Re-open it from the commit banner. */
  openEditConflicts(): void;
}

export const createTableSlice: SliceCreator<TableSlice> = (set, get) => ({
  pendingEditsByTab: {},
  pendingEditsBusy: false,
  pendingEditsError: null,
  editConflicts: null,
  editConflictsOpen: false,

  openTable(schemaName, tableName, opts) {
    const state = get();
    void get().ensureSchemaColumns(schemaName);
    // Reuse an existing table tab for the same schema+table
    const existing = opts?.newTab
      ? undefined
      : state.tabs.find(
          (t) => t.kind === 'table' && t.tableSchema === schemaName && t.tableName === tableName,
        );
    const preview = opts?.preview ?? !opts?.newTab;
    if (existing) {
      set({
        activeTabId: existing.id,
        activeTable: { schema: schemaName, name: tableName },
        ...(preview || !existing.preview
          ? {}
          : { tabs: state.tabs.map((t) => (t.id === existing.id ? { ...t, preview: false } : t)) }),
      });
      return;
    }
    // Create a fresh table tab, then layer any persisted column state
    // (widths / hidden / sticky) ON TOP before kicking off the query —
    // hiddenColumns in particular has to be set before the SELECT is
    // compiled so the server doesn't return columns we're about to hide.
    const baseTab = createTableTab(state.settings.defaultPageSize, schemaName, tableName);
    const persistedPatch = loadTableColumnStateInto(state, schemaName, tableName);
    const tab: QueryTab = { ...baseTab, ...persistedPatch, preview };
    // A single-click open replaces the current untouched preview tab in
    // place (TablePlus / VS Code preview tabs, VF17).
    const editedTabs = tabsWithEdits(state.pendingEditsByTab);
    const previewIdx =
      preview && !opts?.newTab ? state.tabs.findIndex((t) => isPreviewTab(t, editedTabs)) : -1;
    const nextTabs =
      previewIdx === -1
        ? [...state.tabs, tab]
        : state.tabs.map((t, i) => (i === previewIdx ? tab : t));
    set({
      tabs: nextTabs,
      activeTabId: tab.id,
      activeTable: { schema: schemaName, name: tableName },
    });
    loadTableTab(set, get, tab.id, true);
  },

  openForeignRow(refSchema, refTable, refColumn, value, also) {
    // FK click-through: open the referenced table as a fresh table tab
    // with an equality filter on the referenced column pre-applied. We
    // always create a new tab so prior FK navigations stay inspectable.
    if (value === null || value === undefined) return;
    const state = get();
    void get().ensureSchemaColumns(refSchema);
    const baseTab = createTableTab(state.settings.defaultPageSize, refSchema, refTable);
    const persistedPatch = loadTableColumnStateInto(state, refSchema, refTable);
    const fkId = () => `fk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const filter: Filter = {
      id: fkId(),
      column: refColumn,
      op: '=',
      value: value instanceof Date ? value.toISOString() : String(value),
    };
    const extra: Filter[] = (also ?? []).map((p) => ({
      id: fkId(),
      column: p.column,
      op: '=',
      value: p.value,
    }));
    const tab: QueryTab = { ...baseTab, ...persistedPatch, filters: [filter, ...extra] };
    set({
      tabs: [...state.tabs, tab],
      activeTabId: tab.id,
      activeTable: { schema: refSchema, name: refTable },
    });
    loadTableTab(set, get, tab.id, true);
  },

  setPage(page) {
    const tab = activeTab(get());
    if (!tab) return;
    const next = Math.max(0, page);
    patchActiveTab(set, get, { page: next, selectedRows: new Set() });
    if (tab.kind === 'table') {
      void runTableDataQuery(set, get, tab.id);
    }
  },

  setPageSize(pageSize) {
    const tab = activeTab(get());
    if (!tab) return;
    patchActiveTab(set, get, { pageSize, page: 0, selectedRows: new Set() });
    void get().updateSettings({ defaultPageSize: pageSize });
    if (tab.kind === 'table') {
      void runTableDataQuery(set, get, tab.id);
    }
  },

  setSort(index) {
    const tab = activeTab(get());
    if (!tab) return;

    if (tab.kind === 'table') {
      // Server-side sort: cycle none → asc → desc → none on the column name
      const columnName = tab.queryResult?.columns[index]?.name;
      if (!columnName) return;
      const current = tab.tableSort.find((s) => s.column === columnName);
      let nextSort: TableSort[];
      if (!current) {
        nextSort = [{ column: columnName, direction: 'asc' }];
      } else if (current.direction === 'asc') {
        nextSort = [{ column: columnName, direction: 'desc' }];
      } else {
        nextSort = [];
      }
      patchActiveTab(set, get, { tableSort: nextSort, page: 0 });
      void runTableDataQuery(set, get, tab.id);
      return;
    }

    // Client-side sort for SQL tabs
    let nextSort: { index: number; direction: 'asc' | 'desc' } | null;
    if (!tab.sortColumn || tab.sortColumn.index !== index) {
      nextSort = { index, direction: 'asc' };
    } else if (tab.sortColumn.direction === 'asc') {
      nextSort = { index, direction: 'desc' };
    } else {
      nextSort = null;
    }
    patchActiveTab(set, get, { sortColumn: nextSort, page: 0 });
  },

  setSelectedCell(cell) {
    patchActiveTab(set, get, { selectedCell: cell });
  },

  toggleRowSelected(idx) {
    const tab = activeTab(get());
    if (!tab) return;
    patchActiveTab(set, get, { selectedRows: toggled(tab.selectedRows, idx) });
  },

  setSelectedRows(rows) {
    patchActiveTab(set, get, { selectedRows: rows });
  },

  clearSelectedRows() {
    patchActiveTab(set, get, { selectedRows: new Set() });
  },

  setColumnWidth(index, width) {
    const tab = activeTab(get());
    if (!tab) return;
    patchActiveTab(set, get, {
      columnWidths: { ...tab.columnWidths, [index]: width },
    });
    // Drag fires this on every pointermove — debounce the IPC write so
    // we only persist once the user lets go of the handle.
    if (tab.kind === 'table') {
      if (columnWidthPersistTimer) clearTimeout(columnWidthPersistTimer);
      columnWidthPersistTimer = setTimeout(() => {
        persistTableColumnState(set, get);
        columnWidthPersistTimer = null;
      }, 300);
    }
  },

  // ── Table-tab specific actions ──

  async addFilter(filter) {
    const tab = activeTab(get());
    if (!tab || tab.kind !== 'table') return;
    patchActiveTab(set, get, {
      filters: [...tab.filters, filter],
      page: 0,
    });
    await reloadTableTab(set, get, tab.id);
  },

  async updateFilter(id, patch) {
    const tab = activeTab(get());
    if (!tab || tab.kind !== 'table') return;
    const nextFilters = tab.filters.map((f) => (f.id === id ? { ...f, ...patch } : f));
    patchActiveTab(set, get, { filters: nextFilters, page: 0 });
    await reloadTableTab(set, get, tab.id);
  },

  async removeFilter(id) {
    const tab = activeTab(get());
    if (!tab || tab.kind !== 'table') return;
    patchActiveTab(set, get, {
      filters: tab.filters.filter((f) => f.id !== id),
      page: 0,
    });
    await reloadTableTab(set, get, tab.id);
  },

  async clearFilters() {
    const tab = activeTab(get());
    if (!tab || tab.kind !== 'table') return;
    patchActiveTab(set, get, { filters: [], page: 0 });
    await reloadTableTab(set, get, tab.id);
  },

  async setHiddenColumns(hidden) {
    const tab = activeTab(get());
    if (!tab || tab.kind !== 'table') return;
    patchActiveTab(set, get, { hiddenColumns: hidden, agentHiddenColumns: new Set() });
    await runTableDataQuery(set, get, tab.id);
  },

  async toggleColumnHidden(column) {
    const tab = activeTab(get());
    if (!tab) return;
    // A column the user toggles is their choice from now on, whatever hid it before.
    const agentHidden = new Set<string>(tab.agentHiddenColumns ?? []);
    agentHidden.delete(column);
    patchActiveTab(set, get, {
      hiddenColumns: toggled(tab.hiddenColumns, column),
      agentHiddenColumns: agentHidden,
    });
    if (tab.kind === 'table') {
      await runTableDataQuery(set, get, tab.id);
      persistTableColumnState(set, get);
    }
  },

  async showAllColumns() {
    const tab = activeTab(get());
    if (!tab) return;
    patchActiveTab(set, get, { hiddenColumns: new Set(), agentHiddenColumns: new Set() });
    if (tab.kind === 'table') {
      await runTableDataQuery(set, get, tab.id);
      persistTableColumnState(set, get);
    }
  },

  toggleStickyColumn(column) {
    const tab = activeTab(get());
    if (!tab) return;
    patchActiveTab(set, get, { stickyColumns: toggled(tab.stickyColumns, column) });
    persistTableColumnState(set, get);
  },

  clearStickyColumns() {
    const tab = activeTab(get());
    if (!tab) return;
    patchActiveTab(set, get, { stickyColumns: new Set() });
    persistTableColumnState(set, get);
  },

  async refreshTable() {
    const tab = activeTab(get());
    if (!tab || tab.kind !== 'table') return;
    await reloadTableTab(set, get, tab.id);
  },

  // ── row editing (table tabs only, gated by editMode) ──

  async updateCell(rowIndex, columnIndex, newValue) {
    // Buffered edits: every cell change is queued in `pendingEdits` as an
    // overlay (server rows stay untouched — see session-pending-edits.ts).
    // Nothing reaches the database until the tray is committed. No-op
    // edits are dropped; `null` means SQL NULL, never ''.
    queueCellEdit(set, get, rowIndex, columnIndex, newValue);
  },

  async insertRow(values) {
    const state = get();
    const tab = activeTab(state);
    if (!tab || tab.kind !== 'table' || !tab.tableSchema || !tab.tableName) return;

    // Drop empty strings on columns with defaults — let Postgres apply them.
    const cols = columnMetaFor(state.schema, tab.tableSchema, tab.tableName);
    const toInsert: Record<string, string | null> = {};
    for (const c of cols) {
      const raw = values[c.name];
      if (raw === undefined) continue;
      if (raw === '' && c.hasDefault) continue;
      toInsert[c.name] = raw === '' && c.isNullable ? null : raw;
    }
    // Queued with the rest of the tray (A5): committed in one batch
    // through the prod-tag confirmation.
    queueInsert(set, get, toInsert);
  },

  async deleteRow(rowIndex) {
    queueRowDeletes(set, get, [rowIndex]);
  },

  deleteRows(rowIndices) {
    queueRowDeletes(set, get, rowIndices);
  },

  duplicateRow(rowIndex) {
    const state = get();
    const tab = activeTab(state);
    if (!tab || tab.kind !== 'table' || !tab.tableSchema || !tab.tableName || !tab.queryResult)
      return;
    const row = tab.queryResult.rows[rowIndex];
    if (!row) return;
    const cols = columnMetaFor(state.schema, tab.tableSchema, tab.tableName);
    queueInsert(set, get, duplicateValues(tab.queryResult.columns, row, cols));
  },

  updatePendingInsert(id, column, value) {
    updatePendingInsertAction(set, get, id, column, value);
  },

  updateCells(edits) {
    return queueCellEdits(set, get, edits);
  },

  insertRows(rows) {
    return queueInserts(set, get, rows);
  },

  updatePendingInserts(changes) {
    updatePendingInsertsAction(set, get, changes);
  },

  discardPendingEdit(id) {
    discardPendingEditAction(set, get, id);
  },

  async commitPendingEdits(opts) {
    await commitPendingEditsAction(set, get, { runTableDataQuery, runTableCountQuery }, opts);
  },

  async revertPendingEdits(opts) {
    await revertPendingEditsAction(set, get, { runTableDataQuery }, opts);
  },

  resolveEditConflict(conflictId, choice) {
    resolveEditConflictAction(
      set,
      get,
      { runTableDataQuery, runTableCountQuery },
      conflictId,
      choice,
    );
  },

  closeEditConflicts() {
    closeEditConflictsAction(set);
  },

  openEditConflicts() {
    if (get().editConflicts) set({ editConflictsOpen: true });
  },
});
