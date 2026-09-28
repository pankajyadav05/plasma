import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/cn';
import { type TableViewMode, useActiveTab, useSession } from '@/stores/session';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';

const PAGE_SIZES = [50, 100, 250, 500, 1000] as const;

/**
 * Bottom bar. Table tabs get the Data · Structure · DDL view switch at
 * the lower-left (TablePlus layout), then row range + paging. Export,
 * Refresh, Filter, Columns, and duration live in ResultToolbar above
 * the grid.
 */
export function PaginationBar() {
  const tab = useActiveTab();
  const setPage = useSession((s) => s.setPage);
  const setPageSize = useSession((s) => s.setPageSize);
  const setTabViewMode = useSession((s) => s.setTabViewMode);

  if (!tab) return null;

  // Structure / DDL views of a table tab — show only the switch, no pagination.
  if (tab.kind === 'table' && tab.viewMode !== 'data') {
    return (
      <div className="flex h-9 shrink-0 items-center gap-2 border-t border-border bg-background px-2 text-sm">
        <ViewModeSwitch viewMode={tab.viewMode} onChange={setTabViewMode} />
      </div>
    );
  }

  if (!tab.queryResult || tab.queryError || tab.queryRunState === 'running') {
    if (tab.kind === 'table') {
      // Loading / error states still show the toggle so the user can
      // bail out to Definition view without waiting for the query.
      return (
        <div className="flex h-9 shrink-0 items-center gap-2 border-t border-border bg-background px-2 text-sm">
          <ViewModeSwitch viewMode={tab.viewMode} onChange={setTabViewMode} />
        </div>
      );
    }
    return null;
  }
  if (tab.queryResult.columns.length === 0) return null;

  const isTable = tab.kind === 'table';
  // Table tabs use the real COUNT(*) total; SQL tabs use in-memory rows.
  const totalRows = isTable
    ? (tab.totalRowCount ?? tab.queryResult.rows.length)
    : tab.queryResult.rows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / tab.pageSize));
  const safePage = Math.min(tab.page, totalPages - 1);

  const start = totalRows === 0 ? 0 : safePage * tab.pageSize + 1;
  const end = isTable
    ? Math.min(totalRows, start + tab.queryResult.rows.length - 1)
    : Math.min(totalRows, (safePage + 1) * tab.pageSize);

  const isEstimate = isTable && tab.totalRowCountIsEstimate;

  return (
    <div
      className={cn(
        'flex h-9 shrink-0 items-center gap-4 overflow-hidden border-t border-border bg-background text-sm text-muted-foreground',
        isTable ? 'pl-2 pr-4' : 'px-4',
      )}
    >
      {isTable && (
        <>
          <ViewModeSwitch viewMode={tab.viewMode} onChange={setTabViewMode} />
          <Separator orientation="vertical" className="h-4" />
        </>
      )}

      {/* Row range */}
      <div className="flex shrink-0 items-center gap-1.5 whitespace-nowrap tabular-nums">
        <span className="text-foreground">
          {start.toLocaleString()}
          <span className="px-[3px] text-muted-foreground">–</span>
          {end.toLocaleString()}
        </span>
        <span className="text-muted-foreground">of</span>
        <span className="text-foreground">
          {tab.countLoading ? '…' : totalRows.toLocaleString()}
        </span>
        {isEstimate && (
          <span
            className="ml-1 rounded-sm border border-border px-1 py-0.5 font-display text-[10px] italic text-muted-foreground"
            title="Approximate count from pg_class.reltuples — refreshes after ANALYZE / autovacuum"
          >
            estimated
          </span>
        )}
      </div>

      <Separator orientation="vertical" className="h-4" />

      {/* Page controls */}
      <div className="flex shrink-0 items-center gap-0.5">
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
          <span className="text-muted-foreground">
            {tab.countLoading ? '…' : totalPages.toLocaleString()}
          </span>
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
        <span className="text-muted-foreground max-[1200px]:hidden">rows</span>
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

const VIEW_MODES: Array<{ mode: TableViewMode; label: string; title: string }> = [
  { mode: 'data', label: 'Data', title: 'Rows' },
  { mode: 'structure', label: 'Structure', title: 'Columns, constraints and indexes' },
  { mode: 'definition', label: 'DDL', title: 'CREATE TABLE definition' },
];

/**
 * Segmented Data | Structure | DDL switch. Active segment gets a 2px
 * accent underline instead of a filled pill.
 */
function ViewModeSwitch({
  viewMode,
  onChange,
}: {
  viewMode: TableViewMode;
  onChange: (m: TableViewMode) => void;
}) {
  return (
    <div
      className="flex h-7 shrink-0 items-stretch overflow-hidden rounded-md border border-border"
      role="tablist"
      aria-label="Table view"
    >
      {VIEW_MODES.map((m) => (
        <ToggleSegment
          key={m.mode}
          active={viewMode === m.mode}
          label={m.label}
          title={m.title}
          onClick={() => onChange(m.mode)}
        />
      ))}
    </div>
  );
}

function ToggleSegment({
  active,
  label,
  title,
  onClick,
}: {
  active: boolean;
  label: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      title={title}
      className={cn(
        'relative border-r border-border px-3 text-xs transition-colors last:border-r-0',
        active
          ? 'bg-card font-medium text-foreground'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
      {active && <span className="absolute inset-x-2 bottom-0 h-[2px] bg-primary" aria-hidden />}
    </button>
  );
}
