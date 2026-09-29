import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { BrandMark } from '@/features/app-shell/BrandMark';
import { cn } from '@/lib/cn';
import { copyCellToClipboard } from '@/lib/export';
import { formatDuration } from '@/lib/format';
import { useActiveTab, useSession } from '@/stores/session';
import { useWorkbench } from '@/stores/workbench';
import type { ColumnMeta } from '@shared/protocol';
import {
  AlertCircle,
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  Code2,
  Search,
  Table2,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type CellDetail, CellDetailDialog } from './CellDetailDialog';
import { nextCell, prevCell } from './grid-nav';
import { ColumnHeaderMenu } from './ColumnHeaderMenu';
import {
  type IndexedRow,
  slicePageSorted,
  slicePageUnsorted,
  sortRowsWithIndex,
} from './display-rows';
import { type RowDetail, RowDetailSheet } from './RowDetailSheet';
import { SqlHomePanel } from './SqlHomePanel';
import { TableDefinitionView } from './TableDefinitionView';
import { TableStructureView } from './TableStructureView';
import { ROW_HEIGHT_PX, computeRowWindow } from './windowed-rows';

// Stable empty Set used as a fallback when the active tab is null. Using
// a module-level singleton keeps the useEffect dependency reference-stable
// across renders so we don't trip the sticky-column re-measure loop.
const EMPTY_STICKY_SET: ReadonlySet<string> = new Set();

/** Grid header height (TablePlus: 26px header over 24px rows). */
const HEADER_HEIGHT_PX = 26;
/** Row-number gutter width. */
const GUTTER_WIDTH_PX = 44;
/** Selected-row tint: the theme accent at 18% (Plasma coral by default). */
const SELECTED_ROW_BG = 'bg-[color-mix(in_srgb,var(--wb-accent)_18%,transparent)]';

/**
 * Scroll-container background: the zebra stripes continue below the last
 * row (aligned to the 24px rows under the 26px header) and the gutter
 * column stays the plain content colour, like TablePlus.
 */
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

/**
 * Paginated + sortable result grid with keyboard navigation and cell copy.
 *
 *  - Click a header to toggle sort (asc → desc → none)
 *  - Click a cell to select; arrows move selection
 *  - Enter opens row detail; F2 / double-click edits (when writable)
 *  - Tab / Shift+Tab move to the next / previous cell
 *  - Ctrl/Cmd+C copies the selected cell value
 *  - Long cells truncate with a native tooltip on hover
 *
 * U15: worker results are row/byte-capped (`truncated` flag). The tbody
 * uses scroll-windowed rendering (replacing MAX_DOM_ROWS) so large
 * pageSize values do not mount thousands of DOM nodes.
 */
export function ResultGrid() {
  const tab = useActiveTab();
  const setSort = useSession((s) => s.setSort);
  const setSelectedCell = useSession((s) => s.setSelectedCell);
  const toggleRowSelected = useSession((s) => s.toggleRowSelected);
  const setSelectedRows = useSession((s) => s.setSelectedRows);
  const setColumnWidth = useSession((s) => s.setColumnWidth);
  const editMode = useSession((s) => s.editMode);
  const connectionReadOnly = useSession((s) => Boolean(s.activeConfig?.readOnly));
  const updateCell = useSession((s) => s.updateCell);
  const deleteRow = useSession((s) => s.deleteRow);
  const schema = useSession((s) => s.schema);
  const openForeignRow = useSession((s) => s.openForeignRow);
  const toggleColumnHidden = useSession((s) => s.toggleColumnHidden);
  const toggleStickyColumn = useSession((s) => s.toggleStickyColumn);

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
  const [editingCell, setEditingCell] = useState<{
    row: number;
    col: number;
    value: string;
  } | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  // Cell detail viewer — opens on double-click (read-only contexts) or
  // Space on the selected cell. Shows the full, formatted value.
  const [cellDetail, setCellDetail] = useState<CellDetail | null>(null);

  // Row detail drawer — opens on Enter on the selected cell, or on a
  // click of the row-number column. Lays the whole row out vertically.
  const [rowDetail, setRowDetail] = useState<RowDetail | null>(null);

  // Pending row index for the destructive-delete confirm dialog.
  const [pendingDeleteRow, setPendingDeleteRow] = useState<number | null>(null);

  // In-grid search — Ctrl+F / ⌘F toggles the floating bar. Matches are
  // computed from displayRows (case-insensitive substring). Enter /
  // Shift+Enter cycles through matches and jumps the selected cell.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeMatchIdx, setActiveMatchIdx] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

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
  const writable = Boolean(
    isTableTab &&
      editMode &&
      !connectionReadOnly &&
      tab?.tableSchema &&
      tab?.tableName &&
      schema?.columns.some(
        (c) => c.schema === tab.tableSchema && c.table === tab.tableName && c.isPrimaryKey,
      ),
  );

  const commitEdit = async (): Promise<boolean> => {
    if (!editingCell) return false;
    const { row, col, value } = editingCell;
    setEditError(null);
    try {
      await updateCell(row, col, value);
      setEditingCell(null);
      return true;
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err));
      return false;
    }
  };

  const confirmDeleteRow = async () => {
    if (pendingDeleteRow === null) return;
    const rowIndex = pendingDeleteRow;
    setPendingDeleteRow(null);
    setEditError(null);
    try {
      await deleteRow(rowIndex);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err));
    }
  };

  // Compute display rows (U14 + U15).
  //
  // Table tabs: the server already returned the sorted + paginated
  // slice, so we render all rows as-is.
  //
  // SQL tabs: sorted order is memoized on (rows, sort) only so paging
  // does not re-sort. Unsorted pages slice first, then wrap only the
  // visible rows — never allocate an IndexedRow for every result row.
  const sortedSqlRows = useMemo((): IndexedRow[] | null => {
    if (!tab?.queryResult || tab.kind !== 'sql' || !tab.sortColumn) return null;
    return sortRowsWithIndex(tab.queryResult.rows, tab.sortColumn);
  }, [tab?.kind, tab?.queryResult, tab?.sortColumn]);

  const displayRows = useMemo(() => {
    if (!tab?.queryResult) return [] as IndexedRow[];
    if (tab.kind === 'table') {
      return tab.queryResult.rows.map((row, i) => ({ row, originalIndex: i }));
    }
    if (sortedSqlRows) {
      return slicePageSorted(sortedSqlRows, tab.page, tab.pageSize);
    }
    return slicePageUnsorted(tab.queryResult.rows, tab.page, tab.pageSize);
  }, [tab?.kind, tab?.queryResult, tab?.page, tab?.pageSize, sortedSqlRows]);

  // Publish the selected row for the right-sidebar Details pane. Only the
  // grid knows how the selected display row maps back to result data.
  const setInspectedRow = useWorkbench((s) => s.setInspectedRow);
  const tabId = tab?.id;
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

  const rowWindow = useMemo(
    () => computeRowWindow(displayRows.length, scrollTop, viewportHeight),
    [displayRows.length, scrollTop, viewportHeight],
  );
  const windowedRows = useMemo(
    () => displayRows.slice(rowWindow.start, rowWindow.end),
    [displayRows, rowWindow.start, rowWindow.end],
  );

  // Foreign-key lookup for the current table tab. Keyed by column name,
  // since FK click-through is only supported on table tabs where each
  // column is unambiguously one of the table's own columns. On SQL tabs
  // we'd need to match projection expressions back to source columns,
  // which isn't possible without a SQL parser — skip entirely.
  const fkByColumn = useMemo(() => {
    const m = new Map<string, { refSchema: string; refTable: string; refColumn: string }>();
    if (tab?.kind === 'table' && tab.tableSchema && tab.tableName && schema?.foreignKeys) {
      for (const fk of schema.foreignKeys) {
        if (fk.schema === tab.tableSchema && fk.table === tab.tableName) {
          m.set(fk.column, {
            refSchema: fk.refSchema,
            refTable: fk.refTable,
            refColumn: fk.refColumn,
          });
        }
      }
    }
    return m;
  }, [tab?.kind, tab?.tableSchema, tab?.tableName, schema?.foreignKeys]);

  // Compute search matches — visible-row / original-col indices. Keyed
  // off displayRows (already page-sliced) so matches always line up
  // with what the user sees.
  const searchMatches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [] as Array<{ row: number; col: number }>;
    const out: Array<{ row: number; col: number }> = [];
    displayRows.forEach((entry, visibleRow) => {
      entry.row.forEach((cell, col) => {
        if (cell === null || cell === undefined) return;
        const str = typeof cell === 'object' ? JSON.stringify(cell) : String(cell);
        if (str.toLowerCase().includes(q)) {
          out.push({ row: visibleRow, col });
        }
      });
    });
    return out;
  }, [searchQuery, displayRows]);

  const matchSet = useMemo(() => {
    const s = new Set<string>();
    for (const m of searchMatches) s.add(`${m.row}:${m.col}`);
    return s;
  }, [searchMatches]);

  // Reset the active match whenever the search query or result changes.
  useEffect(() => {
    setActiveMatchIdx(0);
  }, [searchQuery, displayRows]);

  // Global Ctrl+F / ⌘F handler — only active when the grid has a
  // renderable result, so it doesn't fight Monaco or other inputs.
  useEffect(() => {
    if (!tab?.queryResult) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        const active = document.activeElement;
        const tag = active?.tagName?.toLowerCase();
        if (tag === 'textarea' || (tag === 'input' && active !== searchInputRef.current)) {
          return; // let text inputs / Monaco handle their own find
        }
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 0);
      } else if (e.key === 'Escape' && searchOpen) {
        setSearchOpen(false);
        setSearchQuery('');
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [tab?.queryResult, searchOpen]);

  // Sticky columns — hooks live up here (before any early return) so
  // the hook order stays stable across renders regardless of whether
  // tab/queryResult is present. Derived data (refs into columns, offset
  // math) is fine to compute from nullable state.
  const stickySet = tab?.stickyColumns ?? EMPTY_STICKY_SET;
  const headerRefs = useRef<Array<HTMLTableCellElement | null>>([]);
  const [stickyLefts, setStickyLefts] = useState<Record<number, number>>({});
  const resultColumns = tab?.queryResult?.columns;

  useEffect(() => {
    if (!resultColumns || stickySet.size === 0) {
      setStickyLefts({});
      return;
    }
    const lefts: Record<number, number> = {};
    let cumulative = 0;
    resultColumns.forEach((col, i) => {
      if (stickySet.has(col.name)) {
        lefts[i] = cumulative;
        const th = headerRefs.current[i];
        if (th) cumulative += th.offsetWidth;
      }
    });
    setStickyLefts(lefts);
  }, [stickySet, resultColumns, displayRows.length]);

  const stickyStyle = (colIndex: number, colName: string, baseZ: number): React.CSSProperties =>
    stickySet.has(colName)
      ? {
          position: 'sticky',
          left: stickyLefts[colIndex] ?? 0,
          zIndex: baseZ,
          boxShadow: '1px 0 0 0 var(--grid-line)',
        }
      : {};

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

  // Begin inline edit on the currently selected cell (F2 / programmatic).
  const beginEditSelected = () => {
    if (!writable || !tab?.selectedCell || !tab.queryResult) return false;
    const { row, col } = tab.selectedCell;
    const pagedRow = displayRows[row];
    if (!pagedRow) return false;
    const cell = pagedRow.row[col];
    setEditingCell({
      row,
      col,
      value: cell === null || cell === undefined ? '' : String(cell),
    });
    setEditError(null);
    return true;
  };

  // Keyboard navigation — arrows move selection; Enter = row detail;
  // F2 edits; Tab advances; Ctrl+C copies. (U38 accessibility floor.)
  useEffect(() => {
    if (!tab?.queryResult || tab.queryResult.columns.length === 0) return;
    const handler = (e: KeyboardEvent) => {
      // Only handle keys when the focus is inside the grid (or body)
      const active = document.activeElement;
      const tag = active?.tagName?.toLowerCase();
      if (
        tag === 'input' ||
        tag === 'textarea' ||
        (active && 'isContentEditable' in active && (active as HTMLElement).isContentEditable)
      ) {
        return;
      }
      // Copy
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
        if (!tab.selectedCell) return;
        const pagedRow = displayRows[tab.selectedCell.row];
        if (!pagedRow) return;
        const value = pagedRow.row[tab.selectedCell.col];
        void copyCellToClipboard(value);
        e.preventDefault();
        return;
      }
      if (!tab.selectedCell) return;
      const { row, col } = tab.selectedCell;
      const maxRow = displayRows.length - 1;
      const maxCol = tab.queryResult ? tab.queryResult.columns.length - 1 : 0;
      const rowCount = displayRows.length;
      const colCount = tab.queryResult ? tab.queryResult.columns.length : 0;
      // Space opens the cell detail viewer for the current selection.
      if (e.key === ' ') {
        const pagedRow = displayRows[row];
        const colMeta = tab.queryResult?.columns[col];
        if (pagedRow && colMeta) {
          // Anchor the popover to the selected cell's DOM rect so the
          // popover pops next to it, not at viewport origin.
          const td = containerRef.current?.querySelector<HTMLElement>(
            `td[data-cell="${row}:${col}"]`,
          );
          const rect = td?.getBoundingClientRect() ?? new DOMRect(0, 0, 0, 0);
          setCellDetail({
            columnName: colMeta.name,
            dataTypeName: colMeta.dataTypeName,
            value: pagedRow.row[col],
            anchorRect: rect,
          });
          e.preventDefault();
        }
        return;
      }
      // Enter opens the row inspector: the right-sidebar Details pane
      // when the database canvas (and its rail) is showing, else the
      // drawer.
      if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        const pagedRow = displayRows[row];
        if (pagedRow && useSession.getState().canvasMode === 'database') {
          useSession.getState().setRightPanelMode('details');
          e.preventDefault();
        } else if (pagedRow && tab.queryResult) {
          setRowDetail({
            tabTitle: tab.title,
            rowNumber: tab.page * tab.pageSize + row + 1,
            columns: tab.queryResult.columns,
            row: pagedRow.row,
          });
          e.preventDefault();
        }
        return;
      }
      // F2 starts an inline edit when the grid is writable (Excel-style).
      if (e.key === 'F2') {
        if (beginEditSelected()) e.preventDefault();
        return;
      }
      // Tab / Shift+Tab move selection to the next / previous cell.
      if (e.key === 'Tab') {
        const target = e.shiftKey
          ? prevCell({ row, col }, rowCount, colCount)
          : nextCell({ row, col }, rowCount, colCount);
        if (target) {
          setSelectedCell(target);
          e.preventDefault();
        }
        return;
      }
      if (e.key === 'ArrowDown') {
        setSelectedCell({ row: Math.min(maxRow, row + 1), col });
        e.preventDefault();
      } else if (e.key === 'ArrowUp') {
        setSelectedCell({ row: Math.max(0, row - 1), col });
        e.preventDefault();
      } else if (e.key === 'ArrowRight') {
        setSelectedCell({ row, col: Math.min(maxCol, col + 1) });
        e.preventDefault();
      } else if (e.key === 'ArrowLeft') {
        setSelectedCell({ row, col: Math.max(0, col - 1) });
        e.preventDefault();
      } else if (e.key === 'Escape') {
        setSelectedCell(null);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
    // beginEditSelected closes over writable/displayRows/tab; list them.
  }, [
    tab?.selectedCell,
    tab?.queryResult,
    tab?.title,
    tab?.page,
    tab?.pageSize,
    displayRows,
    setSelectedCell,
    writable,
  ]);

  // ── Definition view (table tabs only) — short-circuits the grid ──
  if (tab?.kind === 'table' && tab.viewMode === 'definition') {
    return <TableDefinitionView />;
  }
  if (tab?.kind === 'table' && tab.viewMode === 'structure') {
    return <TableStructureView />;
  }

  // ── Error state ──
  if (tab?.queryError) {
    return (
      <div className="min-h-0 flex-1 overflow-auto bg-[var(--wb-content)]">
        <div className="max-w-4xl p-5">
          <div className="flex items-start gap-2.5 rounded-[8px] bg-destructive/10 px-3.5 py-3 ring-1 ring-inset ring-destructive/30">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div className="min-w-0">
              <div className="mb-1 text-xs font-semibold text-destructive">Query failed</div>
              <pre className="whitespace-pre-wrap break-words font-mono text-[13px] text-foreground">
                {cleanIpcError(tab.queryError)}
              </pre>
            </div>
          </div>
          {tab.queryErrorSql && (
            <>
              <div className="mb-1.5 mt-4 text-[11px] font-semibold text-muted-foreground">
                SQL sent to server
              </div>
              <pre className="glass whitespace-pre-wrap break-words rounded-[8px] p-3 font-mono text-xs text-foreground">
                {tab.queryErrorSql}
              </pre>
            </>
          )}
        </div>
      </div>
    );
  }

  // ── Loading state ──
  //
  // Motion: the BrandMark's built-in oxblood signature stroke (the
  // `rect.accent` inside the SVG) animates directly — draws left→right,
  // holds, then erases right→left. No secondary line underneath. The
  // mark glyph itself breathes subtly to confirm the query is alive.
  if (tab?.queryRunState === 'running') {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-[var(--wb-content)]">
        <div className="flex flex-col items-center gap-5 text-center">
          <BrandMark className="plasma-loading-mark h-28 w-28 text-foreground" />
          <div className="plasma-loading-caption text-lg text-muted-foreground">
            running query…
          </div>
        </div>
        <style>{`
          .plasma-loading-mark svg {
            animation: plasma-breathe 2.2s ease-in-out infinite;
          }
          .plasma-loading-mark svg .accent {
            transform-box: fill-box;
            transform-origin: left center;
            animation: plasma-signature 2.2s cubic-bezier(0.65, 0, 0.35, 1) infinite;
          }
          .plasma-loading-caption {
            animation: plasma-breathe 2.2s ease-in-out infinite;
            animation-delay: 0.1s;
          }
          @keyframes plasma-breathe {
            0%, 100% { opacity: 0.78; }
            50%      { opacity: 1; }
          }
          @keyframes plasma-signature {
            0%   { transform: scaleX(0); transform-origin: left center; }
            42%  { transform: scaleX(1); transform-origin: left center; }
            50%  { transform: scaleX(1); transform-origin: right center; }
            92%  { transform: scaleX(0); transform-origin: right center; }
            100% { transform: scaleX(0); transform-origin: right center; }
          }
        `}</style>
      </div>
    );
  }

  // ── Empty state — connected only (AppShell handles disconnected) ──
  if (!tab?.queryResult) {
    const isSqlTab = tab?.kind === 'sql';
    // For SQL tabs with an empty editor, show the home panel instead
    // of a blank pitch — lets the user relaunch a recent query without
    // retyping it or opening the history sheet.
    if (isSqlTab && (tab?.sql.trim() ?? '') === '') {
      return <SqlHomePanel />;
    }
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-[var(--wb-content)]">
        <div className="flex flex-col items-center gap-6 text-center">
          <BrandMark className="h-20 w-20 text-foreground/70" />
          <div className="text-2xl text-muted-foreground">
            {isSqlTab ? 'Select a table, or write a query.' : 'Click a table in the sidebar.'}
          </div>
          {isSqlTab && <EmptySqlActions />}
        </div>
      </div>
    );
  }

  // ── Non-SELECT commands ──
  if (tab.queryResult.columns.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-[var(--wb-content)]">
        <div className="text-center">
          <div className="mb-2 text-3xl text-foreground">
            {tab.queryResult.command ?? 'OK'}
          </div>
          <div className="text-sm text-muted-foreground">
            {tab.queryResult.rowCount.toLocaleString()} rows affected ·{' '}
            {formatDuration(tab.queryResult.durationMs)}
          </div>
        </div>
      </div>
    );
  }

  const allColumns = tab.queryResult.columns;

  // SQL tabs always need client-side hidden filtering since the server
  // returns every projected column. Table tabs already rewrite the
  // SELECT to skip hidden columns — but when *all* are hidden the
  // SQL builder falls back to `SELECT *`, so we still filter client-side
  // here. That gives a single empty-state branch below regardless of
  // tab kind.
  const visibleColumns: Array<{ col: (typeof allColumns)[number]; originalIndex: number }> =
    allColumns
      .map((col, i) => ({ col, originalIndex: i }))
      .filter(({ col }) => !tab.hiddenColumns.has(col.name));

  // Every column is hidden — render a friendly empty state with an
  // explicit "show all" CTA (more discoverable than digging into the
  // Columns popover).
  if (visibleColumns.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-[var(--wb-content)]">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="text-2xl text-muted-foreground">
            All columns hidden
          </div>
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
    const m = searchMatches[wrapped];
    setSelectedCell({ row: m.row, col: m.col });
  };

  return (
    <div
      ref={containerRef}
      className="relative min-h-0 flex-1 overflow-auto"
      style={STRIPED_BACKGROUND}
    >
      {editError && (
        <div className="sticky top-0 z-20 border-b border-primary bg-primary/10 px-4 py-2 text-xs text-primary">
          {editError}{' '}
          <button type="button" onClick={() => setEditError(null)} className="ml-2 underline">
            dismiss
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
                  }
                }}
              />
              <span className="shrink-0 tabular-nums text-[var(--wb-text-2)]">
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
      <table className="min-w-full border-collapse font-mono text-[13px] tabular-nums text-[var(--grid-text)]">
        <thead className="sticky top-0 z-10 bg-[var(--wb-content)]">
          <tr>
            <th
              className="sticky left-0 z-30 h-[26px] border-r border-[var(--grid-line)] bg-[var(--wb-content)] px-1 shadow-[inset_0_-1px_0_var(--wb-separator)] text-center align-middle"
              style={{ minWidth: GUTTER_WIDTH_PX, width: GUTTER_WIDTH_PX }}
            >
              <SelectAllCheckbox
                total={displayRows.length}
                selectedCount={
                  displayRows.filter((e) => tab.selectedRows.has(e.originalIndex)).length
                }
                onToggle={() => {
                  const allOnPage = displayRows.every((e) => tab.selectedRows.has(e.originalIndex));
                  if (allOnPage) {
                    setSelectedRows(new Set());
                  } else {
                    setSelectedRows(new Set(displayRows.map((e) => e.originalIndex)));
                  }
                }}
              />
            </th>
            {visibleColumns.map(({ col, originalIndex: origIdx }) => {
              const sortDir = getSortIndicator(origIdx);
              const isSticky = stickySet.has(col.name);
              const storedWidth = tab.columnWidths[origIdx];
              return (
                <th
                  key={`${col.name}-${origIdx}`}
                  ref={(el) => {
                    headerRefs.current[origIdx] = el;
                  }}
                  onClick={() => setSort(origIdx)}
                  className={cn(
                    'group/header relative h-[26px] cursor-pointer select-none whitespace-nowrap border-r border-[var(--grid-line)] bg-[var(--wb-content)] px-6 py-0 text-center font-sans shadow-[inset_0_-1px_0_var(--wb-separator)] text-[13px] font-semibold text-[var(--grid-text)] transition-colors hover:bg-[var(--wb-control)]',
                  )}
                  style={{
                    minWidth: storedWidth ?? 120,
                    width: storedWidth,
                    ...stickyStyle(origIdx, col.name, 20),
                    ...(isSticky ? { top: 0 } : {}),
                  }}
                  title={`${col.name} — ${col.dataTypeName}${isSticky ? ' · pinned' : ''}`}
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
                          if (tab?.kind === 'table') {
                            setExplicitTableSort(col.name, 'asc');
                          } else {
                            setExplicitSqlSort(origIdx, 'asc');
                          }
                        }}
                        onSortDesc={() => {
                          if (tab?.kind === 'table') {
                            setExplicitTableSort(col.name, 'desc');
                          } else {
                            setExplicitSqlSort(origIdx, 'desc');
                          }
                        }}
                        onClearSort={() => {
                          if (tab?.kind === 'table') {
                            setExplicitTableSort(col.name, null);
                          } else {
                            setExplicitSqlSort(origIdx, null);
                          }
                        }}
                        onTogglePin={() => toggleStickyColumn(col.name)}
                        onHide={() => void toggleColumnHidden(col.name)}
                      />
                    </div>
                  </div>
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
            {writable && (
              <th
                className="sticky right-0 w-10 bg-[var(--wb-content)] shadow-[inset_0_-1px_0_var(--wb-separator)]"
                aria-label="row actions"
              />
            )}
          </tr>
        </thead>
        <tbody>
          {rowWindow.topPadPx > 0 && (
            <tr aria-hidden="true" style={{ height: rowWindow.topPadPx }}>
              <td colSpan={visibleColumns.length + (writable ? 2 : 1)} />
            </tr>
          )}
          {windowedRows.map((entry, windowIdx) => {
            const visibleRow = rowWindow.start + windowIdx;
            const rowSelected = tab.selectedCell?.row === visibleRow;
            const rowChecked = tab.selectedRows.has(entry.originalIndex);
            // Row #1 (index 0) takes stripe A, matching the scroll-container
            // background that continues the stripes below the last row.
            const zebra =
              visibleRow % 2 === 0 ? 'bg-[var(--grid-row-a)]' : 'bg-[var(--grid-row-b)]';
            return (
              <tr
                // biome-ignore lint/suspicious/noArrayIndexKey: stable per-query
                key={`row-${visibleRow}-${entry.originalIndex}`}
                className={cn(
                  'group/row cv-row-24',
                  rowSelected ? SELECTED_ROW_BG : rowChecked ? 'bg-[color-mix(in_srgb,var(--wb-accent)_10%,transparent)]' : zebra,
                )}
              >
                <td
                  className={cn(
                    'sticky left-0 z-[2] border-r border-[var(--grid-line)] p-0 text-center align-middle',
                    rowChecked
                      ? 'bg-[color-mix(in_srgb,var(--wb-accent)_30%,var(--wb-content))]'
                      : 'bg-[var(--wb-content)]',
                  )}
                  style={{ minWidth: GUTTER_WIDTH_PX, width: GUTTER_WIDTH_PX }}
                >
                  <button
                    type="button"
                    onClick={() => toggleRowSelected(entry.originalIndex)}
                    aria-pressed={rowChecked}
                    aria-label={`Select row ${tab.page * tab.pageSize + visibleRow + 1}`}
                    title={rowChecked ? 'Deselect row' : 'Select row'}
                    className={cn(
                      'h-[24px] w-full px-1 text-center font-mono text-[12px] tabular-nums transition-colors',
                      rowChecked
                        ? 'text-[var(--wb-text)]'
                        : 'text-[var(--wb-text-3)] hover:bg-[var(--wb-control)] hover:text-[var(--wb-text)]',
                    )}
                  >
                    {(tab.page * tab.pageSize + visibleRow + 1).toLocaleString()}
                  </button>
                </td>
                {visibleColumns.map(({ col, originalIndex: origIdx }) => {
                  const cell = entry.row[origIdx];
                  const cellSelected =
                    tab.selectedCell?.row === visibleRow && tab.selectedCell?.col === origIdx;
                  const isEditing = editingCell?.row === visibleRow && editingCell?.col === origIdx;
                  const colName = col.name;
                  const isSticky = stickySet.has(colName);
                  const isMatch = matchSet.has(`${visibleRow}:${origIdx}`);
                  const activeMatch = searchMatches[activeMatchIdx];
                  const isActiveMatch =
                    isMatch && activeMatch?.row === visibleRow && activeMatch?.col === origIdx;
                  const fk = fkByColumn.get(colName);
                  const hasFk = fk && cell !== null && cell !== undefined;
                  return (
                    <td
                      key={`${visibleRow}-${origIdx}`}
                      data-cell={`${visibleRow}:${origIdx}`}
                      onClick={() => {
                        if (!isEditing) setSelectedCell({ row: visibleRow, col: origIdx });
                      }}
                      onDoubleClick={(e) => {
                        if (writable) {
                          setEditingCell({
                            row: visibleRow,
                            col: origIdx,
                            value: cell === null || cell === undefined ? '' : String(cell),
                          });
                        } else {
                          setCellDetail({
                            columnName: col.name,
                            dataTypeName: col.dataTypeName,
                            value: cell,
                            anchorRect: (e.currentTarget as HTMLElement).getBoundingClientRect(),
                          });
                        }
                      }}
                      className={cn(
                        'group/cell relative h-[24px] max-w-[480px] whitespace-nowrap border-r border-[var(--grid-line)] px-1.5 text-[var(--grid-text)]',
                        !isEditing && 'cursor-cell truncate',
                        cellClass(col),
                        cellSelected &&
                          !isEditing &&
                          'outline outline-2 -outline-offset-2 outline-[var(--wb-accent)]',
                        isEditing &&
                          'bg-[var(--wb-content)] p-0 outline outline-2 -outline-offset-2 outline-[var(--wb-accent)]',
                        // Sticky cells need an opaque fill so scrolled
                        // columns don't show through.
                        isSticky &&
                          (rowSelected
                            ? 'bg-[color-mix(in_srgb,var(--wb-accent)_18%,var(--grid-row-b))]'
                            : zebra),
                        // Search match highlights — passive matches get an
                        // accent tint, the "current" match gets a stronger
                        // tint so the user can see where the jump landed.
                        isMatch && !isActiveMatch && 'bg-[color-mix(in_srgb,var(--wb-accent)_12%,transparent)]',
                        isActiveMatch &&
                          'bg-[color-mix(in_srgb,var(--wb-accent)_30%,transparent)] outline outline-1 -outline-offset-1 outline-[var(--wb-accent)]',
                        // Make room for the FK arrow so long values don't
                        // slide underneath the button.
                        hasFk && !isEditing && 'pr-7',
                      )}
                      style={stickyStyle(origIdx, colName, 3)}
                      title={!isEditing ? cellTitle(cell) : undefined}
                    >
                      {hasFk && !isEditing && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (fk) openForeignRow(fk.refSchema, fk.refTable, fk.refColumn, cell);
                          }}
                          className="absolute right-1 top-1/2 grid h-[18px] w-[18px] -translate-y-1/2 cursor-pointer place-items-center rounded-[4px] bg-[var(--wb-control)] text-[var(--wb-text-2)] opacity-0 transition-all duration-150 hover:bg-[var(--wb-control-hover)] hover:text-[var(--wb-text)] focus-visible:opacity-100 group-hover/cell:opacity-100"
                          aria-label={`Open ${fk?.refSchema}.${fk?.refTable}`}
                          title={`Open ${fk?.refSchema}.${fk?.refTable} where ${fk?.refColumn} = ${formatFkTitle(cell)}`}
                        >
                          <ArrowUpRight className="h-3 w-3" />
                        </button>
                      )}
                      {isEditing ? (
                        <input
                          autoFocus
                          type="text"
                          value={editingCell.value}
                          onChange={(e) =>
                            setEditingCell({
                              row: visibleRow,
                              col: origIdx,
                              value: e.target.value,
                            })
                          }
                          onBlur={() => {
                            void commitEdit();
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              void commitEdit();
                            } else if (e.key === 'Escape') {
                              e.preventDefault();
                              setEditingCell(null);
                            } else if (e.key === 'Tab') {
                              // Commit, then advance (or retreat) selection.
                              e.preventDefault();
                              const rowCount = displayRows.length;
                              const colCount = tab.queryResult?.columns.length ?? 0;
                              const target = e.shiftKey
                                ? prevCell(
                                    { row: visibleRow, col: origIdx },
                                    rowCount,
                                    colCount,
                                  )
                                : nextCell(
                                    { row: visibleRow, col: origIdx },
                                    rowCount,
                                    colCount,
                                  );
                              void (async () => {
                                const ok = await commitEdit();
                                if (ok && target) setSelectedCell(target);
                              })();
                            }
                          }}
                          className="h-[22px] w-full border-0 bg-transparent px-1.5 font-mono text-[13px] text-[var(--grid-text)] outline-none"
                        />
                      ) : (
                        formatCell(cell)
                      )}
                    </td>
                  );
                })}
                {writable && (
                  <td className="sticky right-0 w-10 bg-[var(--wb-content)] px-1 text-right">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 focus-visible:opacity-100"
                      onClick={() => setPendingDeleteRow(visibleRow)}
                      aria-label="Delete row"
                      title="Delete this row"
                    >
                      <Trash2 />
                    </Button>
                  </td>
                )}
              </tr>
            );
          })}
          {rowWindow.bottomPadPx > 0 && (
            <tr aria-hidden="true" style={{ height: rowWindow.bottomPadPx }}>
              <td colSpan={visibleColumns.length + (writable ? 2 : 1)} />
            </tr>
          )}
          {tab.queryResult.truncated && (
            <tr>
              <td
                colSpan={visibleColumns.length + (writable ? 2 : 1)}
                className="border-t border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-foreground"
              >
                Result truncated at {tab.queryResult.rows.length.toLocaleString()} rows (worker
                row/byte cap). Add a LIMIT — or export via a future incremental path — for the full
                set.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <CellDetailDialog detail={cellDetail} onOpenChange={(o) => !o && setCellDetail(null)} />
      <RowDetailSheet detail={rowDetail} onOpenChange={(o) => !o && setRowDetail(null)} />
      <ConfirmDialog
        open={pendingDeleteRow !== null}
        onOpenChange={(o) => !o && setPendingDeleteRow(null)}
        title="Delete this row?"
        description="This cannot be undone."
        confirmLabel="Delete row"
        onConfirm={() => void confirmDeleteRow()}
      />
    </div>
  );
}

// ─── Sorting ─────────────────────────────────────────────────────────

/**
 * Header-row checkbox that reflects all-visible / partial / none
 * states. Uses Radix's `'indeterminate'` value for the partial
 * state so the box renders the dash glyph.
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

// ─── Cell formatting (shared with export) ───────────────────────────

function formatCell(value: unknown): React.ReactNode {
  if (value === null) return <span className="text-[var(--grid-null)]">NULL</span>;
  if (value === undefined) return <span className="text-[var(--grid-null)]">undef</span>;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  const str = String(value);
  if (str === '') return <span className="text-[var(--grid-null)]">''</span>;
  return str;
}

function cellTitle(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function formatFkTitle(value: unknown): string {
  const s = cellTitle(value);
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

/**
 * SQL-tab empty state actions. Two paths:
 *   1. Browse a table → focuses the sidebar (user can click a table)
 *   2. Write SQL → expands the editor drawer so user can paste/type
 */
function EmptySqlActions() {
  const setEditorExpanded = useSession((s) => s.setEditorExpanded);
  const toggleSidebar = useSession((s) => s.toggleSidebar);
  const sidebarCollapsed = useSession((s) => s.settings.sidebarCollapsed);

  return (
    <div className="flex items-center gap-3">
      <Button
        variant="secondary"
        size="default"
        onClick={() => {
          if (sidebarCollapsed) void toggleSidebar();
        }}
      >
        <Table2 />
        Browse tables
      </Button>
      <span className="text-sm text-muted-foreground">or</span>
      <Button variant="primary" size="default" onClick={() => setEditorExpanded(true)}>
        <Code2 />
        Write SQL
      </Button>
    </div>
  );
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

/**
 * Electron wraps IPC rejections as "Error invoking remote method
 * 'plasma:…': Error: <message>" — show only the database's message.
 */
function cleanIpcError(message: string): string {
  return message.replace(/^Error invoking remote method '[^']+':\s*(?:\w*Error:\s*)?/, '');
}
