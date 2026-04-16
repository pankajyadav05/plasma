import { ArrowDown, ArrowUp, ArrowUpDown, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useActiveTab, useSession } from "@/stores/session";

/**
 * Sort popover. Behaves slightly differently per tab kind:
 *
 *   table tab → multi-column server-side sort. Clicking a column
 *               cycles none → asc → desc → none and appends to the
 *               existing sort key list, triggering a query re-run.
 *   SQL tab   → single-column client-side sort keyed by column index.
 *               Clicking a column cycles none → asc → desc → none on
 *               the one active sort column.
 *
 * Column list comes from the table schema (table tabs) or the current
 * query result (SQL tabs).
 */
export function SortPopover() {
  const tab = useActiveTab();
  const schema = useSession((s) => s.schema);

  if (!tab) return null;

  const isTable = tab.kind === "table";

  const allColumns: Array<{ name: string; dataType: string }> = isTable
    ? tab.tableSchema && tab.tableName
      ? (schema?.columns
          .filter((c) => c.schema === tab.tableSchema && c.table === tab.tableName)
          .sort((a, b) => a.ordinal - b.ordinal)
          .map((c) => ({ name: c.name, dataType: c.dataType })) ?? [])
      : []
    : (tab.queryResult?.columns ?? []).map((c) => ({
        name: c.name,
        dataType: c.dataTypeName,
      }));

  if (allColumns.length === 0) return null;

  // ── Table tab state ──
  const sortList = isTable ? tab.tableSort : [];
  const sortMap = new Map(sortList.map((s, i) => [s.column, { ...s, index: i }]));

  // ── SQL tab state ──
  const sqlSortIndex = !isTable ? (tab.sortColumn?.index ?? null) : null;
  const sqlSortDirection = !isTable ? (tab.sortColumn?.direction ?? null) : null;

  const activeCount = isTable ? sortList.length : sqlSortIndex !== null ? 1 : 0;

  const cycleSortTable = (column: string) => {
    const current = sortMap.get(column);
    let nextList: typeof sortList;
    if (!current) {
      nextList = [...sortList, { column, direction: "asc" as const }];
    } else if (current.direction === "asc") {
      nextList = sortList.map((s) => (s.column === column ? { ...s, direction: "desc" as const } : s));
    } else {
      nextList = sortList.filter((s) => s.column !== column);
    }
    useSession.setState((state) => ({
      tabs: state.tabs.map((t) => (t.id === tab.id ? { ...t, tableSort: nextList, page: 0 } : t)),
    }));
    void useSession.getState().refreshTable();
  };

  const cycleSortSql = (colIndex: number) => {
    let next: { index: number; direction: "asc" | "desc" } | null;
    if (sqlSortIndex !== colIndex) {
      next = { index: colIndex, direction: "asc" };
    } else if (sqlSortDirection === "asc") {
      next = { index: colIndex, direction: "desc" };
    } else {
      next = null;
    }
    useSession.setState((state) => ({
      tabs: state.tabs.map((t) => (t.id === tab.id ? { ...t, sortColumn: next, page: 0 } : t)),
    }));
  };

  const clearSort = () => {
    if (isTable) {
      useSession.setState((state) => ({
        tabs: state.tabs.map((t) => (t.id === tab.id ? { ...t, tableSort: [], page: 0 } : t)),
      }));
      void useSession.getState().refreshTable();
    } else {
      useSession.setState((state) => ({
        tabs: state.tabs.map((t) => (t.id === tab.id ? { ...t, sortColumn: null, page: 0 } : t)),
      }));
    }
  };

  const removeSort = (column: string) => {
    const nextList = sortList.filter((s) => s.column !== column);
    useSession.setState((state) => ({
      tabs: state.tabs.map((t) => (t.id === tab.id ? { ...t, tableSort: nextList, page: 0 } : t)),
    }));
    void useSession.getState().refreshTable();
  };

  const directionFor = (colName: string, colIndex: number): "asc" | "desc" | null => {
    if (isTable) {
      return sortMap.get(colName)?.direction ?? null;
    }
    if (sqlSortIndex === colIndex) return sqlSortDirection;
    return null;
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant={activeCount > 0 ? "outline" : "ghost"}
          size="xs"
          className={activeCount > 0 ? "border-primary text-primary" : ""}
        >
          <ArrowUpDown />
          Sort
          {activeCount > 0 && (
            <span className="rounded-sm bg-primary px-1 text-xs leading-none py-0.5 text-background">
              {activeCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom" className="w-96 p-0">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <h3 className="text-xs text-muted-foreground">
            Sort {isTable ? "" : "(client-side)"}
          </h3>
          {activeCount > 0 && (
            <Button variant="ghost" size="xs" onClick={clearSort} className="text-muted-foreground">
              <Trash2 />
              Clear
            </Button>
          )}
        </div>

        {/* Active sort keys — table tab only (multi-col) */}
        {isTable && sortList.length > 0 && (
          <div className="border-b border-border">
            {sortList.map((s, i) => (
              <div key={s.column} className="flex items-center gap-2 px-4 py-1.5 text-xs">
                <span className="w-4 shrink-0 text-xs text-muted-foreground">{i + 1}.</span>
                <span className="flex-1 truncate text-foreground">{s.column}</span>
                {s.direction === "asc" ? (
                  <ArrowUp className="h-3 w-3 shrink-0 text-primary" />
                ) : (
                  <ArrowDown className="h-3 w-3 shrink-0 text-primary" />
                )}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="h-5 w-5 shrink-0"
                  onClick={() => removeSort(s.column)}
                  aria-label={`Remove sort on ${s.column}`}
                >
                  <X />
                </Button>
              </div>
            ))}
          </div>
        )}

        <div className="max-h-[320px] overflow-y-auto py-1">
          <div className="px-4 pb-1 pt-2 text-xs text-muted-foreground">
            Click a column to sort
          </div>
          {allColumns.map((col, idx) => {
            const direction = directionFor(col.name, idx);
            return (
              <button
                key={`${col.name}-${idx}`}
                type="button"
                onClick={() => (isTable ? cycleSortTable(col.name) : cycleSortSql(idx))}
                className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <span className="flex-1 truncate font-semibold">{col.name || "?column?"}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{col.dataType}</span>
                <span className="w-3 shrink-0">
                  {direction === "asc" && <ArrowUp className="h-3 w-3 text-primary" />}
                  {direction === "desc" && <ArrowDown className="h-3 w-3 text-primary" />}
                </span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
