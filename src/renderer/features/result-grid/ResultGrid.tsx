import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, ChevronDown, ChevronUp, Code2, Search, Table2, Trash2, X } from "lucide-react";
import type { ColumnMeta } from "@shared/protocol";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { copyCellToClipboard } from "@/lib/export";
import { formatDuration } from "@/lib/format";
import { BrandMark } from "@/features/app-shell/BrandMark";
import { CellDetailDialog, type CellDetail } from "./CellDetailDialog";
import { RowDetailSheet, type RowDetail } from "./RowDetailSheet";
import { SqlHomePanel } from "./SqlHomePanel";
import { useActiveTab, useSession } from "@/stores/session";

// Stable empty Set used as a fallback when the active tab is null. Using
// a module-level singleton keeps the useEffect dependency reference-stable
// across renders so we don't trip the sticky-column re-measure loop.
const EMPTY_STICKY_SET: ReadonlySet<string> = new Set();

/**
 * Paginated + sortable result grid with keyboard navigation and cell copy.
 *
 *  - Click a header to toggle sort (asc → desc → none)
 *  - Click a cell to select; arrows move selection
 *  - Ctrl/Cmd+C copies the selected cell value
 *  - Long cells truncate with a native tooltip on hover
 *
 * Virtualization is still M3 — this renders all rows in the active page.
 */
export function ResultGrid() {
  const tab = useActiveTab();
  const connectionState = useSession((s) => s.connectionState);
  const setSort = useSession((s) => s.setSort);
  const setSelectedCell = useSession((s) => s.setSelectedCell);
  const setColumnWidth = useSession((s) => s.setColumnWidth);
  const editMode = useSession((s) => s.editMode);
  const updateCell = useSession((s) => s.updateCell);
  const deleteRow = useSession((s) => s.deleteRow);
  const schema = useSession((s) => s.schema);
  const openForeignRow = useSession((s) => s.openForeignRow);

  // Inline cell edit state — local to the grid, only one cell at a time.
  const [editingCell, setEditingCell] = useState<{ row: number; col: number; value: string } | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  // Cell detail viewer — opens on double-click (read-only contexts) or
  // Space on the selected cell. Shows the full, formatted value.
  const [cellDetail, setCellDetail] = useState<CellDetail | null>(null);

  // Row detail drawer — opens on Enter on the selected cell, or on a
  // click of the row-number column. Lays the whole row out vertically.
  const [rowDetail, setRowDetail] = useState<RowDetail | null>(null);

  // In-grid search — Ctrl+F / ⌘F toggles the floating bar. Matches are
  // computed from displayRows (case-insensitive substring). Enter /
  // Shift+Enter cycles through matches and jumps the selected cell.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeMatchIdx, setActiveMatchIdx] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const isTableTab = tab?.kind === "table";
  const writable = Boolean(
    isTableTab &&
    editMode &&
    tab?.tableSchema &&
    tab?.tableName &&
    schema?.columns.some((c) => c.schema === tab.tableSchema && c.table === tab.tableName && c.isPrimaryKey),
  );

  const commitEdit = async () => {
    if (!editingCell) return;
    const { row, col, value } = editingCell;
    setEditError(null);
    try {
      await updateCell(row, col, value);
      setEditingCell(null);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDeleteRow = async (rowIndex: number) => {
    if (!window.confirm("Delete this row? This cannot be undone.")) return;
    setEditError(null);
    try {
      await deleteRow(rowIndex);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err));
    }
  };

  // Compute display rows.
  //
  // Table tabs: the server already returned the sorted + paginated
  // slice, so we render all rows as-is.
  //
  // SQL tabs: we slice client-side and optionally apply a client-side
  // sort on top of the raw result set.
  const displayRows = useMemo(() => {
    if (!tab?.queryResult) return [] as { row: unknown[]; originalIndex: number }[];
    if (tab.kind === "table") {
      return tab.queryResult.rows.map((row, i) => ({ row, originalIndex: i }));
    }
    const withIdx = tab.queryResult.rows.map((row, i) => ({ row, originalIndex: i }));
    if (tab.sortColumn) {
      const { index, direction } = tab.sortColumn;
      withIdx.sort((a, b) => compareCells(a.row[index], b.row[index], direction));
    }
    const start = tab.page * tab.pageSize;
    return withIdx.slice(start, start + tab.pageSize);
  }, [tab?.kind, tab?.queryResult, tab?.sortColumn, tab?.page, tab?.pageSize]);

  const containerRef = useRef<HTMLDivElement>(null);

  // Foreign-key lookup for the current table tab. Keyed by column name,
  // since FK click-through is only supported on table tabs where each
  // column is unambiguously one of the table's own columns. On SQL tabs
  // we'd need to match projection expressions back to source columns,
  // which isn't possible without a SQL parser — skip entirely.
  const fkByColumn = useMemo(() => {
    const m = new Map<string, { refSchema: string; refTable: string; refColumn: string }>();
    if (
      tab?.kind === "table" &&
      tab.tableSchema &&
      tab.tableName &&
      schema?.foreignKeys
    ) {
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
        const str =
          typeof cell === "object" ? JSON.stringify(cell) : String(cell);
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
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        const active = document.activeElement;
        const tag = active?.tagName?.toLowerCase();
        if (tag === "textarea" || (tag === "input" && active !== searchInputRef.current)) {
          return; // let text inputs / Monaco handle their own find
        }
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 0);
      } else if (e.key === "Escape" && searchOpen) {
        setSearchOpen(false);
        setSearchQuery("");
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
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
          position: "sticky",
          left: stickyLefts[colIndex] ?? 0,
          zIndex: baseZ,
          boxShadow: "1px 0 0 0 var(--border)",
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
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: PointerEvent) => {
      const next = Math.max(60, startWidth + (ev.clientX - startX));
      setColumnWidth(colIndex, next);
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  // Keyboard navigation — arrows move the selected cell, Ctrl+C copies
  useEffect(() => {
    if (!tab?.queryResult || tab.queryResult.columns.length === 0) return;
    const handler = (e: KeyboardEvent) => {
      // Only handle keys when the focus is inside the grid (or body)
      const active = document.activeElement;
      const tag = active?.tagName?.toLowerCase();
      if (
        tag === "input" ||
        tag === "textarea" ||
        (active && "isContentEditable" in active && (active as HTMLElement).isContentEditable)
      ) {
        return;
      }
      // Copy
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
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
      // Space opens the cell detail viewer for the current selection.
      if (e.key === " ") {
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
      // Enter opens the row detail drawer for the selected row.
      if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        const pagedRow = displayRows[row];
        if (pagedRow && tab.queryResult) {
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
      if (e.key === "ArrowDown") {
        setSelectedCell({ row: Math.min(maxRow, row + 1), col });
        e.preventDefault();
      } else if (e.key === "ArrowUp") {
        setSelectedCell({ row: Math.max(0, row - 1), col });
        e.preventDefault();
      } else if (e.key === "ArrowRight") {
        setSelectedCell({ row, col: Math.min(maxCol, col + 1) });
        e.preventDefault();
      } else if (e.key === "ArrowLeft") {
        setSelectedCell({ row, col: Math.max(0, col - 1) });
        e.preventDefault();
      } else if (e.key === "Escape") {
        setSelectedCell(null);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [tab?.selectedCell, tab?.queryResult, displayRows, setSelectedCell]);

  // ── Error state ──
  if (tab?.queryError) {
    return (
      <div className="min-h-0 flex-1 overflow-auto bg-card">
        <div className="max-w-4xl p-8">
          <div className="mb-3 font-display text-3xl italic text-destructive">Query error</div>
          <pre className="whitespace-pre-wrap break-words text-base text-foreground">{tab.queryError}</pre>
          {tab.queryErrorSql && (
            <>
              <div className="mt-6 mb-2 text-xs text-muted-foreground">sql sent to server</div>
              <pre className="whitespace-pre-wrap break-words rounded-md border border-border bg-muted p-3 text-sm text-foreground">
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
  if (tab?.queryRunState === "running") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-card">
        <div className="flex flex-col items-center gap-5 text-center">
          <BrandMark className="plasma-loading-mark h-28 w-28 text-foreground" />
          <div className="plasma-loading-caption font-display text-lg italic text-muted-foreground">
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

  // ── Empty state ──
  if (!tab?.queryResult) {
    const connected = connectionState === "connected";
    const isSqlTab = tab?.kind === "sql";
    // For connected SQL tabs with an empty editor, show the home panel
    // instead of a blank pitch — lets the user relaunch a recent query
    // without retyping it or opening the history sheet.
    if (connected && isSqlTab && (tab?.sql.trim() ?? "") === "") {
      return <SqlHomePanel />;
    }
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-card">
        <div className="flex flex-col items-center gap-6 text-center">
          <BrandMark className="h-24 w-24 text-foreground/70" />
          <div className="font-display text-3xl italic text-muted-foreground">
            {connected
              ? isSqlTab
                ? "Select a table, or write a query."
                : "Click a table in the sidebar to preview it."
              : "Connect to a database to get started."}
          </div>

          {connected && isSqlTab && <EmptySqlActions />}
        </div>
      </div>
    );
  }

  // ── Non-SELECT commands ──
  if (tab.queryResult.columns.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-card">
        <div className="text-center">
          <div className="mb-2 font-display text-3xl italic text-foreground">{tab.queryResult.command ?? "OK"}</div>
          <div className="text-sm text-muted-foreground">
            {tab.queryResult.rowCount.toLocaleString()} rows affected · {formatDuration(tab.queryResult.durationMs)}
          </div>
        </div>
      </div>
    );
  }

  const allColumns = tab.queryResult.columns;

  // For SQL tabs the server returns every column the user SELECTed, so
  // hidden-column state is a pure display concern — we filter them out
  // at render time and keep a mapping back to the original column index
  // (used by sticky offsets, sort indicators, cell selection, etc.).
  //
  // For table tabs the hidden list already rewrote the server query, so
  // allColumns only contains visible columns; the map is the identity.
  const visibleColumns: Array<{ col: (typeof allColumns)[number]; originalIndex: number }> =
    tab.kind === "sql"
      ? allColumns
          .map((col, i) => ({ col, originalIndex: i }))
          .filter(({ col }) => !tab.hiddenColumns.has(col.name))
      : allColumns.map((col, i) => ({ col, originalIndex: i }));

  // Unified "sort indicator" — reads from the correct sort source for
  // the current tab kind so the header arrows work in both modes. The
  // index passed in is the *original* column index in the result set.
  const getSortIndicator = (colIndex: number): "asc" | "desc" | null => {
    if (tab.kind === "table") {
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
    <div ref={containerRef} className="relative min-h-0 flex-1 overflow-auto bg-card">
      {editError && (
        <div className="sticky top-0 z-20 border-b border-primary bg-primary/10 px-4 py-2 text-xs text-primary">
          {editError}{" "}
          <button type="button" onClick={() => setEditError(null)} className="ml-2 underline">
            dismiss
          </button>
        </div>
      )}
      {searchOpen && (
        <div className="sticky top-0 z-30 flex justify-end px-3 pt-2">
          <div className="flex items-center gap-1.5 rounded-md border bg-popover px-2 py-1.5 text-xs shadow-md">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Find in results…"
              className="h-5 w-48 border-0 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (e.shiftKey) jumpToMatch(activeMatchIdx - 1);
                  else jumpToMatch(activeMatchIdx + 1);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setSearchOpen(false);
                  setSearchQuery("");
                }
              }}
            />
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {searchQuery
                ? searchMatches.length > 0
                  ? `${activeMatchIdx + 1}/${searchMatches.length}`
                  : "0"
                : ""}
            </span>
            <button
              type="button"
              onClick={() => jumpToMatch(activeMatchIdx - 1)}
              disabled={searchMatches.length === 0}
              className="grid h-5 w-5 place-items-center rounded-sm text-muted-foreground hover:text-foreground disabled:opacity-40"
              aria-label="Previous match"
              title="Previous match (Shift+Enter)"
            >
              <ChevronUp className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => jumpToMatch(activeMatchIdx + 1)}
              disabled={searchMatches.length === 0}
              className="grid h-5 w-5 place-items-center rounded-sm text-muted-foreground hover:text-foreground disabled:opacity-40"
              aria-label="Next match"
              title="Next match (Enter)"
            >
              <ChevronDown className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => {
                setSearchOpen(false);
                setSearchQuery("");
              }}
              className="grid h-5 w-5 place-items-center rounded-sm text-muted-foreground hover:text-foreground"
              aria-label="Close search"
              title="Close (Esc)"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </div>
      )}
      <table className="min-w-full border-collapse font-mono text-xs tabular-nums">
        <thead className="sticky top-0 z-10 bg-card">
          <tr>
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
                    "relative cursor-pointer select-none whitespace-nowrap border-b px-[14px] py-2 text-left transition-colors hover:bg-accent hover:text-accent-foreground",
                    isSticky && "bg-muted",
                  )}
                  style={{
                    fontWeight: 400,
                    minWidth: storedWidth ?? 120,
                    width: storedWidth,
                    ...stickyStyle(origIdx, col.name, 20),
                    ...(isSticky ? { top: 0 } : {}),
                  }}
                  title={`${col.dataTypeName} — click to sort${isSticky ? " · pinned" : ""}`}
                >
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs text-muted-foreground">{col.dataTypeName}</span>
                    <span className="text-sm text-foreground" style={{ fontWeight: 500 }}>
                      {col.name || <span className="text-muted-foreground">?column?</span>}
                    </span>
                    {sortDir && <span className="text-xs text-primary">{sortDir === "asc" ? "↑" : "↓"}</span>}
                  </div>
                  {/* Resize handle — thin strip at the right edge. Wide
                      hit target, narrow visual; turns primary on hover. */}
                  <div
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={`Resize ${col.name}`}
                    onPointerDown={(e) => handleResizeStart(e, origIdx)}
                    onClick={(e) => e.stopPropagation()}
                    className="group/resize absolute right-0 top-0 z-10 flex h-full w-2 cursor-col-resize items-stretch justify-center"
                  >
                    <div className="h-full w-px bg-transparent transition-colors group-hover/resize:bg-primary group-active/resize:bg-primary" />
                  </div>
                </th>
              );
            })}
            {writable && <th className="sticky right-0 w-10 border-b bg-card" aria-label="row actions" />}
          </tr>
        </thead>
        <tbody>
          {displayRows.map((entry, visibleRow) => {
            const rowSelected = tab.selectedCell?.row === visibleRow;
            return (
              <tr
                // biome-ignore lint/suspicious/noArrayIndexKey: stable per-query
                key={`row-${visibleRow}-${entry.originalIndex}`}
                className={cn(
                  "group/row transition-colors",
                  rowSelected ? "bg-primary/15" : "hover:bg-accent hover:text-accent-foreground",
                )}
              >
                {visibleColumns.map(({ col, originalIndex: origIdx }) => {
                  const cell = entry.row[origIdx];
                  const cellSelected = tab.selectedCell?.row === visibleRow && tab.selectedCell?.col === origIdx;
                  const isEditing = editingCell?.row === visibleRow && editingCell?.col === origIdx;
                  const colName = col.name;
                  const isSticky = stickySet.has(colName);
                  const isMatch = matchSet.has(`${visibleRow}:${origIdx}`);
                  const activeMatch = searchMatches[activeMatchIdx];
                  const isActiveMatch = isMatch && activeMatch?.row === visibleRow && activeMatch?.col === origIdx;
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
                            value: cell === null || cell === undefined ? "" : String(cell),
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
                        "group/cell relative h-[34px] max-w-[480px] whitespace-nowrap border-b border-border px-[18px] text-foreground",
                        !isEditing && "cursor-cell truncate",
                        cellClass(col),
                        cellSelected && !isEditing && "outline outline-2 -outline-offset-2 outline-accent",
                        isEditing && "bg-card p-0 outline outline-2 -outline-offset-2 outline-accent",
                        isSticky &&
                          (rowSelected
                            ? "bg-primary/15"
                            : "bg-muted group-hover/row:bg-accent group-hover/row:text-accent-foreground"),
                        // Search match highlights — passive matches get a
                        // primary tint, the "current" match gets a stronger
                        // tint so the user can see where the jump landed.
                        isMatch && !isActiveMatch && "bg-primary/10",
                        isActiveMatch && "bg-primary/30 outline outline-1 -outline-offset-1 outline-primary",
                        // Make room for the FK arrow so long values don't
                        // slide underneath the button.
                        hasFk && !isEditing && "pr-7",
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
                          className="absolute right-1 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded-sm text-muted-foreground opacity-0 transition-all hover:bg-primary hover:text-primary-foreground group-hover/cell:opacity-100"
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
                            if (e.key === "Enter") {
                              e.preventDefault();
                              void commitEdit();
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              setEditingCell(null);
                            }
                          }}
                          className="h-[32px] w-full border-0 bg-transparent px-[18px] font-mono text-xs text-foreground outline-none"
                        />
                      ) : (
                        formatCell(cell)
                      )}
                    </td>
                  );
                })}
                {writable && (
                  <td className="sticky right-0 w-10 border-b border-border bg-card px-1 text-right">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="opacity-0 transition-opacity group-hover/row:opacity-100"
                      onClick={() => void handleDeleteRow(visibleRow)}
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
        </tbody>
      </table>
      <CellDetailDialog detail={cellDetail} onOpenChange={(o) => !o && setCellDetail(null)} />
      <RowDetailSheet detail={rowDetail} onOpenChange={(o) => !o && setRowDetail(null)} />
    </div>
  );
}

// ─── Sorting ─────────────────────────────────────────────────────────

function compareCells(a: unknown, b: unknown, direction: "asc" | "desc"): number {
  const mul = direction === "asc" ? 1 : -1;
  const na = a === null || a === undefined;
  const nb = b === null || b === undefined;
  if (na && nb) return 0;
  if (na) return 1; // nulls sort last regardless of direction
  if (nb) return -1;
  // Numeric fast path
  if (typeof a === "number" && typeof b === "number") return (a - b) * mul;
  // Compare as strings for everything else (matches pg's display order
  // well enough for most types; M3 can use type-aware comparators).
  const sa = String(a);
  const sb = String(b);
  if (sa < sb) return -1 * mul;
  if (sa > sb) return 1 * mul;
  return 0;
}

// ─── Cell formatting (shared with export) ───────────────────────────

function formatCell(value: unknown): React.ReactNode {
  if (value === null) return <span className="text-muted-foreground">␀</span>;
  if (value === undefined) return <span className="text-muted-foreground">undef</span>;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  const str = String(value);
  if (str === "") return <span className="text-muted-foreground">''</span>;
  return str;
}

function cellTitle(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
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
      <span className="font-display text-sm italic text-muted-foreground">or</span>
      <Button variant="primary" size="default" onClick={() => setEditorExpanded(true)}>
        <Code2 />
        Write SQL
      </Button>
    </div>
  );
}

function cellClass(col: ColumnMeta | undefined): string {
  if (!col) return "";
  const t = col.dataTypeName;
  if (t === "int2" || t === "int4" || t === "int8" || t === "float4" || t === "float8" || t === "numeric") {
    return "font-medium text-type-num text-right";
  }
  if (t === "date" || t === "timestamp" || t === "timestamptz" || t === "time" || t === "interval") {
    return "text-muted-foreground";
  }
  if (t === "bool") return "text-type-bool";
  if (t === "json" || t === "jsonb") return "text-type-json";
  return "";
}
