/**
 * Pending-edits ownership (U39 / advisor simplification #1).
 *
 * Every grid write — cell update, row insert / duplicate, row delete — is
 * queued here as a `PendingEdit` and nothing touches the database until
 * the user commits the tray (toolbar Commit or ⌘S). The whole tray then
 * goes to the worker as one `commitEditBatch` (U05) with connectionGen
 * checks (U01) and the prod-tag confirmation.
 *
 * Edits are kept **per tab** (`pendingEditsByTab`, keyed by tab id): a tab's
 * edits are only ever shown, committed or discarded with that tab, ⌘S in
 * another tab can never commit them, and closing the tab drops (or first
 * asks about) them.
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
import { runBeforeCommitHook } from '@/lib/crash-recovery';
import {
  type EditConflict,
  type TheirsLookup,
  type WorkerConflict,
  buildConflicts,
  conflictSummary,
  keepMine,
  takeTheirs,
} from '@/lib/edit-conflicts';
import { cleanIpcError } from '@/lib/errors';
import { ipc } from '@/lib/ipc';
import {
  buildDeleteSql,
  buildInsertSql,
  buildRowLookupSql,
  buildUpdateSql,
} from '@/lib/table-query';
import type { GuardValue } from '@shared/edit-guard';
import type { ColumnMeta, SchemaInfo } from '@shared/protocol';
import { POSTGRES_DIALECT, type SqlDialect, dialectFor, engineCaps } from '@shared/sql-dialect';
import { effectiveSafeMode } from './safe-mode';
import { evaluateGate } from './session-prod-gate';
import type { PendingEdit, QueryTab } from './session-types';

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
  /** Tab whose commit failed; absent = applies to any tab. */
  tabId?: string;
}

/** Staged grid edits, keyed by the id of the tab they were made in. */
export type PendingEditsByTab = Record<string, PendingEdit[]>;

const NO_EDITS: PendingEdit[] = [];

/** A tab's staged edits (a stable empty array when it has none). */
export function editsOf(
  byTab: PendingEditsByTab | undefined,
  tabId: string | null | undefined,
): PendingEdit[] {
  return (tabId ? byTab?.[tabId] : undefined) ?? NO_EDITS;
}

/** Every staged edit of every tab (connection switches, reconnect guard). */
export function allPendingEdits(byTab: PendingEditsByTab | undefined): PendingEdit[] {
  return Object.values(byTab ?? {}).flat();
}

export function pendingEditCount(byTab: PendingEditsByTab | undefined): number {
  let n = 0;
  for (const list of Object.values(byTab ?? {})) n += list.length;
  return n;
}

/** Ids of tabs that have staged edits. */
export function tabsWithEdits(byTab: PendingEditsByTab | undefined): ReadonlySet<string> {
  return new Set(
    Object.entries(byTab ?? {})
      .filter(([, list]) => list.length > 0)
      .map(([id]) => id),
  );
}

/** Replace one tab's edits (dropping the key when the list is empty). */
export function withTabEdits(
  byTab: PendingEditsByTab | undefined,
  tabId: string,
  edits: PendingEdit[],
): PendingEditsByTab {
  const next = { ...(byTab ?? {}) };
  if (edits.length === 0) delete next[tabId];
  else next[tabId] = edits;
  return next;
}

/** Drop the edits of the given tabs (tab closed). */
export function withoutTabEdits(
  byTab: PendingEditsByTab | undefined,
  tabIds: Iterable<string>,
): PendingEditsByTab {
  const next = { ...(byTab ?? {}) };
  for (const id of tabIds) delete next[id];
  return next;
}

/** Re-stamp every staged edit with the live connection generation (same connection recovered). */
export function restampEdits(
  byTab: PendingEditsByTab | undefined,
  connectionGen: number,
): PendingEditsByTab {
  const out: PendingEditsByTab = {};
  for (const [id, list] of Object.entries(byTab ?? {})) {
    out[id] = list.map((e) => ({ ...e, connectionGen }));
  }
  return out;
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
  const declared = schema.columns
    .filter((c) => c.schema === schemaName && c.table === tableName && c.isPrimaryKey)
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((c) => c.name);
  if (declared.length > 0) return declared;
  // SQLite rowid table with no declared key: rows are addressed by `rowid`.
  const implicit = schema.tables.find(
    (t) => t.schema === schemaName && t.name === tableName,
  )?.implicitRowid;
  return implicit ? [implicit] : [];
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
  /**
   * `label` ('update "public"."users"') names the statement in worker errors;
   * `kind` lets the worker tell a changed row (UPDATE / DELETE matched nothing)
   * from an INSERT that hit an existing key.
   */
  updates: Array<{
    sql: string;
    params: unknown[];
    label: string;
    kind: 'update' | 'delete' | 'insert';
  }>;
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
export function buildEditBatch(
  edits: readonly PendingEdit[],
  dialect: SqlDialect = POSTGRES_DIALECT,
  opts: { serverVersion?: string | null } = {},
): EditBatch {
  // Before Postgres 12 floats print rounded, so their text never matches the stored value.
  const oldPg =
    dialect.engine === 'postgres' &&
    Number(/(\d+)\./.exec(opts.serverVersion ?? '')?.[1] ?? 99) < 12;
  const unsafeFloat = (type: string | undefined) =>
    oldPg && /^_?(float4|float8|real|double precision)(\[\])?$/i.test(type ?? '');
  const updates: Array<{ sql: string; params: unknown[]; kind: 'update' | 'delete' | 'insert' }> =
    [];
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
      guards: e.unguarded
        ? []
        : (e.originalRow ?? [])
            .filter((c) => !(c.column in e.pkValues))
            .map((c) => ({
              column: c.column,
              value: c.value,
              type: c.type,
              noEquality: c.noEquality || unsafeFloat(c.type),
            })),
      dialect,
    });
    updates.push({ sql, params, kind: 'delete' });
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
    // The values the user saw in the columns they changed must still be there.
    const guards: GuardValue[] = list
      .filter((e) => !e.unguarded && !(e.column in first.pkValues))
      .map((e) => ({
        column: e.column,
        value: e.oldValue === null || e.oldValue === undefined ? null : String(e.oldValue),
        type: e.oldType,
        noEquality: e.oldNoEquality || unsafeFloat(e.oldType),
      }));
    const { sql, params } = buildUpdateSql({
      schema: first.schema,
      table: first.table,
      set,
      pkValues: first.pkValues,
      guards,
      dialect,
    });
    updates.push({ sql, params, kind: 'update' });
    editIds.push(list.map((e) => e.id));
  }

  for (const e of edits) {
    if (editKind(e) !== 'insert') continue;
    const values = e.values ?? {};
    const cols = Object.keys(values);
    if (cols.length === 0) {
      updates.push({
        sql: dialect.insertDefaults(dialect.qualify(e.schema, e.table)),
        params: [],
        kind: 'insert',
      });
    } else {
      const { sql } = buildInsertSql({
        schema: e.schema,
        table: e.table,
        values: Object.fromEntries(cols.map((c) => [c, values[c] ?? null])),
        dialect,
      });
      updates.push({ sql, params: cols.map((c) => values[c] ?? null), kind: 'insert' });
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
  if (!engineCaps(state.activeConfig?.engine).rowEdits) {
    throw new Error('rows cannot be edited for this engine — write SQL in the editor instead');
  }
  if (effectiveSafeMode(state.settings, state.activeConfig?.id) === 'read-only') {
    throw new Error('safe mode is read-only for this connection — editing rows is disabled');
  }
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

type CellEditOutcome = 'queued' | 'noop' | 'deleted' | 'missing';

/**
 * Apply one cell update to a tab's edit list (pure w.r.t. the store):
 * replaces the cell's earlier edit, drops it when it's a no-op.
 */
function applyCellEdit(
  edits: PendingEdit[],
  target: TableTarget,
  connectionGen: number,
  rowIndex: number,
  columnIndex: number,
  newValue: string | null,
): { edits: PendingEdit[]; outcome: CellEditOutcome } {
  const col = target.columns[columnIndex];
  const row = target.rows[rowIndex];
  if (!col || !row) return { edits, outcome: 'missing' };
  const pkValues = requirePk(target, row, 'edit');
  const rowKey = rowKeyOf(pkValues);
  if (isRowDeleted(edits, target.tab.id, rowKey)) return { edits, outcome: 'deleted' };
  const sameCell = (e: PendingEdit) =>
    e.tabId === target.tab.id &&
    editKind(e) === 'update' &&
    e.column === col.name &&
    (e.rowKey ?? rowKeyOf(e.pkValues)) === rowKey;
  const rest = edits.filter((e) => !sameCell(e));
  const existing = edits.find(sameCell);
  // The original is what the user first edited against. A re-edit after the grid
  // reloaded must NOT take the reloaded server value as the new guard: that would
  // hide a change made by someone else in between.
  const oldValue = existing ? existing.oldValue : row[columnIndex];
  // Typing the original value back (or clicking in and out) un-queues.
  if (isNoopEdit(oldValue, newValue, col.dataTypeName)) {
    return { edits: rest.length !== edits.length ? rest : edits, outcome: 'noop' };
  }
  const edit: PendingEdit = {
    id: existing?.id ?? freshEditId(),
    tabId: target.tab.id,
    schema: target.schema,
    table: target.table,
    kind: 'update',
    pkValues,
    rowKey,
    column: col.name,
    oldValue: existing ? existing.oldValue : cellToText(oldValue, col.dataTypeName),
    oldType: existing?.oldType ?? col.dataTypeName,
    ...((existing ? existing.oldNoEquality : col.noEquality) ? { oldNoEquality: true } : {}),
    ...(existing?.unguarded ? { unguarded: true } : {}),
    newValue,
    rowIndex,
    columnIndex,
    connectionGen,
  };
  return {
    edits: existing ? edits.map((e) => (e === existing ? edit : e)) : [...edits, edit],
    outcome: 'queued',
  };
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
  const state = get();
  const edits = editsOf(state.pendingEditsByTab, target.tab.id);
  const res = applyCellEdit(edits, target, state.connectionGen, rowIndex, columnIndex, newValue);
  if (res.outcome === 'deleted') {
    throw new Error('this row is marked for deletion — restore it before editing');
  }
  if (res.outcome === 'noop') {
    if (res.edits !== edits) {
      set({
        pendingEditsByTab: withTabEdits(state.pendingEditsByTab, target.tab.id, res.edits),
        pendingEditsError: null,
      });
    }
    return;
  }
  if (res.outcome === 'queued') {
    set({ pendingEditsByTab: withTabEdits(state.pendingEditsByTab, target.tab.id, res.edits) });
  }
}

export interface CellEditInput {
  /** Index into the tab's result rows (not the display row). */
  rowIndex: number;
  columnIndex: number;
  value: string | null;
}

export interface BulkEditResult {
  /** Cells that now carry a pending change. */
  queued: number;
  /** Cells whose new value equals the stored one (nothing staged). */
  unchanged: number;
  /** Cells on rows marked for deletion or no longer in the result. */
  skipped: number;
}

/**
 * Bulk form of {@link queueCellEdit} (set value, fill down, paste, find &
 * replace): validates edit mode / read-only / safe mode / primary key once,
 * stages every cell in ONE store update, and reports what happened instead
 * of throwing on a deleted row.
 */
export function queueCellEdits(
  set: Set,
  get: Get,
  inputs: readonly CellEditInput[],
): BulkEditResult {
  const result: BulkEditResult = { queued: 0, unchanged: 0, skipped: 0 };
  if (inputs.length === 0) return result;
  const target = requireTableTarget(get);
  if (!target) return result;
  const state = get();
  const original = editsOf(state.pendingEditsByTab, target.tab.id);
  let edits = original;
  for (const input of inputs) {
    const res = applyCellEdit(
      edits,
      target,
      state.connectionGen,
      input.rowIndex,
      input.columnIndex,
      input.value,
    );
    edits = res.edits;
    if (res.outcome === 'queued') result.queued++;
    else if (res.outcome === 'noop') result.unchanged++;
    else result.skipped++;
  }
  if (edits !== original) {
    set({
      pendingEditsByTab: withTabEdits(state.pendingEditsByTab, target.tab.id, edits),
      pendingEditsError: null,
    });
  }
  return result;
}

/** Queue several INSERTs (pasted rows) in one store update. */
export function queueInserts(
  set: Set,
  get: Get,
  rows: ReadonlyArray<Record<string, string | null>>,
): number {
  if (rows.length === 0) return 0;
  const target = requireTableTarget(get);
  if (!target) return 0;
  const state = get();
  const added: PendingEdit[] = rows.map((values) => ({
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
  }));
  set({
    pendingEditsByTab: withTabEdits(state.pendingEditsByTab, target.tab.id, [
      ...editsOf(state.pendingEditsByTab, target.tab.id),
      ...added,
    ]),
    pendingEditsError: null,
  });
  return added.length;
}

/** Edit several values of queued INSERTs in one store update. */
export function updatePendingInserts(
  set: Set,
  get: Get,
  changes: ReadonlyArray<{ id: string; column: string; value: string | null }>,
): void {
  if (changes.length === 0) return;
  const byId = new Map<string, Array<{ column: string; value: string | null }>>();
  for (const c of changes) {
    const list = byId.get(c.id);
    if (list) list.push(c);
    else byId.set(c.id, [c]);
  }
  const byTab = get().pendingEditsByTab as PendingEditsByTab;
  const next: PendingEditsByTab = {};
  for (const [tabId, list] of Object.entries(byTab)) {
    next[tabId] = list.map((e) => {
      const patch = byId.get(e.id);
      if (!patch || editKind(e) !== 'insert') return e;
      const values = { ...(e.values ?? {}) };
      for (const p of patch) values[p.column] = p.value;
      return { ...e, values };
    });
  }
  set({ pendingEditsByTab: next });
}

/** Toggle rows' pending deletion (queued; committed with the tray). */
export function queueRowDeletes(set: Set, get: Get, rowIndices: readonly number[]): void {
  const target = requireTableTarget(get);
  if (!target) return;
  const state = get();
  let edits = editsOf(state.pendingEditsByTab, target.tab.id).slice();
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
        originalRow: target.columns.map((c, i) => ({
          column: c.name,
          value: cellToText(row[i], c.dataTypeName),
          type: c.dataTypeName,
          ...(c.noEquality ? { noEquality: true } : {}),
        })),
        newValue: null,
        rowIndex: target.rows.indexOf(row),
        columnIndex: -1,
        connectionGen: state.connectionGen,
      });
    }
  }
  set({
    pendingEditsByTab: withTabEdits(state.pendingEditsByTab, target.tab.id, edits),
    pendingEditsError: null,
  });
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
  set({
    pendingEditsByTab: withTabEdits(state.pendingEditsByTab, target.tab.id, [
      ...editsOf(state.pendingEditsByTab, target.tab.id),
      edit,
    ]),
    pendingEditsError: null,
  });
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
  const byTab = get().pendingEditsByTab as PendingEditsByTab;
  const next: PendingEditsByTab = {};
  for (const [tabId, list] of Object.entries(byTab)) {
    next[tabId] = list.map((e) =>
      e.id === id && editKind(e) === 'insert'
        ? { ...e, values: { ...(e.values ?? {}), [column]: value } }
        : e,
    );
  }
  set({ pendingEditsByTab: next });
}

export function discardPendingEdit(set: Set, get: Get, id: string): void {
  const byTab = get().pendingEditsByTab as PendingEditsByTab;
  let next = byTab;
  for (const [tabId, list] of Object.entries(byTab)) {
    if (list.some((e) => e.id === id)) {
      next = withTabEdits(
        next,
        tabId,
        list.filter((e) => e.id !== id),
      );
    }
  }
  set({ pendingEditsByTab: next, pendingEditsError: null });
}

export async function commitPendingEdits(
  set: Set,
  get: Get,
  deps: PendingEditsDeps,
  opts?: { confirmed?: boolean; tabId?: string },
): Promise<void> {
  const state = get();
  // Commit only ever commits ONE tab's edits: the one asked for, else the
  // active tab. Edits staged in other tabs are never swept in (R-01/R-02).
  const tabId = (opts?.tabId ?? state.activeTabId) as string;
  const edits = editsOf(state.pendingEditsByTab, tabId);
  if (edits.length === 0) return;
  // Refusals are written to `pendingEditsError` BEFORE throwing, so every
  // caller that swallows the rejection still has a visible message (R-04).
  const fail = (message: string): never => {
    set({ pendingEditsError: { message, editIds: [], tabId } satisfies PendingEditsError });
    throw new Error(message);
  };
  if (state.activeConfig?.readOnly) {
    fail('read-only connection — discard the pending changes');
  }
  // U01: every edit must still target the live connection generation.
  const liveGen = state.connectionGen as number;
  const mismatched = edits.filter((e) => e.connectionGen !== liveGen);
  if (mismatched.length > 0 || liveGen <= 0) {
    fail('pending edits belong to a previous connection — discard them before committing');
  }
  const batch = buildEditBatch(edits, dialectFor(state.activeConfig?.engine), {
    serverVersion: state.serverVersion,
  });
  // Prod tag / safe mode: every grid write needs an explicit confirm (or is
  // refused outright on a read-only safe mode).
  const decision = evaluateGate(get, '', true);
  if (decision.kind === 'refuse') {
    // R-03: an object, not a string — the grid reads `.message.replace(...)`.
    set({ pendingEditsError: { message: decision.message, editIds: [], tabId } });
    return;
  }
  if (decision.kind === 'confirm' && !opts?.confirmed) {
    if (state.prodGate == null) {
      set({
        prodGate: {
          sql: batch.updates.map((u) => `${u.sql};`).join('\n'),
          tabId,
          connectionGen: liveGen,
          kind: 'commitEdits',
          reason: decision.reason,
          summary: summarizeEdits(edits),
        },
      });
    }
    return;
  }
  // B2: edits restored after a crash that hit mid-commit may already be saved. An INSERT
  // would simply be written again, so check first; nothing is sent while one is in doubt.
  const doubtful = await preflightMaybeCommitted(get, edits, batch);
  if (doubtful.length > 0) {
    await reviewConflicts(set, get, tabId, edits, batch, doubtful);
    return;
  }
  set({ pendingEditsBusy: true, pendingEditsError: null });
  try {
    // B2: the crash snapshot must say "these were being committed" BEFORE the request
    // leaves, so a crash in the middle restores them flagged instead of as plain edits.
    set({ commitInFlightIds: edits.map((e) => e.id) });
    await runBeforeCommitHook();
    // U05: one worker request owns BEGIN/statements/COMMIT (or SAVEPOINT
    // when a user transaction is already open). Never a sequence of
    // unrelated IPC calls that can commit foreign work.
    let res: { state: unknown; conflicts?: WorkerConflict[] };
    try {
      res = await ipc.query.commitEditBatch({ connectionGen: liveGen, updates: batch.updates });
    } catch (err) {
      const idx = failedStatementIndex(err);
      const message = cleanIpcError(err instanceof Error ? err.message : String(err));
      set({
        pendingEditsError: {
          message,
          editIds: idx !== null ? (batch.editIds[idx] ?? []) : [],
          tabId,
        } satisfies PendingEditsError,
      });
      throw new Error(message);
    }
    // B1: a row changed under the user. The worker rolled the whole batch back;
    // every staged edit stays, and the conflicting rows go to review.
    if (res.conflicts && res.conflicts.length > 0) {
      set({ txnState: res.state });
      await reviewConflicts(set, get, tabId, edits, batch, res.conflicts);
      return;
    }
    // Only drop what was committed — edits queued while the batch ran stay.
    const committed = new Set(edits.map((e) => e.id));
    set({
      pendingEditsByTab: withTabEdits(
        get().pendingEditsByTab,
        tabId,
        editsOf(get().pendingEditsByTab, tabId).filter((e) => !committed.has(e.id)),
      ),
      txnState: res.state,
      editConflicts: null,
      editConflictsOpen: false,
    });
    // Refresh the committed tab (it may have been closed meanwhile).
    const tab = get().tabs.find((t: QueryTab) => t.id === tabId) as QueryTab | undefined;
    if (tab && tab.kind === 'table') {
      void deps.runTableDataQuery(set, get, tabId);
      if (edits.some((e) => editKind(e) !== 'update')) {
        void deps.runTableCountQuery?.(set, get, tabId);
      }
    }
  } finally {
    set({ pendingEditsBusy: false, commitInFlightIds: [] });
  }
}

/**
 * Restored INSERTs that were in flight when Plasma stopped (`maybeCommitted`): the
 * row may be in the table already. Where the key is known the row is looked up; an
 * existing one, or a key the server generates (so nothing can be checked), is held
 * back as a conflict for the user to decide. Updates and deletes need no check:
 * their guarded WHERE already refuses to apply twice.
 */
async function preflightMaybeCommitted(
  get: Get,
  edits: readonly PendingEdit[],
  batch: EditBatch,
): Promise<WorkerConflict[]> {
  const out: WorkerConflict[] = [];
  const state = get();
  const dialect = dialectFor(state.activeConfig?.engine);
  for (let i = 0; i < batch.editIds.length; i++) {
    const e = edits.find((x) => x.id === batch.editIds[i]?.[0]);
    if (!e || !e.maybeCommitted || editKind(e) !== 'insert') continue;
    const pkNames = tablePkNames(state.schema, e.schema, e.table);
    const values = e.values ?? {};
    const pk: Record<string, string | null> = {};
    for (const name of pkNames) pk[name] = values[name] ?? null;
    if (pkNames.length === 0 || Object.values(pk).some((v) => v === null)) {
      out.push({ index: i, reason: 'maybe-saved' });
      continue;
    }
    try {
      const { sql, params } = buildRowLookupSql({
        schema: e.schema,
        table: e.table,
        pkValues: pk,
        currentRead: state.txnState === 'active',
        dialect,
      });
      const res = await ipc.query.run(sql, params, { internal: true });
      if (res.rows.length > 0) out.push({ index: i, reason: 'duplicate' });
    } catch {
      out.push({ index: i, reason: 'maybe-saved' });
    }
  }
  return out;
}

// ─── Concurrent-edit conflicts (B1) ──────────────────────────────────

/** Rows read back for review; a commit with more conflicts than this lists the rest as unreadable. */
const MAX_CONFLICT_LOOKUPS = 50;

/**
 * The commit was rolled back because rows changed. Read each row's current
 * state ("theirs") and hand the list to the review dialog. Staged edits are
 * untouched; the grid tints them through `pendingEditsError.editIds`.
 */
async function reviewConflicts(
  set: Set,
  get: Get,
  tabId: string,
  edits: readonly PendingEdit[],
  batch: EditBatch,
  conflicts: readonly WorkerConflict[],
): Promise<void> {
  const dialect = dialectFor(get().activeConfig?.engine);
  const byId = new Map(edits.map((e) => [e.id, e] as const));
  const theirs = new Map<number, TheirsLookup>();
  let looked = 0;
  for (const c of conflicts) {
    if (c.reason !== 'no-match') continue;
    const first = byId.get(batch.editIds[c.index]?.[0] ?? '');
    if (!first || looked++ >= MAX_CONFLICT_LOOKUPS) continue;
    try {
      const { sql, params } = buildRowLookupSql({
        schema: first.schema,
        table: first.table,
        pkValues: first.pkValues,
        currentRead: get().txnState === 'active',
        dialect,
      });
      const res = await ipc.query.run(sql, params, { internal: true });
      const row = res.rows[0] as unknown[] | undefined;
      theirs.set(
        c.index,
        row
          ? {
              found: true,
              row: res.columns.map((col, i) => ({
                column: col.name,
                value: cellToText(row[i], col.dataTypeName),
                type: col.dataTypeName,
                ...(col.noEquality ? { noEquality: true } : {}),
              })),
            }
          : { found: false },
      );
    } catch (err) {
      theirs.set(c.index, {
        error: cleanIpcError(err instanceof Error ? err.message : String(err)),
      });
    }
  }
  const items = buildConflicts({ edits, batch, conflicts, theirs });
  set({
    editConflicts: { tabId, items },
    editConflictsOpen: true,
    pendingEditsError: {
      message: conflictSummary(items),
      editIds: items.flatMap((i) => i.editIds),
      tabId,
    } satisfies PendingEditsError,
  });
}

/**
 * Resolve one conflicting row. `mine` re-stages the change against the
 * server's current values (the next commit compares against those); `theirs`
 * drops the change. Either way the table reloads so the grid shows the server.
 */
export function resolveEditConflict(
  set: Set,
  get: Get,
  deps: PendingEditsDeps,
  conflictId: string,
  choice: 'mine' | 'theirs',
): void {
  const state = get();
  const review = state.editConflicts as { tabId: string; items: EditConflict[] } | null;
  const item = review?.items.find((i) => i.id === conflictId);
  if (!review || !item) return;
  const current = editsOf(state.pendingEditsByTab, review.tabId);
  const next = choice === 'mine' ? keepMine(current, item) : takeTheirs(current, item);
  if (choice === 'mine' && next.every((e, i) => e === current[i])) return; // not re-stageable
  const remaining = review.items.filter((i) => i.id !== conflictId);
  set({
    pendingEditsByTab: withTabEdits(state.pendingEditsByTab, review.tabId, next),
    editConflicts: remaining.length > 0 ? { tabId: review.tabId, items: remaining } : null,
    editConflictsOpen: remaining.length > 0,
    pendingEditsError:
      remaining.length > 0
        ? {
            message: conflictSummary(remaining),
            editIds: remaining.flatMap((i) => i.editIds),
            tabId: review.tabId,
          }
        : null,
  });
  const tab = get().tabs.find((t: QueryTab) => t.id === review.tabId) as QueryTab | undefined;
  if (tab && tab.kind === 'table') void deps.runTableDataQuery(set, get, review.tabId);
}

/** Close the review without resolving anything: edits stay staged and tinted. */
export function closeEditConflicts(set: Set): void {
  set({ editConflictsOpen: false });
}

export async function revertPendingEdits(
  set: Set,
  get: Get,
  _deps: PendingEditsDeps,
  opts?: { tabId?: string },
): Promise<void> {
  // Edits are an overlay over untouched server rows — dropping the tab's
  // queue is the whole revert.
  const tabId = (opts?.tabId ?? get().activeTabId) as string;
  set({
    pendingEditsByTab: withoutTabEdits(get().pendingEditsByTab, [tabId]),
    pendingEditsError: null,
    ...(get().editConflicts?.tabId === tabId
      ? { editConflicts: null, editConflictsOpen: false }
      : {}),
  });
}

/** Drop every tab's staged edits (connection switch / disconnect gate). */
export function discardAllPendingEdits(set: Set): void {
  set({
    pendingEditsByTab: {},
    pendingEditsError: null,
    editConflicts: null,
    editConflictsOpen: false,
  });
}
