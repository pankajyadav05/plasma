import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { commandDetail, commandTitle } from '@/lib/command-summary';
import { cleanIpcError } from '@/lib/errors';
import { formatDuration } from '@/lib/format';
import { readableTypeName } from '@/lib/pg-types';
import { type PendingEdit, useActiveTab, useSession } from '@/stores/session';
import {
  type RowOverlay,
  overlayRows,
  pendingInsertsFor,
  tablePkNames,
} from '@/stores/session-pending-edits';
import { useWorkbench } from '@/stores/workbench';
import type { ColumnMeta } from '@shared/protocol';
import {
  AlertCircle,
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  Copy,
  CopyPlus,
  Eraser,
  Filter as FilterIcon,
  Loader2,
  Pencil,
  Search,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type CellDetail, CellDetailDialog } from './CellDetailDialog';
import { ColumnHeaderMenu } from './ColumnHeaderMenu';
import { GridContextMenu, type GridMenuEntry } from './GridContextMenu';
import { type RowDetail, RowDetailSheet } from './RowDetailSheet';
import { TableDefinitionView } from './TableDefinitionView';
import { TableStructureView } from './TableStructureView';
import { cellToText } from './cell-edit';
import { COPY_FORMATS, type CopyFormat, formatRows, parseClipboardBlock } from './clipboard-format';
import {
  type IndexedRow,
  slicePageSorted,
  slicePageUnsorted,
  sortRowsWithIndex,
} from './display-rows';
import { nextCell, prevCell } from './grid-nav';
import { isErrorTabActive } from './result-view';
import { ROW_HEIGHT_PX, computeRowWindow } from './windowed-rows';

// Stable empty Set used as a fallback when the active tab is null. Using
// a module-level singleton keeps the useEffect dependency reference-stable
// across renders so we don't trip the sticky-column re-measure loop.
const EMPTY_STICKY_SET: ReadonlySet<string> = new Set();
const EMPTY_EDITS: PendingEdit[] = [];

/** Grid header height (TablePlus: 26px header over 24px rows). */
const HEADER_HEIGHT_PX = 26;
/** Row-number gutter width. */
const GUTTER_WIDTH_PX = 44;
/** Longest text rendered inside a cell (the full value is in the detail views). */
const MAX_CELL_CHARS = 1000;
/** Selected-row tint: the theme accent at 18% (Plasma coral by default). */
const SELECTED_ROW_BG = 'bg-[color-mix(in_srgb,var(--wb-accent)_18%,transparent)]';
/** Pending-change tints (B3 / VF13). */
const EDITED_CELL_BG = 'bg-[color-mix(in_srgb,var(--status-staging)_30%,transparent)]';
const INSERTED_ROW_BG = 'bg-[color-mix(in_srgb,var(--status-local)_20%,transparent)]';
const DELETED_ROW_BG = 'bg-[color-mix(in_srgb,var(--destructive)_14%,transparent)]';
const FAILED_OUTLINE = 'outline outline-2 -outline-offset-2 outline-[var(--destructive)]';

/**
 * Scroll-container background: the zebra stripes continue below the last
 * row (aligned to the 24px rows under the 26px header) and the gutter
 * column stays the plain content colour, like TablePlus.
 */
function stripedBackground(zebra: boolean): React.CSSProperties {
  return zebra ? STRIPED_BACKGROUND : PLAIN_BACKGROUND;
}

const STRIPED_BACKGROUND: React.CSSProperties = {
  backgroundColor: 'var(--wb-content)',
  backgroundImage: [
    'linear-gradient(var(--wb-content), var(--wb-content))',
    `repeating-linear-gradient(to bottom, var(--grid-row-a) 0 ${ROW_HEIGHT_PX}px, var(--grid-row-b) ${ROW_HEIGHT_PX}px ${ROW_HEIGHT_PX * 2}px)`,
  ].join(', '),
  backgroundSize: `${GUTTER_WIDTH_PX}px 100%, 100% auto`,
  backgroundRepeat: 'no-repeat, repeat',
  backgroundPosition: `0 0, 0 ${HEADER_HEIGHT_PX}px`,
  backgroundAttachment: 'scroll, local',
};

/** `gridAlternatingRows` off: every row (and the fill below) is stripe B. */
const PLAIN_BACKGROUND: React.CSSProperties = {
  backgroundColor: 'var(--wb-content)',
  backgroundImage: [
    'linear-gradient(var(--wb-content), var(--wb-content))',
    `repeating-linear-gradient(to bottom, var(--grid-row-b) 0 ${ROW_HEIGHT_PX}px, var(--grid-row-b) ${ROW_HEIGHT_PX}px ${ROW_HEIGHT_PX * 2}px)`,
  ].join(', '),
  backgroundSize: `${GUTTER_WIDTH_PX}px 100%, 100% auto`,
  backgroundRepeat: 'no-repeat, repeat',
  backgroundPosition: `0 0, 0 ${HEADER_HEIGHT_PX}px`,
  backgroundAttachment: 'scroll, local',
};

type RowStatus = 'clean' | 'edited' | 'deleted' | 'inserted';

/** One rendered grid row: server values with pending edits applied. */
interface GridRow {
  key: string;
  row: unknown[];
  /** Index into `queryResult.rows`; -1 for a pending insert. */
  originalIndex: number;
  status: RowStatus;
  editedCols: ReadonlySet<number>;
  editIdByCol: ReadonlyMap<number, string>;
  rowKey: string | null;
  insert?: PendingEdit;
}

type Cell = { row: number; col: number };

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl+';

/**
 * Paginated + sortable result grid (role="grid").
 *
 *  - Click a cell to select; Shift+click / drag / Shift+arrows extend a range
 *  - Arrows, Home/End, PageUp/PageDown move; Tab / Shift+Tab step cells
 *  - Enter opens row detail; Space opens the cell viewer
 *  - F2 / double-click / typing edits (edit mode); ⇧⌘⌫ sets NULL
 *  - ⌘C copies the range (TSV); ⌘V pastes a block; ⌘D duplicates a row;
 *    ⌘⌫ marks rows for deletion; ⌘S commits the pending changes
 *  - Right-click (or Shift+F10) opens the cell menu
 *
 * Keys are only handled while the grid itself has focus, so dialogs,
 * menus and other panes keep their own Tab / Enter / Space / arrows / ⌘C.
 * Rows are windowed (only the visible slice is mounted).
 */
export function ResultGrid() {
  const tab = useActiveTab();
  const zebraRows = useSession((s) => s.settings.gridAlternatingRows);
  const setSort = useSession((s) => s.setSort);
  const setSelectedCell = useSession((s) => s.setSelectedCell);
  const toggleRowSelected = useSession((s) => s.toggleRowSelected);
  const setSelectedRows = useSession((s) => s.setSelectedRows);
  const setColumnWidth = useSession((s) => s.setColumnWidth);
  const editMode = useSession((s) => s.editMode);
  const connectionReadOnly = useSession((s) => Boolean(s.activeConfig?.readOnly));
  const updateCell = useSession((s) => s.updateCell);
  const deleteRows = useSession((s) => s.deleteRows);
  const duplicateRow = useSession((s) => s.duplicateRow);
  const updatePendingInsert = useSession((s) => s.updatePendingInsert);
  const discardPendingEdit = useSession((s) => s.discardPendingEdit);
  const schema = useSession((s) => s.schema);
  const openForeignRow = useSession((s) => s.openForeignRow);
  const toggleColumnHidden = useSession((s) => s.toggleColumnHidden);
  const toggleStickyColumn = useSession((s) => s.toggleStickyColumn);
  const addFilter = useSession((s) => s.addFilter);
  const pendingEdits = useSession(
    (s) => (s.pendingEdits as PendingEdit[] | undefined) ?? EMPTY_EDITS,
  );
  const pendingEditsError = useSession((s) => s.pendingEditsError);

  // Header-menu sort actions. The existing setSort cycles asc → desc →
  // none; the menu wants explicit values, so we write directly through
  // the store. Table tabs trigger a server re-query; SQL tabs just
  // re-render (sorting happens client-side from the cached result).
  const setExplicitTableSort = (columnName: string, direction: 'asc' | 'desc' | null) => {
    if (!tab || tab.kind !== 'table') return;
    useSession.setState((s) => {
      const next = direction === null ? [] : [{ column: columnName, direction }];
      return {
        tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, tableSort: next, page: 0 } : t)),
      };
    });
    void useSession.getState().refreshTable();
  };

  const setExplicitSqlSort = (index: number, direction: 'asc' | 'desc' | null) => {
    if (!tab || tab.kind !== 'sql') return;
    useSession.setState((s) => {
      const sortColumn = direction === null ? null : { index, direction };
      return {
        tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, sortColumn, page: 0 } : t)),
      };
    });
  };

  // Inline cell edit state — local to the grid, only one cell at a time.
  // `value: null` is SQL NULL (A1) — distinct from the empty string.
  const [editingCell, setEditingCell] = useState<{
    row: number;
    col: number;
    value: string | null;
  } | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  // Cell detail viewer — opens on double-click (read-only contexts) or
  // Space on the selected cell. Shows the full, formatted value.
  const [cellDetail, setCellDetail] = useState<CellDetail | null>(null);

  // Row detail drawer — opens on Enter on the selected cell.
  const [rowDetail, setRowDetail] = useState<RowDetail | null>(null);

  // Range selection: `tab.selectedCell` is the anchor, this is the far corner.
  const [rangeEnd, setRangeEnd] = useState<Cell | null>(null);
  const dragging = useRef(false);

  // Right-click menu.
  const [menu, setMenu] = useState<{ x: number; y: number; cell: Cell } | null>(null);

  // In-grid search — Ctrl+F / ⌘F toggles the floating bar. Matches are
  // computed from displayRows (case-insensitive substring). Enter /
  // Shift+Enter cycles through matches and jumps the selected cell.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeMatchIdx, setActiveMatchIdx] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLTableElement>(null);

  // Footer's find button (TablePlus result footer) opens the in-grid search.
  useEffect(() => {
    const open = () => {
      setSearchOpen(true);
      requestAnimationFrame(() => searchInputRef.current?.focus());
    };
    window.addEventListener('plasma:grid-find', open);
    return () => window.removeEventListener('plasma:grid-find', open);
  }, []);

  const isTableTab = tab?.kind === 'table';
  const pkNames = useMemo(
    () => (isTableTab ? tablePkNames(schema, tab?.tableSchema, tab?.tableName) : []),
    [isTableTab, schema, tab?.tableSchema, tab?.tableName],
  );
  const writable = Boolean(
    isTableTab &&
      editMode &&
      !connectionReadOnly &&
      tab?.tableSchema &&
      tab?.tableName &&
      pkNames.length > 0,
  );

  // Compute display rows (U14 + U15).
  //
  // Table tabs: the server already returned the sorted + paginated
  // slice; pending edits are overlaid by primary key (so they survive
  // paging) and pending inserts are appended.
  //
  // SQL tabs: sorted order is memoized on (rows, sort) only so paging
  // does not re-sort. Unsorted pages slice first, then wrap only the
  // visible rows — never allocate an IndexedRow for every result row.
  const sortTypeName =
    tab?.kind === 'sql' && tab.sortColumn
      ? tab.queryResult?.columns[tab.sortColumn.index]?.dataTypeName
      : undefined;
  const sortedSqlRows = useMemo((): IndexedRow[] | null => {
    if (!tab?.queryResult || tab.kind !== 'sql' || !tab.sortColumn) return null;
    return sortRowsWithIndex(tab.queryResult.rows, tab.sortColumn, sortTypeName);
  }, [tab?.kind, tab?.queryResult, tab?.sortColumn, sortTypeName]);

  const tabId = tab?.id;
  const displayRows = useMemo((): GridRow[] => {
    const result = tab?.queryResult;
    if (!result || !tabId) return [];
    const clean = (e: IndexedRow): GridRow => ({
      key: `r-${e.originalIndex}`,
      row: e.row,
      originalIndex: e.originalIndex,
      status: 'clean',
      editedCols: EMPTY_COLS,
      editIdByCol: EMPTY_IDS,
      rowKey: null,
    });
    if (tab.kind !== 'table') {
      const base = sortedSqlRows
        ? slicePageSorted(sortedSqlRows, tab.page, tab.pageSize)
        : slicePageUnsorted(result.rows, tab.page, tab.pageSize);
      return base.map(clean);
    }
    const overlay: RowOverlay[] = overlayRows(
      tabId,
      result.columns,
      result.rows,
      pkNames,
      pendingEdits,
    );
    const rows: GridRow[] = overlay.map((o, i) => ({
      key: `r-${i}`,
      row: o.row,
      originalIndex: i,
      status: o.status,
      editedCols: o.editedCols,
      editIdByCol: o.editIdByCol,
      rowKey: o.rowKey,
    }));
    for (const ins of pendingInsertsFor(tabId, pendingEdits)) {
      const values = ins.values ?? {};
      rows.push({
        key: `ins-${ins.id}`,
        row: result.columns.map((c) => (c.name in values ? values[c.name] : undefined)),
        originalIndex: -1,
        status: 'inserted',
        editedCols: EMPTY_COLS,
        editIdByCol: EMPTY_IDS,
        rowKey: null,
        insert: ins,
      });
    }
    return rows;
  }, [
    tab?.kind,
    tab?.queryResult,
    tab?.page,
    tab?.pageSize,
    tabId,
    sortedSqlRows,
    pkNames,
    pendingEdits,
  ]);

  const columns = tab?.queryResult?.columns;

  /**
   * Postgres text of a displayed cell (null = NULL, undefined = DEFAULT on
   * a pending insert). Pending values are already Postgres text.
   */
  const cellText = useCallback(
    (entry: GridRow | undefined, col: number): string | null | undefined => {
      if (!entry) return null;
      const v = entry.row[col];
      if (entry.status === 'inserted') return v as string | null | undefined;
      if (entry.editedCols.has(col)) return v as string | null;
      return cellToText(v, columns?.[col]?.dataTypeName);
    },
    [columns],
  );

  // Publish the selected row for the right-sidebar Details pane. Only the
  // grid knows how the selected display row maps back to result data.
  const setInspectedRow = useWorkbench((s) => s.setInspectedRow);
  const queryResult = tab?.queryResult;
  const page = tab?.page ?? 0;
  const pageSize = tab?.pageSize ?? 0;
  const selRow = tab?.selectedCell?.row;
  const selCol = tab?.selectedCell?.col;
  useEffect(() => {
    const pagedRow = selRow === undefined ? undefined : displayRows[selRow];
    if (!tabId || !queryResult || !pagedRow || selRow === undefined || selCol === undefined) {
      setInspectedRow(null);
      return;
    }
    setInspectedRow({
      tabId,
      rowNumber: page * pageSize + selRow + 1,
      columnIndex: selCol,
      columns: queryResult.columns,
      row: pagedRow.row,
    });
  }, [tabId, queryResult, page, pageSize, selRow, selCol, displayRows, setInspectedRow]);

  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(400);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-bind when a new result mounts the scroller
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => setScrollTop(el.scrollTop);
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height;
      if (typeof h === 'number' && h > 0) setViewportHeight(h);
    });
    el.addEventListener('scroll', onScroll, { passive: true });
    ro.observe(el);
    setScrollTop(el.scrollTop);
    setViewportHeight(el.clientHeight || 400);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  }, [tab?.queryResult]);

  // A new result (page, re-run, tab switch) drops the range + open editor.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset keyed on result identity
  useEffect(() => {
    setRangeEnd(null);
    setEditingCell(null);
    setMenu(null);
  }, [tab?.id, tab?.queryResult]);

  const rowWindow = useMemo(
    () => computeRowWindow(displayRows.length, scrollTop, viewportHeight),
    [displayRows.length, scrollTop, viewportHeight],
  );
  const windowedRows = useMemo(
    () => displayRows.slice(rowWindow.start, rowWindow.end),
    [displayRows, rowWindow.start, rowWindow.end],
  );

  // Foreign-key lookup for the current table tab, keyed by column name.
  // Composite FKs (several columns to the same referenced table) navigate
  // with every column of the key (F7). SQL tabs can't map projections
  // back to source columns without a parser — skip entirely.
  const fkByColumn = useMemo(() => {
    type Fk = {
      refSchema: string;
      refTable: string;
      pairs: Array<{ column: string; refColumn: string }>;
    };
    const groups = new Map<string, Fk>();
    const m = new Map<string, { fk: Fk; refColumn: string }>();
    if (tab?.kind === 'table' && tab.tableSchema && tab.tableName && schema?.foreignKeys) {
      for (const fk of schema.foreignKeys) {
        if (fk.schema !== tab.tableSchema || fk.table !== tab.tableName) continue;
        const key = `${fk.refSchema}.${fk.refTable}`;
        let g = groups.get(key);
        if (!g) {
          g = { refSchema: fk.refSchema, refTable: fk.refTable, pairs: [] };
          groups.set(key, g);
        }
        g.pairs.push({ column: fk.column, refColumn: fk.refColumn });
        m.set(fk.column, { fk: g, refColumn: fk.refColumn });
      }
    }
    return m;
  }, [tab?.kind, tab?.tableSchema, tab?.tableName, schema?.foreignKeys]);

  /** Foreign keys in other tables that point at this table (reverse navigation). */
  const referencedBy = useMemo(() => {
    if (tab?.kind !== 'table' || !schema?.foreignKeys) return [];
    return schema.foreignKeys.filter(
      (fk) => fk.refSchema === tab.tableSchema && fk.refTable === tab.tableName,
    );
  }, [tab?.kind, tab?.tableSchema, tab?.tableName, schema?.foreignKeys]);

  // Compute search matches — visible-row / original-col indices. Keyed
  // off displayRows (already page-sliced) so matches always line up
  // with what the user sees.
  const searchMatches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [] as Array<Cell>;
    const out: Array<Cell> = [];
    displayRows.forEach((entry, visibleRow) => {
      entry.row.forEach((_cell, col) => {
        const str = cellText(entry, col);
        if (str?.toLowerCase().includes(q)) out.push({ row: visibleRow, col });
      });
    });
    return out;
  }, [searchQuery, displayRows, cellText]);

  const matchSet = useMemo(() => {
    const s = new Set<string>();
    for (const m of searchMatches) s.add(`${m.row}:${m.col}`);
    return s;
  }, [searchMatches]);

  // Reset the active match whenever the search query or result changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset trigger
  useEffect(() => {
    setActiveMatchIdx(0);
  }, [searchQuery, displayRows]);

  // Ctrl+F / ⌘F opens the find bar — only when focus isn't in another
  // text field or Monaco, so it doesn't fight their own find.
  useEffect(() => {
    if (!tab?.queryResult) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f' && !e.shiftKey && !e.altKey) {
        const active = document.activeElement as HTMLElement | null;
        const tag = active?.tagName?.toLowerCase();
        if (
          tag === 'textarea' ||
          active?.isContentEditable ||
          (tag === 'input' && active !== searchInputRef.current)
        ) {
          return;
        }
        if (active?.closest('[role="dialog"]')) return;
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 0);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [tab?.queryResult]);

  // ⌘S commits the pending-changes tray (B3). Skipped inside Monaco /
  // text fields / dialogs, and when nothing is pending.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 's')
        return;
      const state = useSession.getState();
      if (state.pendingEdits.length === 0 || state.pendingEditsBusy) return;
      const active = document.activeElement as HTMLElement | null;
      if (active?.closest('.monaco-editor, [role="dialog"]')) return;
      e.preventDefault();
      void state.commitPendingEdits().catch(() => undefined);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // Sticky columns — hooks live up here (before any early return) so
  // the hook order stays stable across renders.
  const stickySet = tab?.stickyColumns ?? EMPTY_STICKY_SET;
  const headerRefs = useRef<Array<HTMLTableCellElement | null>>([]);
  const [stickyLefts, setStickyLefts] = useState<Record<number, number>>({});
  const resultColumns = tab?.queryResult?.columns;

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when rows render
  useEffect(() => {
    if (!resultColumns || stickySet.size === 0) {
      setStickyLefts({});
      return;
    }
    const lefts: Record<number, number> = {};
    // Pinned columns sit to the right of the sticky row-number gutter.
    let cumulative = GUTTER_WIDTH_PX;
    resultColumns.forEach((col, i) => {
      if (stickySet.has(col.name)) {
        lefts[i] = cumulative;
        const th = headerRefs.current[i];
        if (th) cumulative += th.offsetWidth;
      }
    });
    setStickyLefts(lefts);
  }, [stickySet, resultColumns, displayRows.length]);

  // Visible columns in display order, and each original index's position.
  const hidden = tab?.hiddenColumns;
  const visibleColumns = useMemo(
    () =>
      (resultColumns ?? [])
        .map((col, i) => ({ col, originalIndex: i }))
        .filter(({ col }) => !hidden?.has(col.name)),
    [resultColumns, hidden],
  );
  const colPos = useMemo(() => {
    const m = new Map<number, number>();
    visibleColumns.forEach((c, pos) => m.set(c.originalIndex, pos));
    return m;
  }, [visibleColumns]);

  const anchor = tab?.selectedCell ?? null;
  const range = useMemo(() => {
    if (!anchor || !rangeEnd) return null;
    const a = colPos.get(anchor.col);
    const b = colPos.get(rangeEnd.col);
    if (a === undefined || b === undefined) return null;
    return {
      r0: Math.min(anchor.row, rangeEnd.row),
      r1: Math.max(anchor.row, rangeEnd.row),
      p0: Math.min(a, b),
      p1: Math.max(a, b),
    };
  }, [anchor, rangeEnd, colPos]);

  const inRange = (row: number, col: number) => {
    if (!range) return false;
    const p = colPos.get(col);
    return p !== undefined && row >= range.r0 && row <= range.r1 && p >= range.p0 && p <= range.p1;
  };

  // F2: keep the active cell in view after keyboard moves / find jumps.
  const focusCell = rangeEnd ?? anchor;
  const focusRow = focusCell?.row;
  const focusCol = focusCell?.col;
  useEffect(() => {
    const el = containerRef.current;
    if (!el || focusRow === undefined || focusCol === undefined) return;
    const top = HEADER_HEIGHT_PX + focusRow * ROW_HEIGHT_PX;
    if (top < el.scrollTop + HEADER_HEIGHT_PX) el.scrollTop = top - HEADER_HEIGHT_PX;
    else if (top + ROW_HEIGHT_PX > el.scrollTop + el.clientHeight) {
      el.scrollTop = top + ROW_HEIGHT_PX - el.clientHeight;
    }
    const th = headerRefs.current[focusCol];
    if (!th || th.style.position === 'sticky') return;
    let pinned = 0;
    for (const w of Object.keys(stickyLefts)) {
      const h = headerRefs.current[Number(w)];
      if (h) pinned += h.offsetWidth;
    }
    const leftEdge = el.scrollLeft + GUTTER_WIDTH_PX + pinned;
    if (th.offsetLeft < leftEdge) el.scrollLeft = th.offsetLeft - GUTTER_WIDTH_PX - pinned;
    else if (th.offsetLeft + th.offsetWidth > el.scrollLeft + el.clientWidth) {
      el.scrollLeft = th.offsetLeft + th.offsetWidth - el.clientWidth;
    }
  }, [focusRow, focusCol, stickyLefts]);

  // End a drag-select anywhere.
  useEffect(() => {
    const up = () => {
      dragging.current = false;
    };
    document.addEventListener('mouseup', up);
    return () => document.removeEventListener('mouseup', up);
  }, []);

  // Column resize — drag the right edge of any header to set width.
  // We don't persist mid-drag (IPC would fire on every pointermove);
  // the store already keeps per-tab widths so commit on pointerup.
  const handleResizeStart = (e: React.PointerEvent<HTMLDivElement>, colIndex: number) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const th = headerRefs.current[colIndex];
    const startWidth = th?.offsetWidth ?? 120;
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: PointerEvent) => {
      const next = Math.max(60, startWidth + (ev.clientX - startX));
      setColumnWidth(colIndex, next);
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  // ── Selection / edit helpers ──

  const select = (cell: Cell, extend = false) => {
    if (extend && anchor) {
      setRangeEnd(cell);
    } else {
      setRangeEnd(null);
      setSelectedCell(cell);
    }
  };

  const refocusGrid = () =>
    requestAnimationFrame(() => gridRef.current?.focus({ preventScroll: true }));

  const canEditEntry = (entry: GridRow | undefined) =>
    Boolean(writable && entry && entry.status !== 'deleted');

  const beginEdit = (cell: Cell, initial?: string) => {
    const entry = displayRows[cell.row];
    if (!canEditEntry(entry)) return false;
    const text = cellText(entry, cell.col);
    setEditingCell({ row: cell.row, col: cell.col, value: initial ?? text ?? null });
    setEditError(null);
    return true;
  };

  /** Queue one cell value (Postgres text or null) for the given display cell. */
  const writeCell = async (cell: Cell, value: string | null) => {
    const entry = displayRows[cell.row];
    const col = columns?.[cell.col];
    if (!entry || !col) return;
    if (entry.status === 'inserted' && entry.insert) {
      updatePendingInsert(entry.insert.id, col.name, value);
      return;
    }
    if (entry.status === 'deleted')
      throw new Error('this row is marked for deletion — restore it first');
    await updateCell(entry.originalIndex, cell.col, value);
  };

  const commitEdit = async (override?: { value: string | null }): Promise<boolean> => {
    if (!editingCell) return false;
    const { row, col } = editingCell;
    const value = override ? override.value : editingCell.value;
    setEditError(null);
    try {
      await writeCell({ row, col }, value);
      setEditingCell(null);
      return true;
    } catch (err) {
      setEditError(cleanIpcError(err instanceof Error ? err.message : String(err)));
      return false;
    }
  };

  /** Cells covered by the range, or just the anchor. */
  const selectedCells = (): Cell[] => {
    if (!anchor) return [];
    if (!range) return [anchor];
    const out: Cell[] = [];
    for (let r = range.r0; r <= range.r1; r++) {
      for (let p = range.p0; p <= range.p1; p++) {
        const c = visibleColumns[p];
        if (c) out.push({ row: r, col: c.originalIndex });
      }
    }
    return out;
  };

  /** Rows an action applies to: checked rows, else the range / anchor rows. */
  const targetRows = (): GridRow[] => {
    if (tab && tab.selectedRows.size > 0) {
      return displayRows.filter(
        (e) => e.originalIndex >= 0 && tab.selectedRows.has(e.originalIndex),
      );
    }
    if (!anchor) return [];
    const r0 = range ? range.r0 : anchor.row;
    const r1 = range ? range.r1 : anchor.row;
    return displayRows.slice(r0, r1 + 1);
  };

  const setNullOnSelection = async () => {
    setEditError(null);
    try {
      for (const cell of selectedCells()) await writeCell(cell, null);
    } catch (err) {
      setEditError(cleanIpcError(err instanceof Error ? err.message : String(err)));
    }
  };

  const deleteTargetRows = () => {
    const rows = targetRows();
    const inserts = rows.filter((r) => r.insert);
    for (const r of inserts) if (r.insert) discardPendingEdit(r.insert.id);
    const idx = rows.filter((r) => r.originalIndex >= 0).map((r) => r.originalIndex);
    if (idx.length === 0) return;
    setEditError(null);
    try {
      deleteRows(idx);
    } catch (err) {
      setEditError(cleanIpcError(err instanceof Error ? err.message : String(err)));
    }
  };

  const duplicateTarget = () => {
    const entry = anchor ? displayRows[anchor.row] : undefined;
    if (!entry) return;
    if (entry.insert) {
      useSession.getState().insertRow({ ...(entry.insert.values ?? {}) });
      return;
    }
    duplicateRow(entry.originalIndex);
  };

  const copyText = (text: string) => {
    void navigator.clipboard.writeText(text).catch(() => undefined);
  };

  /** ⌘C: range (or cell) as TSV; checked rows as TSV of visible columns. */
  const copySelection = () => {
    if (!columns) return;
    if (tab && tab.selectedRows.size > 0 && !range) {
      copyRows('tsv');
      return;
    }
    if (!anchor) return;
    if (!range) {
      const text = cellText(displayRows[anchor.row], anchor.col);
      copyText(text ?? 'NULL');
      return;
    }
    const cols = visibleColumns.slice(range.p0, range.p1 + 1).map((c) => c.originalIndex);
    const rows = displayRows.slice(range.r0, range.r1 + 1).map((e) => e.row);
    copyText(formatRows('tsv', columns, rows, cols));
  };

  const copyRows = (format: CopyFormat) => {
    if (!columns || !tab) return;
    const rows = targetRows().map((e) => e.row);
    const cols = visibleColumns.map((c) => c.originalIndex);
    const table =
      tab.kind === 'table' && tab.tableName
        ? { schema: tab.tableSchema, name: tab.tableName }
        : undefined;
    copyText(formatRows(format, columns, rows, cols, table));
  };

  /** ⌘V: paste a TSV block at the anchor (a single value fills the range). */
  const pasteBlock = async (text: string) => {
    if (!writable || !anchor) return;
    const block = parseClipboardBlock(text);
    if (block.length === 0) return;
    setEditError(null);
    try {
      const single = block.length === 1 && block[0]?.length === 1;
      if (single && range) {
        for (const cell of selectedCells()) await writeCell(cell, block[0]![0] ?? null);
        return;
      }
      const startPos = colPos.get(anchor.col) ?? 0;
      for (let r = 0; r < block.length; r++) {
        const rowIdx = anchor.row + r;
        if (rowIdx >= displayRows.length) break;
        const values = block[r] ?? [];
        for (let c = 0; c < values.length; c++) {
          const colMeta = visibleColumns[startPos + c];
          if (!colMeta) break;
          await writeCell({ row: rowIdx, col: colMeta.originalIndex }, values[c] ?? null);
        }
      }
    } catch (err) {
      setEditError(cleanIpcError(err instanceof Error ? err.message : String(err)));
    }
  };

  const openCellDetail = (cell: Cell) => {
    const entry = displayRows[cell.row];
    const colMeta = columns?.[cell.col];
    if (!entry || !colMeta) return;
    const td = containerRef.current?.querySelector<HTMLElement>(
      `td[data-cell="${cell.row}:${cell.col}"]`,
    );
    setCellDetail({
      columnName: colMeta.name,
      dataTypeName: colMeta.dataTypeName,
      value:
        entry.editedCols.has(cell.col) || entry.insert
          ? cellText(entry, cell.col)
          : entry.row[cell.col],
      anchorRect: td?.getBoundingClientRect() ?? new DOMRect(0, 0, 0, 0),
    });
  };

  const openRowDetail = (row: number) => {
    const entry = displayRows[row];
    if (!entry || !tab?.queryResult) return;
    if (useSession.getState().canvasMode === 'database') {
      useSession.getState().setRightPanelMode('details');
      return;
    }
    setRowDetail({
      tabTitle: tab.title,
      rowNumber: tab.page * tab.pageSize + row + 1,
      columns: tab.queryResult.columns,
      row: entry.row,
    });
  };

  const openMenuAtCell = (cell: Cell) => {
    const td = containerRef.current?.querySelector<HTMLElement>(
      `td[data-cell="${cell.row}:${cell.col}"]`,
    );
    const r = td?.getBoundingClientRect();
    setMenu({ x: r ? r.left + 8 : 100, y: r ? r.bottom : 100, cell });
  };

  // Keyboard — only while the grid element itself has focus (F1 / AA1).
  const onGridKeyDown = (e: React.KeyboardEvent<HTMLTableElement>) => {
    if (e.target !== e.currentTarget) return; // inner inputs / buttons own their keys
    if (!tab?.queryResult || visibleColumns.length === 0) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key;

    if (mod && !e.shiftKey && key.toLowerCase() === 'c') {
      copySelection();
      e.preventDefault();
      return;
    }
    if (mod && !e.shiftKey && key.toLowerCase() === 'a') {
      if (displayRows.length === 0) return;
      const first = visibleColumns[0]!.originalIndex;
      const last = visibleColumns[visibleColumns.length - 1]!.originalIndex;
      setSelectedCell({ row: 0, col: first });
      setRangeEnd({ row: displayRows.length - 1, col: last });
      e.preventDefault();
      return;
    }
    if (writable && mod && e.shiftKey && (key === 'Backspace' || key === 'Delete')) {
      void setNullOnSelection();
      e.preventDefault();
      return;
    }
    if (writable && mod && !e.shiftKey && (key === 'Backspace' || key === 'Delete')) {
      deleteTargetRows();
      e.preventDefault();
      return;
    }
    if (writable && mod && !e.shiftKey && key.toLowerCase() === 'd') {
      duplicateTarget();
      e.preventDefault();
      return;
    }
    if (key === 'ContextMenu' || (e.shiftKey && key === 'F10')) {
      if (anchor) openMenuAtCell(anchor);
      e.preventDefault();
      return;
    }
    if (!anchor) {
      if (key.startsWith('Arrow') || key === 'Home' || key === 'End') {
        select({ row: 0, col: visibleColumns[0]!.originalIndex });
        e.preventDefault();
      }
      return;
    }
    const { row } = rangeEnd && e.shiftKey ? rangeEnd : anchor;
    const col = rangeEnd && e.shiftKey ? rangeEnd.col : anchor.col;
    const pos = colPos.get(col) ?? 0;
    const maxRow = displayRows.length - 1;
    const maxPos = visibleColumns.length - 1;
    const colAt = (p: number) => visibleColumns[Math.max(0, Math.min(maxPos, p))]!.originalIndex;
    const pageRows = Math.max(
      1,
      Math.floor((containerRef.current?.clientHeight ?? 400) / ROW_HEIGHT_PX) - 1,
    );

    if (key === ' ') {
      openCellDetail(anchor);
      e.preventDefault();
      return;
    }
    if (key === 'Enter' && !mod && !e.shiftKey && !e.altKey) {
      openRowDetail(anchor.row);
      e.preventDefault();
      return;
    }
    if (key === 'F2') {
      if (beginEdit(anchor)) e.preventDefault();
      return;
    }
    if (key === 'Tab') {
      // Spreadsheet stepping inside the grid; Esc clears the selection so
      // Tab can leave the grid.
      const target = e.shiftKey
        ? prevCell({ row: anchor.row, col: pos }, displayRows.length, visibleColumns.length)
        : nextCell({ row: anchor.row, col: pos }, displayRows.length, visibleColumns.length);
      if (target) {
        select({ row: target.row, col: colAt(target.col) });
        e.preventDefault();
      }
      return;
    }
    if (key === 'Escape') {
      if (rangeEnd) setRangeEnd(null);
      else setSelectedCell(null);
      e.preventDefault();
      return;
    }
    let next: Cell | null = null;
    if (key === 'ArrowDown') next = { row: mod ? maxRow : Math.min(maxRow, row + 1), col };
    else if (key === 'ArrowUp') next = { row: mod ? 0 : Math.max(0, row - 1), col };
    else if (key === 'ArrowRight') next = { row, col: colAt(mod ? maxPos : pos + 1) };
    else if (key === 'ArrowLeft') next = { row, col: colAt(mod ? 0 : pos - 1) };
    else if (key === 'Home') next = mod ? { row: 0, col: colAt(0) } : { row, col: colAt(0) };
    else if (key === 'End')
      next = mod ? { row: maxRow, col: colAt(maxPos) } : { row, col: colAt(maxPos) };
    else if (key === 'PageDown') next = { row: Math.min(maxRow, row + pageRows), col };
    else if (key === 'PageUp') next = { row: Math.max(0, row - pageRows), col };
    if (next) {
      select(next, e.shiftKey);
      e.preventDefault();
      return;
    }
    // Typing starts an edit that replaces the value (spreadsheet style).
    if (writable && key.length === 1 && !mod && !e.altKey) {
      if (beginEdit(anchor, key)) e.preventDefault();
    }
  };

  const onGridPaste = (e: React.ClipboardEvent<HTMLTableElement>) => {
    if (e.target !== e.currentTarget || !writable) return;
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    void pasteBlock(text);
  };

  const onGridFocus = (e: React.FocusEvent<HTMLTableElement>) => {
    if (e.target !== e.currentTarget) return;
    // Keyboard entry (Tab into the grid) lands on the first cell.
    const t = useSession.getState().tabs.find((x) => x.id === tabId);
    if (!t?.selectedCell && displayRows.length > 0 && visibleColumns[0]) {
      setSelectedCell({ row: 0, col: visibleColumns[0].originalIndex });
    }
  };

  // Commit failure pointers (VF13): the edits whose statement failed.
  const failedIds = useMemo(() => new Set(pendingEditsError?.editIds ?? []), [pendingEditsError]);
  const failedRowKeys = useMemo(() => {
    const s = new Set<string>();
    for (const e of pendingEdits) if (failedIds.has(e.id) && e.rowKey) s.add(e.rowKey);
    return s;
  }, [pendingEdits, failedIds]);

  const jumpToFailure = () => {
    const idx = displayRows.findIndex(
      (r) =>
        (r.insert && failedIds.has(r.insert.id)) ||
        (r.rowKey && failedRowKeys.has(r.rowKey)) ||
        [...r.editIdByCol.values()].some((id) => failedIds.has(id)),
    );
    if (idx < 0) return;
    const entry = displayRows[idx]!;
    const failedCol = [...entry.editIdByCol.entries()].find(([, id]) => failedIds.has(id))?.[0];
    select({ row: idx, col: failedCol ?? visibleColumns[0]?.originalIndex ?? 0 });
    refocusGrid();
  };

  // ── Definition view (table tabs only) — short-circuits the grid ──
  if (tab?.kind === 'table' && tab.viewMode === 'definition') {
    return <TableDefinitionView />;
  }
  if (tab?.kind === 'table' && tab.viewMode === 'structure') {
    return <TableStructureView />;
  }

  // ── Error state (E6: only when the Error tab is selected) ──
  if (tab && isErrorTabActive(tab)) {
    return (
      <div className="min-h-0 flex-1 overflow-auto bg-[var(--wb-content)]">
        <div className="max-w-4xl p-5">
          <div
            className="flex items-start gap-2.5 rounded-[8px] bg-destructive/10 px-3.5 py-3 ring-1 ring-inset ring-destructive/30"
            role="alert"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div className="min-w-0">
              <div className="mb-1 text-xs font-semibold text-destructive">Query failed</div>
              <pre className="whitespace-pre-wrap break-words font-mono text-[13px] text-[var(--wb-text)]">
                {cleanIpcError(tab.queryError ?? '')}
              </pre>
              {tab.queryResults.length > 0 && (
                <div className="mt-1.5 text-[12px] text-[var(--wb-text-2)]">
                  {tab.queryResults.length} earlier statement
                  {tab.queryResults.length === 1 ? '' : 's'} succeeded — open{' '}
                  {tab.queryResults.length === 1 ? 'its result tab' : 'their result tabs'} above.
                </div>
              )}
            </div>
          </div>
          {tab.queryErrorSql && (
            <>
              <div className="mb-1.5 mt-4 text-[12px] font-medium text-[var(--wb-text-2)]">
                SQL sent to server
              </div>
              <pre className="whitespace-pre-wrap break-words rounded-[8px] bg-[var(--wb-field)] p-3 font-mono text-xs text-[var(--wb-text)] ring-1 ring-inset ring-[var(--wb-separator)]">
                {tab.queryErrorSql}
              </pre>
            </>
          )}
        </div>
      </div>
    );
  }

  const running = tab?.queryRunState === 'running';

  // ── Loading with nothing to show yet ──
  if (running && !tab?.queryResult) {
    return (
      <div
        className="flex min-h-0 flex-1 items-center justify-center gap-2 bg-[var(--wb-content)] text-[13px] text-[var(--wb-text-2)]"
        aria-busy="true"
      >
        <Loader2 className="h-4 w-4 animate-spin" />
        Running query…
      </div>
    );
  }

  // ── Empty state — connected only (AppShell handles disconnected) ──
  if (!tab?.queryResult) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-[var(--wb-content)] text-[13px] text-[var(--wb-text-2)]">
        {tab?.kind === 'sql' ? 'Run a query to see results.' : 'Click a table in the sidebar.'}
      </div>
    );
  }

  // ── Non-SELECT commands ──
  if (tab.queryResult.columns.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-[var(--wb-content)]">
        <div className="text-center">
          <div className="mb-1.5 text-[20px] font-semibold text-[var(--wb-text)]">
            {commandTitle(tab.queryResult.command, tab.queryResult.sql)}
          </div>
          <div className="text-[13px] text-[var(--wb-text-2)]" data-testid="command-summary">
            {commandDetail(tab.queryResult.command, tab.queryResult.rowCount)} ·{' '}
            {formatDuration(tab.queryResult.durationMs)}
            {tab.queryResults.length > 1 &&
              ` · statement ${tab.activeResultIndex + 1} of ${tab.queryResults.length}`}
          </div>
        </div>
      </div>
    );
  }

  const allColumns = tab.queryResult.columns;

  // Every column is hidden — render a friendly empty state with an
  // explicit "show all" CTA (more discoverable than digging into the
  // Columns popover).
  if (visibleColumns.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-[var(--wb-content)]">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="text-[13px] text-[var(--wb-text-2)]">All columns hidden</div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void useSession.getState().showAllColumns()}
          >
            Show all columns
          </Button>
        </div>
      </div>
    );
  }

  // Unified "sort indicator" — reads from the correct sort source for
  // the current tab kind so the header arrows work in both modes. The
  // index passed in is the *original* column index in the result set.
  const getSortIndicator = (colIndex: number): 'asc' | 'desc' | null => {
    if (tab.kind === 'table') {
      const col = allColumns[colIndex];
      if (!col) return null;
      const match = tab.tableSort.find((s) => s.column === col.name);
      return match?.direction ?? null;
    }
    if (tab.sortColumn?.index === colIndex) return tab.sortColumn.direction;
    return null;
  };

  const jumpToMatch = (idx: number) => {
    if (searchMatches.length === 0) return;
    const wrapped = ((idx % searchMatches.length) + searchMatches.length) % searchMatches.length;
    setActiveMatchIdx(wrapped);
    const m = searchMatches[wrapped]!;
    select({ row: m.row, col: m.col });
  };

  const cellId = (row: number, col: number) => `grid-${tab.id}-${row}-${col}`;
  const activeDescendant =
    anchor && displayRows[anchor.row] ? cellId(anchor.row, anchor.col) : undefined;
  const totalRowsForAria =
    tab.kind === 'table' ? (tab.totalRowCount ?? displayRows.length) : tab.queryResult.rows.length;

  // ── Context menu entries for the clicked cell ──
  const menuEntries = (): GridMenuEntry[] => {
    if (!menu) return [];
    const { cell } = menu;
    const entry = displayRows[cell.row];
    const colMeta = allColumns[cell.col];
    if (!entry || !colMeta) return [];
    const text = cellText(entry, cell.col);
    const rowsLabel =
      tab.selectedRows.size > 1 || (range && range.r1 > range.r0)
        ? `${targetRows().length} rows`
        : 'row';
    const out: GridMenuEntry[] = [
      {
        kind: 'item',
        label: range ? 'Copy selection' : 'Copy value',
        hint: `${MOD}C`,
        icon: <Copy />,
        onSelect: copySelection,
      },
      { kind: 'heading', label: `Copy ${rowsLabel} as` },
      ...COPY_FORMATS.map(
        (f): GridMenuEntry => ({ kind: 'item', label: f.label, onSelect: () => copyRows(f.value) }),
      ),
    ];
    if (writable) {
      out.push({
        kind: 'item',
        label: 'Paste',
        hint: `${MOD}V`,
        onSelect: () => {
          void navigator.clipboard
            .readText()
            .then((t) => pasteBlock(t))
            .catch(() =>
              setEditError(`Clipboard not readable here — focus the grid and press ${MOD}V`),
            );
        },
      });
    }
    out.push(
      { kind: 'separator' },
      { kind: 'item', label: 'View value', hint: 'Space', onSelect: () => openCellDetail(cell) },
      { kind: 'item', label: 'View row', hint: 'Enter', onSelect: () => openRowDetail(cell.row) },
    );
    if (writable && entry.status !== 'deleted') {
      out.push(
        { kind: 'separator' },
        {
          kind: 'item',
          label: 'Edit value',
          hint: 'F2',
          icon: <Pencil />,
          onSelect: () => beginEdit(cell),
        },
        {
          kind: 'item',
          label: range ? 'Set selection to NULL' : 'Set NULL',
          hint: isMac ? '⇧⌘⌫' : 'Ctrl+Shift+⌫',
          icon: <Eraser />,
          onSelect: () => void setNullOnSelection(),
        },
      );
      const editId = entry.editIdByCol.get(cell.col);
      if (editId) {
        out.push({
          kind: 'item',
          label: 'Discard change',
          icon: <Undo2 />,
          onSelect: () => discardPendingEdit(editId),
        });
      }
    }
    if (writable) {
      out.push({ kind: 'separator' });
      if (entry.insert) {
        const id = entry.insert.id;
        out.push({
          kind: 'item',
          label: 'Remove new row',
          icon: <Trash2 />,
          onSelect: () => discardPendingEdit(id),
        });
      } else {
        out.push(
          {
            kind: 'item',
            label: 'Duplicate row',
            hint: `${MOD}D`,
            icon: <CopyPlus />,
            onSelect: duplicateTarget,
          },
          {
            kind: 'item',
            label: entry.status === 'deleted' ? `Restore ${rowsLabel}` : `Delete ${rowsLabel}`,
            hint: isMac ? '⌘⌫' : 'Ctrl+⌫',
            icon: entry.status === 'deleted' ? <Undo2 /> : <Trash2 />,
            onSelect: deleteTargetRows,
          },
        );
      }
    }
    if (tab.kind === 'table' && entry.originalIndex >= 0) {
      out.push(
        { kind: 'separator' },
        {
          kind: 'item',
          label:
            text === null
              ? `Filter: ${colMeta.name} is null`
              : `Filter: ${colMeta.name} = ${truncate(text ?? '', 24)}`,
          icon: <FilterIcon />,
          onSelect: () =>
            void addFilter({
              id: `f-${Date.now().toString(36)}`,
              column: colMeta.name,
              op: text === null ? 'IS NULL' : '=',
              value: text ?? '',
            }),
        },
      );
      const fk = fkByColumn.get(colMeta.name);
      if (fk && text !== null && text !== undefined) {
        out.push({
          kind: 'item',
          label: `Open ${fk.fk.refTable} row`,
          icon: <ArrowUpRight />,
          onSelect: () => openFk(entry, colMeta.name),
        });
      }
      const server = tab.queryResult?.rows[entry.originalIndex];
      for (const ref of referencedBy.slice(0, 8)) {
        const idx = allColumns.findIndex((c) => c.name === ref.refColumn);
        if (idx < 0 || !server) continue;
        const v = cellToText(server[idx], allColumns[idx]?.dataTypeName);
        if (v === null) continue;
        out.push({
          kind: 'item',
          label: `Rows in ${ref.table}.${ref.column}`,
          onSelect: () => openForeignRow(ref.schema, ref.table, ref.column, v),
        });
      }
    }
    return out;
  };

  /** FK click-through with every column of a composite key (F7). */
  const openFk = (entry: GridRow, colName: string) => {
    const hit = fkByColumn.get(colName);
    if (!hit) return;
    const textOf = (name: string) => {
      const idx = allColumns.findIndex((c) => c.name === name);
      return idx < 0 ? null : cellText(entry, idx);
    };
    const main = textOf(colName);
    if (main === null || main === undefined) return;
    const also = hit.fk.pairs
      .filter((p) => p.column !== colName)
      .map((p) => ({ column: p.refColumn, value: textOf(p.column) }))
      .filter((p): p is { column: string; value: string } => typeof p.value === 'string');
    openForeignRow(hit.fk.refSchema, hit.fk.refTable, hit.refColumn, main, also);
  };

  const colSpan = visibleColumns.length + 1;

  return (
    <div
      ref={containerRef}
      className="relative min-h-0 flex-1 overflow-auto"
      style={stripedBackground(zebraRows)}
      aria-busy={running || undefined}
    >
      {(editError || (pendingEditsError && pendingEdits.length > 0)) && (
        <div
          className="sticky left-0 top-0 z-40 flex items-start gap-2 border-b border-destructive/40 bg-[color-mix(in_srgb,var(--destructive)_12%,var(--wb-content))] px-3 py-1.5 text-[12px] text-[var(--wb-text)]"
          role="alert"
        >
          <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0 text-destructive" />
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
            {editError ?? (
              <>
                <span className="font-semibold text-destructive">
                  Commit failed — nothing was saved.{' '}
                </span>
                {pendingEditsError?.message.replace(/\s*Nothing was saved\.?\s*$/i, '')}
              </>
            )}
          </span>
          {!editError && failedIds.size > 0 && (
            <button type="button" onClick={jumpToFailure} className="shrink-0 underline">
              Show cell
            </button>
          )}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => {
              if (editError) setEditError(null);
              else useSession.setState({ pendingEditsError: null });
            }}
            className="grid h-4 w-4 shrink-0 place-items-center rounded-[4px] text-[var(--wb-text-2)] hover:bg-[var(--wb-control-hover)]"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
      {searchOpen && (
        // Zero-height sticky host so the floating find bar never shifts
        // the table (keeps the striped background aligned to the rows).
        <div className="sticky top-0 z-30 h-0 overflow-visible">
          <div className="flex justify-end px-3 pt-8">
            <div className="flex items-center gap-1.5 rounded-[7px] border border-[var(--wb-separator)] bg-[var(--wb-sidebar)] px-2 py-1 text-[13px] shadow-md">
              <Search className="h-3.5 w-3.5 shrink-0 text-[var(--wb-text-2)]" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Find in results…"
                aria-label="Find in results"
                className="h-5 w-48 border-0 bg-transparent text-[13px] text-[var(--wb-text)] outline-none placeholder:text-[var(--wb-text-3)]"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (e.shiftKey) jumpToMatch(activeMatchIdx - 1);
                    else jumpToMatch(activeMatchIdx + 1);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setSearchOpen(false);
                    setSearchQuery('');
                    refocusGrid();
                  }
                }}
              />
              <span className="shrink-0 tabular-nums text-[var(--wb-text-2)]" aria-live="polite">
                {searchQuery
                  ? searchMatches.length > 0
                    ? `${activeMatchIdx + 1}/${searchMatches.length}`
                    : '0'
                  : ''}
              </span>
              <button
                type="button"
                onClick={() => jumpToMatch(activeMatchIdx - 1)}
                disabled={searchMatches.length === 0}
                className="grid h-5 w-5 place-items-center rounded-[4px] text-[var(--wb-text-2)] hover:bg-[var(--wb-control-hover)] hover:text-[var(--wb-text)] disabled:opacity-40"
                aria-label="Previous match"
                title="Previous match (Shift+Enter)"
              >
                <ChevronUp className="h-3 w-3" />
              </button>
              <button
                type="button"
                onClick={() => jumpToMatch(activeMatchIdx + 1)}
                disabled={searchMatches.length === 0}
                className="grid h-5 w-5 place-items-center rounded-[4px] text-[var(--wb-text-2)] hover:bg-[var(--wb-control-hover)] hover:text-[var(--wb-text)] disabled:opacity-40"
                aria-label="Next match"
                title="Next match (Enter)"
              >
                <ChevronDown className="h-3 w-3" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setSearchOpen(false);
                  setSearchQuery('');
                  refocusGrid();
                }}
                className="grid h-5 w-5 place-items-center rounded-[4px] text-[var(--wb-text-2)] hover:bg-[var(--wb-control-hover)] hover:text-[var(--wb-text)]"
                aria-label="Close search"
                title="Close (Esc)"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          </div>
        </div>
      )}
      <table
        ref={gridRef}
        // biome-ignore lint/a11y/useSemanticElements: ARIA grid on a native table (cells keep table semantics)
        role="grid"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the grid is the keyboard focus target
        tabIndex={0}
        aria-label={tab.kind === 'table' ? `${tab.tableName ?? 'Table'} rows` : 'Query results'}
        aria-rowcount={totalRowsForAria + 1}
        aria-colcount={colSpan}
        aria-multiselectable="true"
        aria-readonly={!writable}
        aria-activedescendant={activeDescendant}
        onKeyDown={onGridKeyDown}
        onPaste={onGridPaste}
        onFocus={onGridFocus}
        data-testid="result-grid"
        className={cn(
          'min-w-full select-none border-collapse font-mono text-[13px] tabular-nums text-[var(--grid-text)] outline-none',
          'focus-visible:shadow-[inset_0_0_0_1px_var(--wb-accent)]',
          running && 'opacity-60 transition-opacity',
        )}
      >
        <thead className="sticky top-0 z-10 bg-[var(--wb-content)]">
          <tr aria-rowindex={1}>
            <th
              className="sticky left-0 z-30 h-[26px] border-r border-[var(--grid-line)] bg-[var(--wb-content)] px-1 text-center align-middle shadow-[inset_0_-1px_0_var(--wb-separator)]"
              style={{ minWidth: GUTTER_WIDTH_PX, width: GUTTER_WIDTH_PX }}
              aria-colindex={1}
            >
              <SelectAllCheckbox
                total={displayRows.filter((e) => e.originalIndex >= 0).length}
                selectedCount={
                  displayRows.filter(
                    (e) => e.originalIndex >= 0 && tab.selectedRows.has(e.originalIndex),
                  ).length
                }
                onToggle={() => {
                  const real = displayRows.filter((e) => e.originalIndex >= 0);
                  const allOnPage = real.every((e) => tab.selectedRows.has(e.originalIndex));
                  setSelectedRows(
                    allOnPage ? new Set() : new Set(real.map((e) => e.originalIndex)),
                  );
                }}
              />
            </th>
            {visibleColumns.map(({ col, originalIndex: origIdx }, pos) => {
              const sortDir = getSortIndicator(origIdx);
              const isSticky = stickySet.has(col.name);
              const storedWidth = tab.columnWidths[origIdx];
              return (
                // biome-ignore lint/a11y/useKeyWithClickEvents: header sort also via the column menu
                <th
                  key={`${col.name}-${origIdx}`}
                  ref={(el) => {
                    headerRefs.current[origIdx] = el;
                  }}
                  aria-colindex={pos + 2}
                  aria-sort={
                    sortDir === 'asc' ? 'ascending' : sortDir === 'desc' ? 'descending' : undefined
                  }
                  onClick={() => setSort(origIdx)}
                  className={cn(
                    'group/header relative h-[26px] cursor-pointer select-none whitespace-nowrap border-r border-[var(--grid-line)] bg-[var(--wb-content)] px-6 py-0 text-center font-sans text-[13px] font-semibold text-[var(--grid-text)] shadow-[inset_0_-1px_0_var(--wb-separator)] transition-colors hover:bg-[var(--wb-control)]',
                  )}
                  style={{
                    minWidth: storedWidth ?? 120,
                    width: storedWidth,
                    ...stickyStyle(stickySet, stickyLefts, origIdx, col.name, 20),
                    ...(isSticky ? { top: 0 } : {}),
                  }}
                  title={`${col.name} — ${readableTypeName(col)}${isSticky ? ' · pinned' : ''}`}
                >
                  <div className="flex items-center justify-center gap-1">
                    <span className="truncate">
                      {col.name || <span className="text-[var(--wb-text-3)]">?column?</span>}
                    </span>
                    {sortDir && (
                      <span className="text-[12px] font-normal text-[var(--wb-text-2)]">
                        {sortDir === 'asc' ? '↑' : '↓'}
                      </span>
                    )}
                    <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center">
                      <ColumnHeaderMenu
                        column={col}
                        sortDir={sortDir}
                        pinned={isSticky}
                        tableMode={tab?.kind === 'table'}
                        onSortAsc={() => {
                          if (tab?.kind === 'table') setExplicitTableSort(col.name, 'asc');
                          else setExplicitSqlSort(origIdx, 'asc');
                        }}
                        onSortDesc={() => {
                          if (tab?.kind === 'table') setExplicitTableSort(col.name, 'desc');
                          else setExplicitSqlSort(origIdx, 'desc');
                        }}
                        onClearSort={() => {
                          if (tab?.kind === 'table') setExplicitTableSort(col.name, null);
                          else setExplicitSqlSort(origIdx, null);
                        }}
                        onTogglePin={() => toggleStickyColumn(col.name)}
                        onHide={() => void toggleColumnHidden(col.name)}
                      />
                    </div>
                  </div>
                  {/* biome-ignore lint/a11y/useFocusableInteractive lint/a11y/useKeyWithClickEvents lint/a11y/useSemanticElements: pointer-only resize handle */}
                  <div
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={`Resize ${col.name}`}
                    onPointerDown={(e) => handleResizeStart(e, origIdx)}
                    onClick={(e) => e.stopPropagation()}
                    className="group/resize absolute right-0 top-0 z-10 flex h-full w-2 cursor-col-resize items-stretch justify-center"
                  >
                    <div className="h-full w-px bg-transparent transition-colors group-hover/resize:bg-[var(--wb-accent)] group-active/resize:bg-[var(--wb-accent)]" />
                  </div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rowWindow.topPadPx > 0 && (
            // biome-ignore lint/a11y/noAriaHiddenOnFocusable: spacer row, never focusable
            <tr aria-hidden="true" style={{ height: rowWindow.topPadPx }}>
              <td colSpan={colSpan} />
            </tr>
          )}
          {windowedRows.map((entry, windowIdx) => {
            const visibleRow = rowWindow.start + windowIdx;
            const rowSelected = anchor?.row === visibleRow;
            const rowChecked =
              entry.originalIndex >= 0 && tab.selectedRows.has(entry.originalIndex);
            const deleted = entry.status === 'deleted';
            const inserted = entry.status === 'inserted';
            const rowFailed =
              (entry.insert && failedIds.has(entry.insert.id)) ||
              (deleted && entry.rowKey !== null && failedRowKeys.has(entry.rowKey));
            // Row #1 (index 0) takes stripe A, matching the scroll-container
            // background that continues the stripes below the last row.
            const zebra =
              zebraRows && visibleRow % 2 === 0
                ? 'bg-[var(--grid-row-a)]'
                : 'bg-[var(--grid-row-b)]';
            const rowNumber = tab.page * tab.pageSize + visibleRow + 1;
            return (
              <tr
                key={entry.key}
                aria-rowindex={inserted ? undefined : rowNumber + 1}
                aria-selected={rowChecked || undefined}
                data-row-status={entry.status === 'clean' ? undefined : entry.status}
                className={cn(
                  'group/row cv-row-24 h-[24px]',
                  deleted
                    ? DELETED_ROW_BG
                    : inserted
                      ? INSERTED_ROW_BG
                      : rowSelected
                        ? SELECTED_ROW_BG
                        : rowChecked
                          ? 'bg-[color-mix(in_srgb,var(--wb-accent)_10%,transparent)]'
                          : zebra,
                  rowFailed && FAILED_OUTLINE,
                )}
              >
                <td
                  aria-colindex={1}
                  className={cn(
                    'sticky left-0 z-[2] h-[24px] border-r border-[var(--grid-line)] p-0 text-center align-middle',
                    rowChecked
                      ? 'bg-[color-mix(in_srgb,var(--wb-accent)_30%,var(--wb-content))]'
                      : 'bg-[var(--wb-content)]',
                  )}
                  style={{ minWidth: GUTTER_WIDTH_PX, width: GUTTER_WIDTH_PX }}
                >
                  {inserted ? (
                    <span
                      className="block h-[24px] font-sans text-[12px] leading-[24px] text-[var(--status-local)]"
                      title="New row — inserted on commit"
                    >
                      new
                    </span>
                  ) : (
                    <button
                      type="button"
                      tabIndex={-1}
                      onClick={() => toggleRowSelected(entry.originalIndex)}
                      aria-pressed={rowChecked}
                      aria-label={`Select row ${rowNumber}`}
                      title={
                        deleted ? 'Marked for deletion' : rowChecked ? 'Deselect row' : 'Select row'
                      }
                      className={cn(
                        'block h-[24px] w-full px-1 text-center font-mono text-[12px] tabular-nums transition-colors',
                        deleted && 'line-through',
                        rowChecked
                          ? 'text-[var(--wb-text)]'
                          : 'text-[var(--wb-text-3)] hover:bg-[var(--wb-control)] hover:text-[var(--wb-text)]',
                      )}
                    >
                      {rowNumber.toLocaleString()}
                    </button>
                  )}
                </td>
                {visibleColumns.map(({ col, originalIndex: origIdx }, pos) => {
                  const text = cellText(entry, origIdx);
                  const cellSelected = rowSelected && anchor?.col === origIdx;
                  const cellInRange = inRange(visibleRow, origIdx);
                  const isEditing = editingCell?.row === visibleRow && editingCell?.col === origIdx;
                  const colName = col.name;
                  const isSticky = stickySet.has(colName);
                  const isMatch = matchSet.has(`${visibleRow}:${origIdx}`);
                  const activeMatch = searchMatches[activeMatchIdx];
                  const isActiveMatch =
                    isMatch && activeMatch?.row === visibleRow && activeMatch?.col === origIdx;
                  const fk = fkByColumn.get(colName);
                  const hasFk = Boolean(fk && text !== null && text !== undefined && !inserted);
                  const edited = entry.editedCols.has(origIdx);
                  const editId = entry.editIdByCol.get(origIdx);
                  const cellFailed = editId !== undefined && failedIds.has(editId);
                  return (
                    <td
                      key={origIdx}
                      id={cellId(visibleRow, origIdx)}
                      aria-colindex={pos + 2}
                      aria-selected={cellSelected || cellInRange}
                      aria-invalid={cellFailed || undefined}
                      data-cell={`${visibleRow}:${origIdx}`}
                      data-pending={edited ? 'edited' : undefined}
                      onMouseDown={(e) => {
                        if (e.button !== 0 || isEditing) return;
                        if (e.shiftKey && anchor) {
                          setRangeEnd({ row: visibleRow, col: origIdx });
                          e.preventDefault();
                          return;
                        }
                        dragging.current = true;
                        select({ row: visibleRow, col: origIdx });
                      }}
                      onMouseEnter={(e) => {
                        if (!dragging.current || !(e.buttons & 1) || !anchor) return;
                        if (anchor.row === visibleRow && anchor.col === origIdx) setRangeEnd(null);
                        else setRangeEnd({ row: visibleRow, col: origIdx });
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        if (!inRange(visibleRow, origIdx))
                          select({ row: visibleRow, col: origIdx });
                        gridRef.current?.focus({ preventScroll: true });
                        setMenu({
                          x: e.clientX,
                          y: e.clientY,
                          cell: { row: visibleRow, col: origIdx },
                        });
                      }}
                      onDoubleClick={() => {
                        if (!beginEdit({ row: visibleRow, col: origIdx })) {
                          openCellDetail({ row: visibleRow, col: origIdx });
                        }
                      }}
                      className={cn(
                        'group/cell relative h-[24px] max-w-[480px] whitespace-nowrap border-r border-[var(--grid-line)] px-1.5 text-[var(--grid-text)]',
                        !isEditing && 'cursor-cell truncate',
                        cellClass(col),
                        deleted && 'text-[var(--wb-text-3)] line-through',
                        // Sticky cells need an opaque fill so scrolled
                        // columns don't show through.
                        isSticky &&
                          (rowSelected
                            ? 'bg-[color-mix(in_srgb,var(--wb-accent)_18%,var(--grid-row-b))]'
                            : zebra),
                        edited && !isEditing && EDITED_CELL_BG,
                        cellInRange &&
                          !cellSelected &&
                          'bg-[color-mix(in_srgb,var(--wb-accent)_22%,transparent)]',
                        // Search match highlights — passive matches get an
                        // accent tint, the "current" match a stronger one.
                        isMatch &&
                          !isActiveMatch &&
                          'bg-[color-mix(in_srgb,var(--wb-accent)_12%,transparent)]',
                        isActiveMatch &&
                          'bg-[color-mix(in_srgb,var(--wb-accent)_30%,transparent)] outline outline-1 -outline-offset-1 outline-[var(--wb-accent)]',
                        cellSelected &&
                          !isEditing &&
                          'outline outline-2 -outline-offset-2 outline-[var(--wb-accent)]',
                        isEditing &&
                          'bg-[var(--wb-content)] p-0 outline outline-2 -outline-offset-2 outline-[var(--wb-accent)]',
                        cellFailed && FAILED_OUTLINE,
                        // Make room for the FK arrow so long values don't
                        // slide underneath the button.
                        hasFk && !isEditing && 'pr-7',
                      )}
                      style={stickyStyle(stickySet, stickyLefts, origIdx, colName, 3)}
                      title={
                        isEditing
                          ? undefined
                          : cellFailed
                            ? `Commit failed: ${pendingEditsError?.message ?? ''}`
                            : edited
                              ? `Pending change — was ${cellTitle(cellToText(tab.queryResult?.rows[entry.originalIndex]?.[origIdx], col.dataTypeName))}`
                              : cellTitle(text)
                      }
                    >
                      {hasFk && !isEditing && (
                        <button
                          type="button"
                          tabIndex={-1}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            openFk(entry, colName);
                          }}
                          className="absolute right-1 top-1/2 grid h-[18px] w-[18px] -translate-y-1/2 cursor-pointer place-items-center rounded-[4px] bg-[var(--wb-control)] text-[var(--wb-text-2)] opacity-0 transition-all duration-150 hover:bg-[var(--wb-control-hover)] hover:text-[var(--wb-text)] focus-visible:opacity-100 group-hover/cell:opacity-100"
                          aria-label={`Open ${fk?.fk.refSchema}.${fk?.fk.refTable}`}
                          title={`Open ${fk?.fk.refSchema}.${fk?.fk.refTable} where ${fk?.fk.pairs.map((p) => p.refColumn).join(', ')} match`}
                        >
                          <ArrowUpRight className="h-3 w-3" />
                        </button>
                      )}
                      {isEditing ? (
                        <InlineEditor
                          value={editingCell.value}
                          onChange={(value) =>
                            setEditingCell({ row: visibleRow, col: origIdx, value })
                          }
                          onCommit={(opts) => {
                            void (async () => {
                              const ok = await commitEdit(
                                opts?.value !== undefined ? { value: opts.value } : undefined,
                              );
                              if (!ok) return;
                              if (opts?.move) {
                                const target =
                                  opts.move === 'prev'
                                    ? prevCell(
                                        { row: visibleRow, col: pos },
                                        displayRows.length,
                                        visibleColumns.length,
                                      )
                                    : opts.move === 'next'
                                      ? nextCell(
                                          { row: visibleRow, col: pos },
                                          displayRows.length,
                                          visibleColumns.length,
                                        )
                                      : {
                                          row: Math.min(displayRows.length - 1, visibleRow + 1),
                                          col: pos,
                                        };
                                if (target)
                                  select({
                                    row: target.row,
                                    col: visibleColumns[target.col]!.originalIndex,
                                  });
                              }
                              if (opts?.refocus) refocusGrid();
                            })();
                          }}
                          onCancel={() => {
                            setEditingCell(null);
                            setEditError(null);
                            refocusGrid();
                          }}
                        />
                      ) : (
                        formatCell(text, inserted)
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
          {rowWindow.bottomPadPx > 0 && (
            // biome-ignore lint/a11y/noAriaHiddenOnFocusable: spacer row, never focusable
            <tr aria-hidden="true" style={{ height: rowWindow.bottomPadPx }}>
              <td colSpan={colSpan} />
            </tr>
          )}
          {tab.queryResult.truncated && (
            <tr>
              <td
                colSpan={colSpan}
                className="border-t border-[var(--grid-line)] bg-[color-mix(in_srgb,var(--status-staging)_14%,var(--wb-content))] px-3 py-2 font-sans text-[12px] text-[var(--wb-text)]"
              >
                Showing the first {tab.queryResult.rows.length.toLocaleString()} rows — the result
                hit the row limit. Add a LIMIT / WHERE to narrow it, or raise the limit in the
                editor’s row-limit menu.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <GridContextMenu
        at={menu ? { x: menu.x, y: menu.y } : null}
        entries={menu ? menuEntries() : []}
        onClose={() => {
          setMenu(null);
          refocusGrid();
        }}
      />
      <CellDetailDialog detail={cellDetail} onOpenChange={(o) => !o && setCellDetail(null)} />
      <RowDetailSheet detail={rowDetail} onOpenChange={(o) => !o && setRowDetail(null)} />
    </div>
  );
}

const EMPTY_COLS: ReadonlySet<number> = new Set();
const EMPTY_IDS: ReadonlyMap<number, string> = new Map();

function stickyStyle(
  stickySet: ReadonlySet<string>,
  stickyLefts: Record<number, number>,
  colIndex: number,
  colName: string,
  baseZ: number,
): React.CSSProperties {
  return stickySet.has(colName)
    ? {
        position: 'sticky',
        left: stickyLefts[colIndex] ?? GUTTER_WIDTH_PX,
        zIndex: baseZ,
        boxShadow: '1px 0 0 0 var(--grid-line)',
      }
    : {};
}

/**
 * The in-cell editor. `null` shows a NULL placeholder until the user
 * types (A1); the NULL button / ⇧⌘⌫ commits SQL NULL explicitly.
 */
function InlineEditor({
  value,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  onCommit: (opts?: {
    value?: string | null;
    move?: 'next' | 'prev' | 'down';
    refocus?: boolean;
  }) => void;
  onCancel: () => void;
}) {
  const done = useRef(false);
  const commitOnce = (opts?: Parameters<typeof onCommit>[0]) => {
    if (done.current) return;
    done.current = true;
    onCommit(opts);
  };
  return (
    <div className="flex h-[22px] items-center">
      <input
        // biome-ignore lint/a11y/noAutofocus: the editor opens on an explicit edit gesture
        autoFocus
        type="text"
        aria-label="Cell value"
        value={value ?? ''}
        placeholder={value === null ? 'NULL' : undefined}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => commitOnce()}
        onKeyDown={(e) => {
          e.stopPropagation();
          const mod = e.metaKey || e.ctrlKey;
          if (e.key === 'Enter') {
            e.preventDefault();
            commitOnce({ refocus: true, move: e.shiftKey ? undefined : 'down' });
          } else if (e.key === 'Escape') {
            e.preventDefault();
            done.current = true;
            onCancel();
          } else if (e.key === 'Tab') {
            e.preventDefault();
            commitOnce({ move: e.shiftKey ? 'prev' : 'next', refocus: true });
          } else if (mod && e.shiftKey && (e.key === 'Backspace' || e.key === 'Delete')) {
            e.preventDefault();
            commitOnce({ value: null, refocus: true });
          }
        }}
        className="h-[22px] min-w-0 flex-1 border-0 bg-transparent px-1.5 font-mono text-[13px] text-[var(--grid-text)] outline-none placeholder:text-[var(--grid-null)]"
      />
      <button
        type="button"
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => commitOnce({ value: null, refocus: true })}
        title="Set NULL (⇧⌘⌫)"
        className="mr-0.5 h-[18px] shrink-0 rounded-[4px] bg-[var(--wb-control)] px-1 font-sans text-[11px] text-[var(--wb-text-2)] hover:bg-[var(--wb-control-hover)] hover:text-[var(--wb-text)]"
      >
        NULL
      </button>
    </div>
  );
}

/**
 * Header-row checkbox that reflects all-visible / partial / none
 * states.
 */
function SelectAllCheckbox({
  total,
  selectedCount,
  onToggle,
}: {
  total: number;
  selectedCount: number;
  onToggle: () => void;
}) {
  const all = total > 0 && selectedCount === total;
  return (
    <button
      type="button"
      tabIndex={-1}
      onClick={onToggle}
      aria-label={all ? 'Deselect all rows' : 'Select all rows'}
      title={all ? 'Deselect all visible' : 'Select all visible'}
      className={cn(
        'h-[20px] w-full rounded-[4px] font-mono text-[12px] tabular-nums transition-colors',
        selectedCount > 0
          ? 'bg-[color-mix(in_srgb,var(--wb-accent)_30%,var(--wb-content))] text-[var(--wb-text)]'
          : 'text-[var(--wb-text-3)] hover:bg-[var(--wb-control)] hover:text-[var(--wb-text)]',
      )}
    >
      {selectedCount > 0 ? selectedCount.toLocaleString() : '#'}
    </button>
  );
}

// ─── Cell formatting ─────────────────────────────────────────────────

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Render a cell's Postgres text (null = NULL, undefined = DEFAULT on a new row). */
function formatCell(text: string | null | undefined, insertRow: boolean): React.ReactNode {
  if (text === undefined) {
    return <span className="text-[var(--grid-null)]">{insertRow ? 'DEFAULT' : ''}</span>;
  }
  if (text === null) return <span className="text-[var(--grid-null)]">NULL</span>;
  if (text === '') return <span className="text-[var(--grid-null)]">''</span>;
  return text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS)}…` : text;
}

function cellTitle(text: string | null | undefined): string {
  if (text === null) return 'NULL';
  if (text === undefined) return '';
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
}

/**
 * Numbers right-align (TablePlus); no per-type colours — every value uses
 * the grid text colour.
 */
function cellClass(col: ColumnMeta | undefined): string {
  if (!col) return '';
  const t = col.dataTypeName;
  if (
    t === 'int2' ||
    t === 'int4' ||
    t === 'int8' ||
    t === 'float4' ||
    t === 'float8' ||
    t === 'numeric'
  ) {
    return 'text-right';
  }
  return '';
}
