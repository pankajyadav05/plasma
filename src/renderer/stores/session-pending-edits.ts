/**
 * Pending-edits ownership (U39 / advisor simplification #1).
 *
 * Every grid write — cell update, row insert / duplicate, row delete — is
 * queued here as a `PendingEdit` and nothing touches the database until
 * the user commits the tray (toolbar Commit or ⌘S). The whole tray then
 * goes to the worker as one `commitEditBatch` (U05) with connectionGen
 * checks (U01) and the prod-tag confirmation.
 *
 * Edits are an **overlay**: the server rows in `queryResult` are never
 * mutated. The grid renders `overlayRows(…)`, so
 *  - the original primary key of a row is always the server's value, even
 *    after the PK column itself was edited (WHERE never uses a new value);
 *  - edits survive paging / sorting / refresh (they're keyed by PK, not by
 *    visible row index) and stay tinted until committed or discarded;
 *  - discarding is just dropping the queue — no re-query needed.
 */
import { cellToText, isNoopEdit } from '@/features/result-grid/cell-edit';
import { cleanIpcError } from '@/lib/errors';
import { ipc } from '@/lib/ipc';
import { buildDeleteSql, buildUpdateSql, quoteIdent } from '@/lib/table-query';
import type { ColumnMeta, SchemaInfo } from '@shared/protocol';
import type { PendingEdit, QueryTab } from './session';

/**
 * Zustand set/get are typed loosely here so this module can compose into
 * the full SessionState store without importing it (avoids cycles).
 */
// biome-ignore lint/suspicious/noExplicitAny: slice composed into SessionState
type Set = (partial: any, ...args: any[]) => void;
// biome-ignore lint/suspicious/noExplicitAny: slice composed into SessionState
type Get = () => any;

export type PendingKind = 'update' | 'insert' | 'delete';

export type PendingEditsDeps = {
  runTableDataQuery: (set: Set, get: Get, tabId: string) => Promise<void>;
  runTableCountQuery?: (set: Set, get: Get, tabId: string) => Promise<void>;
};

export interface PendingEditsError {
  message: string;
  /** Edits whose statement failed (tinted red in the grid). */
  editIds: string[];
}

export function editKind(e: Pick<PendingEdit, 'kind'>): PendingKind {
  return e.kind ?? 'update';
}

// ─── Pure helpers (unit-tested) ──────────────────────────────────────

/** Stable identity for a row: its primary-key values as Postgres text. */
export function rowKeyOf(pkValues: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(pkValues)
      .sort()
      .map((k) => [k, pkValues[k] ?? null]),
  );
}

/** Primary-key column names of a table, in ordinal order. */
export function tablePkNames(
  schema: SchemaInfo | null | undefined,
  schemaName: string | undefined,
  tableName: string | undefined,
): string[] {
  if (!schema || !schemaName || !tableName) return [];
  return schema.columns
    .filter((c) => c.schema === schemaName && c.table === tableName && c.isPrimaryKey)
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((c) => c.name);
}

/**
 * The row's PK values as Postgres text (so dates / numerics round-trip
 * exactly), or null when a PK column isn't in the result.
 */
export function pkValuesFromRow(
  columns: readonly ColumnMeta[],
  row: readonly unknown[],
  pkNames: readonly string[],
): Record<string, string | null> | null {
  if (pkNames.length === 0) return null;
  const out: Record<string, string | null> = {};
  for (const name of pkNames) {
    const idx = columns.findIndex((c) => c.name === name);
    if (idx < 0) return null;
    out[name] = cellToText(row[idx], columns[idx]?.dataTypeName);
  }
  return out;
}

export type RowStatus = 'clean' | 'edited' | 'deleted';

export interface RowOverlay {
  /** Values to display: server values with pending cell edits applied. */
  row: unknown[];
  status: RowStatus;
  /** Result-column indices with a pending edit. */
  editedCols: ReadonlySet<number>;
  /** Pending edit id per edited column index (for error pointers). */
  editIdByCol: ReadonlyMap<number, string>;
  rowKey: string | null;
}

const EMPTY_COLS: ReadonlySet<number> = new Set();
const EMPTY_IDS: ReadonlyMap<number, string> = new Map();

/**
 * Apply a tab's pending update / delete edits to its server rows.
 * Rows without a matching PK (or tables without one) come back clean.
 */
export function overlayRows(
  tabId: string,
  columns: readonly ColumnMeta[],
  rows: readonly unknown[][],
  pkNames: readonly string[],
  edits: readonly PendingEdit[],
): RowOverlay[] {
  const mine = edits.filter((e) => e.tabId === tabId && editKind(e) !== 'insert');
  if (mine.length === 0 || pkNames.length === 0) {
    return rows.map((row) => ({
      row: row as unknown[],
      status: 'clean',
      editedCols: EMPTY_COLS,
      editIdByCol: EMPTY_IDS,
      rowKey: null,
    }));
  }
  const byRow = new Map<string, PendingEdit[]>();
  for (const e of mine) {
    const key = e.rowKey ?? rowKeyOf(e.pkValues);
    const list = byRow.get(key);
    if (list) list.push(e);
    else byRow.set(key, [e]);
  }
  const colIndex = new Map(columns.map((c, i) => [c.name, i] as const));
  return rows.map((row) => {
    const pk = pkValuesFromRow(columns, row, pkNames);
    const key = pk ? rowKeyOf(pk) : null;
    const list = key ? byRow.get(key) : undefined;
    if (!list) {
      return {
        row: row as unknown[],
        status: 'clean' as const,
        editedCols: EMPTY_COLS,
        editIdByCol: EMPTY_IDS,
        rowKey: key,
      };
    }
    const next = row.slice();
    const editedCols = new Set<number>();
    const editIdByCol = new Map<number, string>();
    let deleted = false;
    for (const e of list) {
      if (editKind(e) === 'delete') {
        deleted = true;
        continue;
      }
      const idx = colIndex.get(e.column);
      if (idx === undefined) continue;
      next[idx] = e.newValue;
      editedCols.add(idx);
      editIdByCol.set(idx, e.id);
    }
    return {
      row: next,
      status: deleted
        ? ('deleted' as const)
        : editedCols.size > 0
          ? ('edited' as const)
          : ('clean' as const),
      editedCols,
      editIdByCol,
      rowKey: key,
    };
  });
}

/** Pending inserts queued from a tab, in queue order. */
export function pendingInsertsFor(tabId: string, edits: readonly PendingEdit[]): PendingEdit[] {
  return edits.filter((e) => e.tabId === tabId && editKind(e) === 'insert');
}

export interface EditBatch {
  /** `label` ('update "public"."users"') names the statement in worker errors. */
  updates: Array<{ sql: string; params: unknown[]; label: string }>;
  /** Edit ids behind each statement (same order as `updates`). */
  editIds: string[][];
}

/**
 * Compile the tray into statements, in a safe order:
 *   1. DELETEs (a row being deleted drops its queued cell edits),
 *   2. one UPDATE per row with every changed column merged, always keyed
 *      by the row's ORIGINAL primary key,
 *   3. INSERTs.
 */
export function buildEditBatch(edits: readonly PendingEdit[]): EditBatch {
  const updates: Array<{ sql: string; params: unknown[] }> = [];
  const editIds: string[][] = [];
  const tableKey = (e: PendingEdit) => `${e.schema}\u0000${e.table}`;
  const rowId = (e: PendingEdit) => `${tableKey(e)}\u0000${e.rowKey ?? rowKeyOf(e.pkValues)}`;

  const deletedRows = new Set<string>();
  for (const e of edits) {
    if (editKind(e) !== 'delete') continue;
    const id = rowId(e);
    if (deletedRows.has(id)) continue;
    deletedRows.add(id);
    const { sql, params } = buildDeleteSql({
      schema: e.schema,
      table: e.table,
      pkValues: e.pkValues,
    });
    updates.push({ sql, params });
    editIds.push([e.id]);
  }

  const grouped = new Map<string, PendingEdit[]>();
  for (const e of edits) {
    if (editKind(e) !== 'update') continue;
    const id = rowId(e);
    if (deletedRows.has(id)) continue;
    const list = grouped.get(id);
    if (list) list.push(e);
    else grouped.set(id, [e]);
  }
  for (const list of grouped.values()) {
    const first = list[0]!;
    const set: Record<string, unknown> = {};
    for (const e of list) set[e.column] = e.newValue;
    const { sql, params } = buildUpdateSql({
      schema: first.schema,
      table: first.table,
      set,
      pkValues: first.pkValues,
    });
    updates.push({ sql, params });
    editIds.push(list.map((e) => e.id));
  }

  for (const e of edits) {
    if (editKind(e) !== 'insert') continue;
    const values = e.values ?? {};
    const cols = Object.keys(values);
    const from = `${quoteIdent(e.schema)}.${quoteIdent(e.table)}`;
    if (cols.length === 0) {
      updates.push({ sql: `INSERT INTO ${from} DEFAULT VALUES`, params: [] });
    } else {
      const params = cols.map((c) => values[c] ?? null);
      const sql = `INSERT INTO ${from} (${cols.map(quoteIdent).join(', ')}) VALUES (${cols
        .map((_, i) => `$${i + 1}`)
        .join(', ')})`;
      updates.push({ sql, params });
    }
    editIds.push([e.id]);
  }
  // The worker prefixes failures with "Edit i of n (label)", which is how
  // a failure is mapped back to its cells (failedStatementIndex).
  const labelled = updates.map((u) => {
    const verb = u.sql.slice(0, 6).toUpperCase();
    const target = u.sql.match(/^(?:UPDATE|DELETE FROM|INSERT INTO)\s+(\S+)/)?.[1] ?? '';
    return { ...u, label: `${verb.toLowerCase()} ${target}`.trim() };
  });
  return { updates: labelled, editIds };
}

/**
 * Which statement of the batch failed, if the worker says so. Accepts a
 * structured `failedIndex` / `index` on the error or the message forms
 * "edit 3 of 5" / "statement 3 of 5" (1-based).
 */
export function failedStatementIndex(err: unknown): number | null {
  if (err && typeof err === 'object') {
    for (const k of ['failedIndex', 'editIndex', 'index'] as const) {
      const v = (err as Record<string, unknown>)[k];
      if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v;
    }
  }
  const label = err && typeof err === 'object' ? (err as { label?: unknown }).label : undefined;
  const message = `${typeof label === 'string' ? `${label} ` : ''}${err instanceof Error ? err.message : String(err ?? '')}`;
  const m = message.match(/\b(?:edit|statement|change)\s+#?(\d+)\s+(?:of|\/)\s+\d+/i);
  if (m) return Number(m[1]) - 1;
  return null;
}

/** Short human summary of the tray, e.g. "2 updates, 1 delete". */
export function summarizeEdits(edits: readonly PendingEdit[]): string {
  const rows = new Set<string>();
  let inserts = 0;
  let deletes = 0;
  for (const e of edits) {
    const k = editKind(e);
    if (k === 'insert') inserts++;
    else if (k === 'delete') deletes++;
    else rows.add(`${e.schema}.${e.table}:${e.rowKey ?? rowKeyOf(e.pkValues)}`);
  }
  const parts: string[] = [];
  if (rows.size) parts.push(`${rows.size} update${rows.size === 1 ? '' : 's'}`);
  if (inserts) parts.push(`${inserts} insert${inserts === 1 ? '' : 's'}`);
  if (deletes) parts.push(`${deletes} delete${deletes === 1 ? '' : 's'}`);
  return parts.join(', ') || 'no changes';
}

// ─── Store actions ───────────────────────────────────────────────────

function freshEditId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

interface TableTarget {
  tab: QueryTab;
  schema: string;
  table: string;
  columns: ColumnMeta[];
  rows: unknown[][];
  pkNames: string[];
}

function requireTableTarget(get: Get): TableTarget | null {
  const state = get();
  if (!state.editMode) throw new Error('edit mode is off');
  if (state.activeConfig?.readOnly) throw new Error('read-only connection — writes are disabled');
  const tab = (state.tabs as QueryTab[]).find((t) => t.id === state.activeTabId);
  if (!tab || tab.kind !== 'table' || !tab.tableSchema || !tab.tableName || !tab.queryResult) {
    return null;
  }
  return {
    tab,
    schema: tab.tableSchema,
    table: tab.tableName,
    columns: tab.queryResult.columns,
    rows: tab.queryResult.rows,
    pkNames: tablePkNames(state.schema, tab.tableSchema, tab.tableName),
  };
}

function requirePk(
  target: TableTarget,
  row: unknown[],
  verb: string,
): Record<string, string | null> {
  if (target.pkNames.length === 0) {
    throw new Error(`table has no primary key — cannot ${verb} rows safely`);
  }
  const pk = pkValuesFromRow(target.columns, row, target.pkNames);
  if (!pk) throw new Error(`primary-key column is not in the result — cannot ${verb} rows safely`);
  return pk;
}

function isRowDeleted(edits: PendingEdit[], tabId: string, key: string): boolean {
  return edits.some(
    (e) =>
      e.tabId === tabId && editKind(e) === 'delete' && (e.rowKey ?? rowKeyOf(e.pkValues)) === key,
  );
}

/**
 * Queue (or replace, or drop when it's a no-op) one cell update.
 * `newValue` is Postgres text; `null` sets SQL NULL.
 */
export function queueCellEdit(
  set: Set,
  get: Get,
  rowIndex: number,
  columnIndex: number,
  newValue: string | null,
): void {
  const target = requireTableTarget(get);
  if (!target) return;
  const col = target.columns[columnIndex];
  const row = target.rows[rowIndex];
  if (!col || !row) return;
  const pkValues = requirePk(target, row, 'edit');
  const rowKey = rowKeyOf(pkValues);
  const state = get();
  const edits = state.pendingEdits as PendingEdit[];
  if (isRowDeleted(edits, target.tab.id, rowKey)) {
    throw new Error('this row is marked for deletion — restore it before editing');
  }
  const sameCell = (e: PendingEdit) =>
    e.tabId === target.tab.id &&
    editKind(e) === 'update' &&
    e.column === col.name &&
    (e.rowKey ?? rowKeyOf(e.pkValues)) === rowKey;
  const rest = edits.filter((e) => !sameCell(e));
  const oldValue = row[columnIndex];
  // Typing the original value back (or clicking in and out) un-queues.
  if (isNoopEdit(oldValue, newValue, col.dataTypeName)) {
    if (rest.length !== edits.length) set({ pendingEdits: rest, pendingEditsError: null });
    return;
  }
  const existing = edits.find(sameCell);
  const edit: PendingEdit = {
    id: existing?.id ?? freshEditId(),
    tabId: target.tab.id,
    schema: target.schema,
    table: target.table,
    kind: 'update',
    pkValues,
    rowKey,
    column: col.name,
    oldValue: cellToText(oldValue, col.dataTypeName),
    newValue,
    rowIndex,
    columnIndex,
    connectionGen: state.connectionGen,
  };
  set({
    pendingEdits: existing ? edits.map((e) => (e === existing ? edit : e)) : [...edits, edit],
  });
}

/** Toggle rows' pending deletion (queued; committed with the tray). */
export function queueRowDeletes(set: Set, get: Get, rowIndices: readonly number[]): void {
  const target = requireTableTarget(get);
  if (!target) return;
  const state = get();
  let edits = (state.pendingEdits as PendingEdit[]).slice();
  const keys = rowIndices
    .map((i) => target.rows[i])
    .filter((r): r is unknown[] => Boolean(r))
    .map((r) => ({ row: r, pk: requirePk(target, r, 'delete') }));
  // If every targeted row is already marked, the action restores them.
  const allMarked =
    keys.length > 0 && keys.every(({ pk }) => isRowDeleted(edits, target.tab.id, rowKeyOf(pk)));
  for (const { row, pk } of keys) {
    const rowKey = rowKeyOf(pk);
    const marked = isRowDeleted(edits, target.tab.id, rowKey);
    if (allMarked) {
      edits = edits.filter(
        (e) =>
          !(
            e.tabId === target.tab.id &&
            editKind(e) === 'delete' &&
            (e.rowKey ?? rowKeyOf(e.pkValues)) === rowKey
          ),
      );
    } else if (!marked) {
      edits.push({
        id: freshEditId(),
        tabId: target.tab.id,
        schema: target.schema,
        table: target.table,
        kind: 'delete',
        pkValues: pk,
        rowKey,
        column: '',
        oldValue: row,
        newValue: null,
        rowIndex: target.rows.indexOf(row),
        columnIndex: -1,
        connectionGen: state.connectionGen,
      });
    }
  }
  set({ pendingEdits: edits, pendingEditsError: null });
}

/** Queue an INSERT. `values` maps column → Postgres text (null = NULL). */
export function queueInsert(set: Set, get: Get, values: Record<string, string | null>): void {
  const target = requireTableTarget(get);
  if (!target) return;
  const state = get();
  const edit: PendingEdit = {
    id: freshEditId(),
    tabId: target.tab.id,
    schema: target.schema,
    table: target.table,
    kind: 'insert',
    pkValues: {},
    column: '',
    oldValue: null,
    newValue: null,
    values: { ...values },
    rowIndex: -1,
    columnIndex: -1,
    connectionGen: state.connectionGen,
  };
  set({ pendingEdits: [...(state.pendingEdits as PendingEdit[]), edit], pendingEditsError: null });
}

/**
 * Values for duplicating a row: every column in the result, except
 * primary-key columns with a default (serial / identity / uuid default),
 * which are left to the server.
 */
export function duplicateValues(
  columns: readonly ColumnMeta[],
  row: readonly unknown[],
  tableColumns: SchemaInfo['columns'],
): Record<string, string | null> {
  const meta = new Map(tableColumns.map((c) => [c.name, c] as const));
  const out: Record<string, string | null> = {};
  columns.forEach((c, i) => {
    const m = meta.get(c.name);
    if (!m) return; // not a real column of the table
    if (m.isPrimaryKey && m.hasDefault) return;
    out[c.name] = cellToText(row[i], c.dataTypeName);
  });
  return out;
}

/** Edit a value of a queued INSERT in place. */
export function updatePendingInsert(
  set: Set,
  get: Get,
  id: string,
  column: string,
  value: string | null,
): void {
  const edits = get().pendingEdits as PendingEdit[];
  set({
    pendingEdits: edits.map((e) =>
      e.id === id && editKind(e) === 'insert'
        ? { ...e, values: { ...(e.values ?? {}), [column]: value } }
        : e,
    ),
  });
}

export function discardPendingEdit(set: Set, get: Get, id: string): void {
  const edits = get().pendingEdits as PendingEdit[];
  set({ pendingEdits: edits.filter((e) => e.id !== id), pendingEditsError: null });
}

export async function commitPendingEdits(
  set: Set,
  get: Get,
  deps: PendingEditsDeps,
  opts?: { confirmed?: boolean },
): Promise<void> {
  const state = get();
  const edits = state.pendingEdits as PendingEdit[];
  if (edits.length === 0) return;
  if (state.activeConfig?.readOnly) {
    throw new Error('read-only connection — discard the pending changes');
  }
  // U01: every edit must still target the live connection generation.
  const liveGen = state.connectionGen as number;
  const mismatched = edits.filter((e) => e.connectionGen !== liveGen);
  if (mismatched.length > 0 || liveGen <= 0) {
    throw new Error(
      'pending edits belong to a previous connection — discard them before committing',
    );
  }
  const batch = buildEditBatch(edits);
  // Prod-tagged connection: every grid write needs an explicit confirm.
  const connId = state.activeConfig?.id as string | undefined;
  const tag = connId ? state.settings?.connectionTags?.[connId] : undefined;
  if (tag === 'prod' && !opts?.confirmed) {
    if (state.prodGate == null) {
      set({
        prodGate: {
          sql: batch.updates.map((u) => `${u.sql};`).join('\n'),
          tabId: edits[0]?.tabId ?? '',
          connectionGen: liveGen,
          kind: 'commitEdits',
          summary: summarizeEdits(edits),
        },
      });
    }
    return;
  }
  set({ pendingEditsBusy: true, pendingEditsError: null });
  try {
    // U05: one worker request owns BEGIN/statements/COMMIT (or SAVEPOINT
    // when a user transaction is already open). Never a sequence of
    // unrelated IPC calls that can commit foreign work.
    let res: { state: unknown };
    try {
      res = await ipc.query.commitEditBatch({ connectionGen: liveGen, updates: batch.updates });
    } catch (err) {
      const idx = failedStatementIndex(err);
      const message = cleanIpcError(err instanceof Error ? err.message : String(err));
      set({
        pendingEditsError: {
          message,
          editIds: idx !== null ? (batch.editIds[idx] ?? []) : [],
        } satisfies PendingEditsError,
      });
      throw new Error(message);
    }
    // Only drop what was committed — edits queued while the batch ran stay.
    const committed = new Set(edits.map((e) => e.id));
    set({
      pendingEdits: (get().pendingEdits as PendingEdit[]).filter((e) => !committed.has(e.id)),
      txnState: res.state,
    });
    // Refresh every still-open tab that had pending edits. Edits whose
    // origin tab was closed are preserved through commit (U01) but have
    // nothing to refresh.
    const tabIds = new Set(edits.map((e) => e.tabId));
    const rowCountChanged = new Set(
      edits.filter((e) => editKind(e) !== 'update').map((e) => e.tabId),
    );
    for (const id of tabIds) {
      const tab = get().tabs.find((t: QueryTab) => t.id === id) as QueryTab | undefined;
      if (tab && tab.kind === 'table') {
        void deps.runTableDataQuery(set, get, id);
        if (rowCountChanged.has(id)) void deps.runTableCountQuery?.(set, get, id);
      }
    }
  } finally {
    set({ pendingEditsBusy: false });
  }
}

export async function revertPendingEdits(
  set: Set,
  _get: Get,
  _deps: PendingEditsDeps,
): Promise<void> {
  // Edits are an overlay over untouched server rows — dropping the queue
  // is the whole revert.
  set({ pendingEdits: [], pendingEditsError: null });
}
