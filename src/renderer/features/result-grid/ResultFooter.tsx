import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { IconButton, MenuItem, Pill, Segmented } from '@/components/ui/workbench';
import { MockDataDialog } from '@/features/mock-data/MockDataDialog';
import { PgVectorDialog } from '@/features/pgvector/PgVectorDialog';
import { PostGisDialog } from '@/features/postgis/PostGisDialog';
import { cn } from '@/lib/cn';
import { formatDuration } from '@/lib/format';
import { type TableViewMode, useActiveTab, useSession } from '@/stores/session';
import { type ResultView, useWorkbench } from '@/stores/workbench';
import type { QueryResult } from '@shared/protocol';
import {
  Brain,
  ChevronLeft,
  ChevronRight,
  Map as MapIcon,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { ColumnsPopover } from './ColumnsPopover';
import { ExportPopover } from './ExportMenu';
import { InsertRowDialog } from './InsertRowDialog';
import { useNoticeCount } from './ResultTabs';
import { SortPopover } from './SortPopover';

const PAGE_SIZES = [50, 100, 300, 500, 1000] as const;

/**
 * The single bar under every result — TablePlus's footer:
 *
 *   SQL tab    [Data|Message|Chart] 243 ms        1 row        [⌕] [Columns] [Sort] [⋯] [Export…]
 *   table tab  [Data|Structure|DDL] [+ Row]   ‹ 1–300 of 12,408 › ⚙   [⌕] [Columns] [Sort] [⋯] [Export…] [↻]
 *
 * Replaces the old result toolbar, messages strip and pagination bar.
 */
export function ResultFooter() {
  const tab = useActiveTab();
  const editMode = useSession((s) => s.editMode);
  const connectionReadOnly = useSession((s) => Boolean(s.activeConfig?.readOnly));
  const setTabViewMode = useSession((s) => s.setTabViewMode);
  const refreshTable = useSession((s) => s.refreshTable);
  const resultView = useWorkbench((s) => (tab ? (s.resultViews[tab.id] ?? 'data') : 'data'));
  const setResultView = useWorkbench((s) => s.setResultView);
  const noticeCount = useNoticeCount();

  const [exportOpen, setExportOpen] = useState(false);
  const [insertOpen, setInsertOpen] = useState(false);
  const [mockOpen, setMockOpen] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [vectorOpen, setVectorOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  // File → Export Results (native menu) → save the active result.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ kind: 'csv' | 'json' }>).detail;
      const current = useSession.getState();
      const activeT = current.tabs.find((t) => t.id === current.activeTabId);
      if (!activeT?.queryResult) return;
      void window.plasma.export.save({
        format: detail.kind,
        defaultPath: activeT.title.replace(/.sql$/i, ''),
        columns: activeT.queryResult.columns,
        rows: activeT.queryResult.rows,
      });
    };
    window.addEventListener('plasma:export', handler);
    return () => window.removeEventListener('plasma:export', handler);
  }, []);

  if (!tab) return null;

  const isTable = tab.kind === 'table';
  const result = tab.queryResult;
  const hasRows = Boolean(result && result.columns.length > 0 && !tab.queryError);
  const running = tab.queryRunState === 'running';
  const tableData = isTable && tab.viewMode === 'data';
  const showDataTools = hasRows && (isTable ? tableData : resultView === 'data');
  const canWrite = isTable && editMode && !connectionReadOnly;
  const hasGeo = Boolean(
    hasRows && result?.columns.some((c) => /geometry|geography/i.test(c.dataTypeName)),
  );
  const hasVector = Boolean(hasRows && result?.columns.some((c) => /vector/i.test(c.dataTypeName)));
  const moreItems = hasGeo || hasVector || canWrite;

  return (
    <div
      className="flex h-9 shrink-0 items-center gap-1.5 border-t border-[var(--wb-separator)] bg-[var(--wb-content)] px-2"
      data-testid="result-footer"
    >
      {isTable ? (
        <Segmented<TableViewMode>
          ariaLabel="Table view"
          variant="track"
          value={tab.viewMode}
          onChange={setTabViewMode}
          options={[
            { value: 'data', label: 'Data', title: 'Rows' },
            { value: 'structure', label: 'Structure', title: 'Columns, constraints, indexes' },
            { value: 'definition', label: 'DDL', title: 'CREATE TABLE definition' },
          ]}
        />
      ) : (
        <Segmented<ResultView>
          ariaLabel="Result view"
          variant="track"
          value={resultView}
          onChange={(v) => setResultView(tab.id, v)}
          options={[
            { value: 'data', label: 'Data' },
            {
              value: 'message',
              label: (
                <>
                  Message
                  {(noticeCount > 0 || tab.queryError) && (
                    <span
                      className={cn(
                        'h-1.5 w-1.5 rounded-full',
                        tab.queryError ? 'bg-destructive' : 'bg-amber-500',
                      )}
                    />
                  )}
                </>
              ),
            },
            { value: 'chart', label: 'Chart', disabled: !hasRows },
          ]}
        />
      )}

      {canWrite && tableData && (
        <Pill onClick={() => setInsertOpen(true)} title="Insert a new row">
          <Plus />
          Row
        </Pill>
      )}

      {!isTable && result && !running && (
        <span className="ml-1.5 shrink-0 text-[13px] tabular-nums text-[var(--wb-text-2)]">
          {formatDuration(
            tab.queryResults.length > 1
              ? tab.queryResults.reduce((sum: number, r: QueryResult) => sum + r.durationMs, 0)
              : result.durationMs,
          )}
        </span>
      )}
      {running && (
        <span className="ml-1.5 shrink-0 text-[13px] text-[var(--wb-text-2)]">Running…</span>
      )}

      <div className="flex min-w-0 flex-1 justify-center">
        {tableData || (!isTable && hasRows && resultView === 'data') ? <RowRange /> : null}
      </div>

      {showDataTools && (
        <>
          <IconButton
            label="Find in results (⌘F)"
            onClick={() => window.dispatchEvent(new CustomEvent('plasma:grid-find'))}
          >
            <Search />
          </IconButton>
          <ColumnsPopover />
          <SortPopover />
          {moreItems && (
            <Popover open={moreOpen} onOpenChange={setMoreOpen}>
              <PopoverTrigger asChild>
                <IconButton label="More">
                  <MoreHorizontal />
                </IconButton>
              </PopoverTrigger>
              <PopoverContent align="end" side="top" sideOffset={6} className="w-[220px] p-1" role="menu">
                {hasGeo && (
                  <MenuItem
                    icon={<MapIcon />}
                    label="Map preview (PostGIS)"
                    onClick={() => {
                      setMoreOpen(false);
                      setMapOpen(true);
                    }}
                  />
                )}
                {hasVector && (
                  <MenuItem
                    icon={<Brain />}
                    label="Find similar (pgvector)"
                    onClick={() => {
                      setMoreOpen(false);
                      setVectorOpen(true);
                    }}
                  />
                )}
                {canWrite && (
                  <MenuItem
                    icon={<Sparkles />}
                    label="Generate mock rows…"
                    onClick={() => {
                      setMoreOpen(false);
                      setMockOpen(true);
                    }}
                  />
                )}
              </PopoverContent>
            </Popover>
          )}
          {result && (
            <ExportPopover
              open={exportOpen}
              onOpenChange={setExportOpen}
              result={result}
              selected={tab.selectedRows}
              filename={tab.title.replace(/\.sql$/i, '')}
            />
          )}
        </>
      )}

      {isTable && (
        <IconButton label="Refresh" disabled={running} onClick={() => void refreshTable()}>
          <RefreshCw className={running ? 'animate-spin' : ''} />
        </IconButton>
      )}

      <InsertRowDialog open={insertOpen} onOpenChange={setInsertOpen} />
      <MockDataDialog open={mockOpen} onOpenChange={setMockOpen} />
      <PostGisDialog result={result} open={mapOpen} onOpenChange={setMapOpen} />
      <PgVectorDialog result={result} open={vectorOpen} onOpenChange={setVectorOpen} />
    </div>
  );
}

/**
 * Row range + paging. Table tabs page on the server (real COUNT or
 * estimate); SQL tabs page the in-memory result.
 */
function RowRange() {
  const tab = useActiveTab();
  const setPage = useSession((s) => s.setPage);
  const setPageSize = useSession((s) => s.setPageSize);
  const [jump, setJump] = useState('');
  if (!tab?.queryResult) return null;

  const isTable = tab.kind === 'table';
  const totalRows = isTable
    ? (tab.totalRowCount ?? tab.queryResult.rows.length)
    : tab.queryResult.rows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / tab.pageSize));
  const page = Math.min(tab.page, totalPages - 1);
  const start = totalRows === 0 ? 0 : page * tab.pageSize + 1;
  const end = isTable
    ? Math.min(totalRows, start + tab.queryResult.rows.length - 1)
    : Math.min(totalRows, (page + 1) * tab.pageSize);
  const paged = totalPages > 1;
  const limited = !isTable && tab.queryResult.truncated;

  return (
    <div className="flex min-w-0 items-center gap-1 text-[13px] tabular-nums text-[var(--wb-text-2)]">
      {paged && (
        <IconButton
          label="Previous page"
          variant="plain"
          disabled={page === 0}
          onClick={() => setPage(page - 1)}
        >
          <ChevronLeft />
        </IconButton>
      )}
      <span className="truncate px-1" data-testid="row-range">
        {paged ? (
          <>
            {start.toLocaleString()}–{end.toLocaleString()} of{' '}
            {tab.countLoading ? '…' : totalRows.toLocaleString()}
            {isTable && tab.totalRowCountIsEstimate && (
              <span className="text-[var(--wb-text-3)]" title="Estimate from pg_class.reltuples">
                {' '}
                (est.)
              </span>
            )}{' '}
            rows
          </>
        ) : (
          <>
            {totalRows.toLocaleString()} row{totalRows === 1 ? '' : 's'}
          </>
        )}
        {limited && (
          <span
            className="text-[var(--wb-text)]"
            title="Stopped at the editor row limit / worker cap"
          >
            {' '}
            · limited
          </span>
        )}
      </span>
      {paged && (
        <IconButton
          label="Next page"
          variant="plain"
          disabled={page >= totalPages - 1}
          onClick={() => setPage(page + 1)}
        >
          <ChevronRight />
        </IconButton>
      )}
      <Popover>
        <PopoverTrigger asChild>
          <IconButton label="Page settings" variant="plain">
            <Settings2 />
          </IconButton>
        </PopoverTrigger>
        <PopoverContent side="top" sideOffset={6} className="w-[220px] p-3">
          <div className="mb-2 text-[12px] font-medium text-[var(--wb-text-2)]">Rows per page</div>
          <div className="mb-3 flex flex-wrap gap-1">
            {PAGE_SIZES.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setPageSize(n)}
                className={cn(
                  'rounded-[6px] px-2 py-1 font-mono text-[12px] transition-colors',
                  tab.pageSize === n
                    ? 'bg-[var(--wb-control-active)] text-[var(--wb-text)]'
                    : 'bg-[var(--wb-control)] text-[var(--wb-text-2)] hover:bg-[var(--wb-control-hover)] hover:text-[var(--wb-text)]',
                )}
              >
                {n}
              </button>
            ))}
          </div>
          <div className="mb-1.5 text-[12px] font-medium text-[var(--wb-text-2)]">
            Go to page (1–{totalPages.toLocaleString()})
          </div>
          <form
            className="flex gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              const n = Number(jump);
              if (Number.isInteger(n) && n >= 1 && n <= totalPages) setPage(n - 1);
            }}
          >
            <input
              value={jump}
              onChange={(e) => setJump(e.target.value.replace(/\D/g, ''))}
              inputMode="numeric"
              placeholder={String(page + 1)}
              aria-label="Page number"
              className="h-6 min-w-0 flex-1 rounded-[6px] border-0 bg-[var(--wb-field)] px-2 font-mono text-[12px] text-[var(--wb-text)] outline-none ring-1 ring-[var(--wb-separator)] placeholder:text-[var(--wb-text-3)] focus:ring-2 focus:ring-[var(--wb-accent)]"
            />
            <Pill type="submit">Go</Pill>
          </form>
        </PopoverContent>
      </Popover>
    </div>
  );
}
