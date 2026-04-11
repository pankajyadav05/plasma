import { useEffect, useMemo, useRef } from "react";
import { Code2, Table2 } from "lucide-react";
import type { ColumnMeta, QueryResult } from "@shared/protocol";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { copyCellToClipboard } from "@/lib/export";
import { useActiveTab, useSession } from "@/stores/session";

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
      <div className="min-h-0 flex-1 overflow-auto bg-paper-canvas">
        <div className="max-w-4xl p-8">
          <div className="mb-2 font-display text-xl italic text-accent">query error</div>
          <pre className="whitespace-pre-wrap break-words font-mono text-base text-ink">{tab.queryError}</pre>
        </div>
      </div>
    );
  }

  // ── Loading state ──
  if (tab?.queryRunState === "running") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-paper-canvas">
        <div className="relative h-0.5 w-64 overflow-hidden bg-border-soft">
          <div className="absolute inset-y-0 left-0 w-1/3 animate-[slide_1.4s_ease-in-out_infinite] bg-accent" />
        </div>
        <style>{`
          @keyframes slide {
            0% { transform: translateX(-100%); }
            100% { transform: translateX(300%); }
          }
        `}</style>
      </div>
    );
  }

  // ── Empty state ──
  if (!tab?.queryResult) {
    const connected = connectionState === "connected";
    const isSqlTab = tab?.kind === "sql";
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-paper-canvas">
        <div className="flex flex-col items-center gap-6 text-center">
          <img
            src="/plasma-mark.svg"
            alt=""
            aria-hidden
            className="h-24 w-24 opacity-60 select-none"
            draggable={false}
          />
          <div className="font-display text-2xl italic text-ink-muted">
            {connected
              ? isSqlTab
                ? "select a table or write a SQL query"
                : "click a table in the sidebar to preview it"
              : "connect to a database to get started"}
          </div>

          {connected && isSqlTab && <EmptySqlActions />}
        </div>
      </div>
    );
  }

  // ── Non-SELECT commands ──
  if (tab.queryResult.columns.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-paper-canvas">
        <div className="text-center">
          <div className="mb-2 font-display text-xl italic text-ink">{tab.queryResult.command ?? "OK"}</div>
          <div className="font-mono text-sm text-ink-muted">
            {tab.queryResult.rowCount.toLocaleString()} rows affected · {tab.queryResult.durationMs} ms
          </div>
        </div>
      </div>
    );
  }

  const columns = tab.queryResult.columns;

  // Unified "sort indicator" — reads from the correct sort source for
  // the current tab kind so the header arrows work in both modes.
  const getSortIndicator = (colIndex: number): "asc" | "desc" | null => {
    if (tab.kind === "table") {
      const col = columns[colIndex];
      if (!col) return null;
      const match = tab.tableSort.find((s) => s.column === col.name);
      return match?.direction ?? null;
    }
    if (tab.sortColumn?.index === colIndex) return tab.sortColumn.direction;
    return null;
  };

  return (
    <div ref={containerRef} className="min-h-0 flex-1 overflow-auto bg-paper-canvas">
      <table className="min-w-full border-collapse font-mono text-base tabular-nums">
        <thead className="sticky top-0 z-10 bg-paper-canvas">
          <tr>
            {columns.map((col, i) => {
              const sortDir = getSortIndicator(i);
              return (
                <th
                  key={`${col.name}-${i}`}
                  onClick={() => setSort(i)}
                  className="cursor-pointer select-none whitespace-nowrap border-b-2 border-border-strong px-[14px] py-2 text-left transition-colors hover:bg-[var(--bg-hover)]"
                  style={{ fontWeight: 400, minWidth: 120 }}
                  title={`${col.dataTypeName} — click to sort`}
                >
                  {/* Single-line header: type inline before name, sort arrow inline */}
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-xs uppercase text-ink-muted" style={{ letterSpacing: "0.06em" }}>
                      {col.dataTypeName}
                    </span>
                    <span className="font-display text-[15px] italic text-ink" style={{ fontWeight: 500 }}>
                      {col.name || <span className="text-ink-disabled">?column?</span>}
                    </span>
                    {sortDir && (
                      <span className="font-mono text-xs not-italic text-accent">{sortDir === "asc" ? "↑" : "↓"}</span>
                    )}
                  </div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {displayRows.map((entry, visibleRow) => {
            const rowSelected = tab.selectedCell?.row === visibleRow;
            return (
              <tr
                // biome-ignore lint/suspicious/noArrayIndexKey: stable per-query
                key={`row-${visibleRow}-${entry.originalIndex}`}
                className={cn("transition-colors", rowSelected ? "bg-paper-selected" : "hover:bg-[var(--bg-hover)]")}
              >
                {entry.row.map((cell, j) => {
                  const cellSelected = tab.selectedCell?.row === visibleRow && tab.selectedCell?.col === j;
                  return (
                    <td
                      key={`${visibleRow}-${j}`}
                      onClick={() => setSelectedCell({ row: visibleRow, col: j })}
                      onDoubleClick={() => {
                        void copyCellToClipboard(cell);
                      }}
                      className={cn(
                        "h-[34px] max-w-[480px] cursor-cell truncate whitespace-nowrap border-b border-border-soft px-[18px] text-ink",
                        cellClass(columns[j]),
                        cellSelected && "outline outline-2 -outline-offset-2 outline-accent",
                      )}
                      title={cellTitle(cell)}
                    >
                      {formatCell(cell)}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
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
  if (value === null) return <span className="italic text-ink-disabled">␀</span>;
  if (value === undefined) return <span className="italic text-ink-disabled">undef</span>;
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
  if (str === "") return <span className="italic text-ink-disabled">''</span>;
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
      <span className="font-display text-sm italic text-ink-disabled">or</span>
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
    return "text-ink-2";
  }
  if (t === "bool") return "text-type-bool";
  if (t === "json" || t === "jsonb") return "text-type-json";
  return "";
}
