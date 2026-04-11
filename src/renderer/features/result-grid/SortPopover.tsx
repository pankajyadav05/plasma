import { ArrowDown, ArrowUp, ArrowUpDown, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useActiveTab, useSession } from "@/stores/session";

/**
 * Sort popover for table tabs. Lists all columns with a clickable
 * sort direction cycle (none → asc → desc → none). Supports multiple
 * sort keys ordered by insertion — first click becomes primary sort,
 * subsequent clicks append as secondary sort keys.
 */
export function SortPopover() {
  const tab = useActiveTab();
  const schema = useSession((s) => s.schema);

  if (!tab || tab.kind !== "table" || !tab.tableSchema || !tab.tableName) return null;

  const allColumns =
    schema?.columns
      .filter((c) => c.schema === tab.tableSchema && c.table === tab.tableName)
      .sort((a, b) => a.ordinal - b.ordinal) ?? [];

  const sortList = tab.tableSort;
  const sortMap = new Map(sortList.map((s, i) => [s.column, { ...s, index: i }]));

  const cycleSort = (column: string) => {
    const current = sortMap.get(column);
    let nextList: typeof sortList;
    if (!current) {
      // Add as new sort key at the end
      nextList = [...sortList, { column, direction: "asc" as const }];
    } else if (current.direction === "asc") {
      // Flip to desc in place
      nextList = sortList.map((s) => (s.column === column ? { ...s, direction: "desc" as const } : s));
    } else {
      // Remove
      nextList = sortList.filter((s) => s.column !== column);
    }
    // Patch the tab directly and re-run. Using the store's internal
    // patchActiveTab is not exposed, so we manually update via set().
    useSession.setState((state) => ({
      tabs: state.tabs.map((t) => (t.id === tab.id ? { ...t, tableSort: nextList, page: 0 } : t)),
    }));
    void useSession.getState().refreshTable();
  };

  const clearSort = () => {
    useSession.setState((state) => ({
      tabs: state.tabs.map((t) => (t.id === tab.id ? { ...t, tableSort: [], page: 0 } : t)),
    }));
    void useSession.getState().refreshTable();
  };

  const removeSort = (column: string) => {
    const nextList = sortList.filter((s) => s.column !== column);
    useSession.setState((state) => ({
      tabs: state.tabs.map((t) => (t.id === tab.id ? { ...t, tableSort: nextList, page: 0 } : t)),
    }));
    void useSession.getState().refreshTable();
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant={sortList.length > 0 ? "outline" : "ghost"}
          size="xs"
          className={sortList.length > 0 ? "border-accent text-accent" : ""}
        >
          <ArrowUpDown />
          Sort
          {sortList.length > 0 && (
            <span className="rounded-sm bg-accent px-1 text-xs leading-none py-0.5 text-paper">{sortList.length}</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom" className="w-96 p-0">
        <div className="flex items-center justify-between border-b border-border-soft px-4 py-2.5">
          <h3 className="font-mono text-xs uppercase text-ink-muted" style={{ letterSpacing: "0.10em" }}>
            Sort
          </h3>
          {sortList.length > 0 && (
            <Button variant="ghost" size="xs" onClick={clearSort} className="text-ink-muted">
              <Trash2 />
              Clear
            </Button>
          )}
        </div>

        {/* Active sort keys — shown in order */}
        {sortList.length > 0 && (
          <div className="border-b border-border-soft">
            {sortList.map((s, i) => (
              <div key={s.column} className="flex items-center gap-2 px-4 py-1.5 font-mono text-xs">
                <span className="w-4 shrink-0 text-xs text-ink-muted">{i + 1}.</span>
                <span className="flex-1 truncate text-ink">{s.column}</span>
                {s.direction === "asc" ? (
                  <ArrowUp className="h-3 w-3 shrink-0 text-accent" />
                ) : (
                  <ArrowDown className="h-3 w-3 shrink-0 text-accent" />
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

        {/* All columns — click to cycle none → asc → desc → none */}
        <div className="max-h-[320px] overflow-y-auto py-1">
          <div
            className="px-4 pb-1 pt-2 font-mono text-xs uppercase text-ink-muted"
            style={{ letterSpacing: "0.08em" }}
          >
            Click a column to sort
          </div>
          {allColumns.map((col) => {
            const current = sortMap.get(col.name);
            return (
              <button
                key={col.name}
                type="button"
                onClick={() => cycleSort(col.name)}
                className="flex w-full items-center gap-2 px-4 py-1.5 text-left font-mono text-xs text-ink transition-colors hover:bg-[var(--bg-hover)]"
              >
                <span className="flex-1 truncate font-semibold">{col.name}</span>
                <span className="shrink-0 font-mono text-xs text-ink-muted">{col.dataType}</span>
                <span className="w-3 shrink-0">
                  {current?.direction === "asc" && <ArrowUp className="h-3 w-3 text-accent" />}
                  {current?.direction === "desc" && <ArrowDown className="h-3 w-3 text-accent" />}
                </span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
