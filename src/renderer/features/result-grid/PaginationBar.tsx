import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useActiveTab, useSession } from "@/stores/session";

const PAGE_SIZES = [50, 100, 250, 500, 1000] as const;

/**
 * Bottom bar — stripped down to pagination only. Export, Refresh, Filter,
 * Columns, and duration all live in ResultToolbar above the grid.
 */
export function PaginationBar() {
  const tab = useActiveTab();
  const setPage = useSession((s) => s.setPage);
  const setPageSize = useSession((s) => s.setPageSize);

  if (!tab) return null;
  if (!tab.queryResult || tab.queryError || tab.queryRunState === "running") return null;
  if (tab.queryResult.columns.length === 0) return null;

  const isTable = tab.kind === "table";
  // Table tabs use the real COUNT(*) total; SQL tabs use in-memory rows.
  const totalRows = isTable ? (tab.totalRowCount ?? tab.queryResult.rows.length) : tab.queryResult.rows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / tab.pageSize));
  const safePage = Math.min(tab.page, totalPages - 1);

  const start = totalRows === 0 ? 0 : safePage * tab.pageSize + 1;
  const end = isTable
    ? Math.min(totalRows, start + tab.queryResult.rows.length - 1)
    : Math.min(totalRows, (safePage + 1) * tab.pageSize);

  return (
    <div className="flex h-9 shrink-0 items-center gap-4 border-t border-border bg-background px-4 text-sm text-muted-foreground">
      {/* Row range */}
      <div className="flex items-center gap-1.5 tabular-nums">
        <span className="text-foreground">
          {start.toLocaleString()}
          <span className="px-[3px] text-muted-foreground">–</span>
          {end.toLocaleString()}
        </span>
        <span className="text-muted-foreground">of</span>
        <span className="text-foreground">{tab.countLoading ? "…" : totalRows.toLocaleString()}</span>
      </div>

      <Separator orientation="vertical" className="h-4" />

      {/* Page controls */}
      <div className="flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setPage(0)}
          disabled={safePage === 0}
          aria-label="First page"
          title="First page"
        >
          <ChevronsLeft />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setPage(safePage - 1)}
          disabled={safePage === 0}
          aria-label="Previous page"
          title="Previous page"
        >
          <ChevronLeft />
        </Button>
        <div className="flex items-center gap-1 px-2 tabular-nums text-muted-foreground">
          <span className="text-foreground">{safePage + 1}</span>
          <span className="text-muted-foreground">/</span>
          <span className="text-muted-foreground">{tab.countLoading ? "…" : totalPages.toLocaleString()}</span>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setPage(safePage + 1)}
          disabled={safePage >= totalPages - 1}
          aria-label="Next page"
          title="Next page"
        >
          <ChevronRight />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setPage(totalPages - 1)}
          disabled={safePage >= totalPages - 1}
          aria-label="Last page"
          title="Last page"
        >
          <ChevronsRight />
        </Button>
      </div>

      <div className="flex-1" />

      {/* Rows per page */}
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">rows</span>
        <Select value={String(tab.pageSize)} onValueChange={(v) => setPageSize(Number(v))}>
          <SelectTrigger className="h-6 w-[72px] px-2 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAGE_SIZES.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
