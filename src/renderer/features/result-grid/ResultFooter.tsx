import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { IconButton, MenuItem, Pill, Segmented } from '@/components/ui/workbench';
import { RunStatusChip } from '@/features/editor/RunStatus';
import { CompareMenu } from '@/features/result-compare/CompareMenu';
import { cn } from '@/lib/cn';
import { exportTargetTable, queryFullExport, tableFullExport } from '@/lib/export';
import { formatDuration } from '@/lib/format';
import { LazyOnOpen, lazyNamed } from '@/lib/lazy';
import { type TableViewMode, useActiveTabSansSql, useSession } from '@/stores/session';
import { type ResultView, useWorkbench } from '@/stores/workbench';
import type { QueryResult } from '@shared/protocol';
import { MAX_RESULT_ROWS } from '@shared/result-bounds';
import {
  Brain,
  ChevronLeft,
  ChevronRight,
  Map as MapIcon,
  Minus,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
} from 'lucide-react';
import { useEffect, useState } from 'react';
const MockDataDialog = lazyNamed(
  () => import('@/features/mock-data/MockDataDialog'),
  'MockDataDialog',
);
const PostGisDialog = lazyNamed(() => import('@/features/postgis/PostGisDialog'), 'PostGisDialog');
const PgVectorDialog = lazyNamed(
  () => import('@/features/pgvector/PgVectorDialog'),
  'PgVectorDialog',
);

import { ColumnsPopover } from './ColumnsPopover';
import { ExportPopover } from './ExportMenu';
import { ExportProgress } from './ExportProgress';
import { InsertRowDialog } from './InsertRowDialog';
import { useNoticeCount } from './ResultTabs';
import { SelectionStatsChip } from './SelectionStats';
import { SortPopover } from './SortPopover';
import { isErrorTabActive } from './result-view';

const PAGE_SIZES: readonly number[] = [50, 100, 300, 500, 1000];

/** The presets, plus the tab's own size when it is not one of them (e.g. the agent asked for 10 rows). */
function pageSizeChoices(current: number): number[] {
  return PAGE_SIZES.includes(current)
    ? [...PAGE_SIZES]
    : [...PAGE_SIZES, current].sort((a, b) => a - b);
}

/**
 * The single bar under every result — TablePlus's footer:
 *
 *   SQL tab    [Data|Message|Chart] 243 ms        1 row        [⌕] [Columns] [Sort] [⋯] [Export…]
 *   table tab  [Data|Structure|DDL] [+ Row]   ‹ 1–300 of 12,408 › ⚙   [⌕] [Columns] [Sort] [⋯] [Export…] [↻]
 *
 * Replaces the old result toolbar, messages strip and pagination bar.
 */

const EMPTY_COLUMNS: NonNullable<ReturnType<typeof useSession.getState>['schema']>['columns'] = [];

export function ResultFooter() {
  const tab = useActiveTabSansSql();
  const editMode = useSession((s) => s.editMode);
  const schemaColumns = useSession((s) => s.schema?.columns ?? EMPTY_COLUMNS);
  const connectionReadOnly = useSession((s) => Boolean(s.activeConfig?.readOnly));
  const setTabViewMode = useSession((s) => s.setTabViewMode);
  const refreshTable = useSession((s) => s.refreshTable);
  const deleteRows = useSession((s) => s.deleteRows);
  const resultView = useWorkbench((s) => (tab ? (s.resultViews[tab.id] ?? 'data') : 'data'));
  const setResultView = useWorkbench((s) => s.setResultView);
  const noticeCount = useNoticeCount();

  const [exportOpen, setExportOpen] = useState(false);
  const [insertOpen, setInsertOpen] = useState(false);
  const [mockOpen, setMockOpen] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [vectorOpen, setVectorOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  // R-08: a refused "− Row" (no primary key, safe mode…) is shown, not logged.
  const [deleteError, setDeleteError] = useState<string | null>(null);

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

  // "− Row": checked rows, else the selected cell's row.
  const rowsToDelete = (): number[] => {
    if (tab.selectedRows.size > 0) return [...tab.selectedRows] as number[];
    const sel = tab.selectedCell;
    if (!sel || !tab.queryResult || sel.row >= tab.queryResult.rows.length) return [];
    return [sel.row];
  };
  const canDeleteRows = rowsToDelete().length > 0;
  const tableHasPk =
    tab.kind !== 'table' ||
    schemaColumns.some(
      (c) => c.schema === tab.tableSchema && c.table === tab.tableName && c.isPrimaryKey,
    );
  const deleteSelectedRows = () => {
    try {
      setDeleteError(null);
      deleteRows(rowsToDelete());
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    }
  };

  const isTable = tab.kind === 'table';
  const result = tab.queryResult;
  const hasRows = Boolean(result && result.columns.length > 0 && !isErrorTabActive(tab));
  const running = tab.queryRunState === 'running';
  const tableData = isTable && tab.viewMode === 'data';
  const showDataTools = hasRows && (isTable ? tableData : resultView === 'data');
  const canWrite = isTable && editMode && !connectionReadOnly;
  const hasGeo = Boolean(
    hasRows && result?.columns.some((c) => /geometry|geography/i.test(c.dataTypeName)),
  );
  const hasVector = Boolean(hasRows && result?.columns.some((c) => /vector/i.test(c.dataTypeName)));
  const moreItems = hasGeo || hasVector || canWrite;
  // F7: "Whole table" / "Full result" export streams from the server.
  const fullExport =
    isTable && tab.tableSchema && tab.tableName
      ? tableFullExport({
          schema: tab.tableSchema,
          table: tab.tableName,
          allColumns: schemaColumns
            .filter((c) => c.schema === tab.tableSchema && c.table === tab.tableName)
            .sort((a, b) => a.ordinal - b.ordinal)
            .map((c) => c.name),
          hiddenColumns: tab.hiddenColumns,
          sort: tab.tableSort,
          filters: tab.filters,
          primaryKey: schemaColumns
            .filter(
              (c) => c.schema === tab.tableSchema && c.table === tab.tableName && c.isPrimaryKey,
            )
            .map((c) => c.name),
        })
      : result
        ? queryFullExport(result)
        : null;

  return (
    <div
      className="@container flex h-9 min-w-0 shrink-0 items-center gap-1.5 overflow-hidden border-t border-[var(--wb-separator)] bg-[var(--wb-content)] px-2"
      data-testid="result-footer"
    >
      <ExportProgress />
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
                        tab.queryError ? 'bg-destructive' : 'bg-[var(--status-warn)]',
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
        <>
          <Pill onClick={() => setInsertOpen(true)} title="Add a new row (queued until you commit)">
            <Plus />
            <span className="@max-[560px]:hidden">Row</span>
          </Pill>
          <Pill
            onClick={() => deleteSelectedRows()}
            disabled={!canDeleteRows || !tableHasPk}
            aria-label="Delete row"
            title={
              tableHasPk
                ? 'Mark the selected rows for deletion (⌘⌫) — committed with the pending changes'
                : 'This table has no primary key, so rows cannot be deleted safely'
            }
          >
            <Minus />
          </Pill>
          {deleteError && (
            <span
              role="alert"
              className="max-w-[260px] truncate text-[12px] text-destructive"
              title={deleteError}
            >
              {deleteError}
            </span>
          )}
        </>
      )}

      <RunStatusChip
        lifecycle={tab.queryLifecycle}
        settledText={
          !isTable && result && !running
            ? `${
                result.columns.length === 0 && result.command && result.command !== 'SELECT'
                  ? `${result.rowCount.toLocaleString()} affected · `
                  : ''
              }${formatDuration(
                tab.queryResults.length > 1
                  ? tab.queryResults.reduce((sum: number, r: QueryResult) => sum + r.durationMs, 0)
                  : result.durationMs,
              )}`
            : null
        }
      />

      <div className="flex min-w-0 flex-1 items-center justify-center gap-2">
        {showDataTools && <SelectionStatsChip tabId={tab.id} />}
        {tableData || (!isTable && hasRows && resultView === 'data') ? <RowRange /> : null}
      </div>

      {showDataTools && (
        <>
          <IconButton
            label="Find in results (⌘F)"
            className="@max-[620px]:hidden"
            onClick={() => window.dispatchEvent(new CustomEvent('plasma:grid-find'))}
          >
            <Search />
          </IconButton>
          <ColumnsPopover />
          <SortPopover />
          <CompareMenu tab={tab} />
          {moreItems && (
            <Popover open={moreOpen} onOpenChange={setMoreOpen}>
              <PopoverTrigger asChild>
                <IconButton label="More">
                  <MoreHorizontal />
                </IconButton>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                side="top"
                sideOffset={6}
                className="w-[220px] p-1"
                role="menu"
              >
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
              full={fullExport}
              targetTable={isTable ? exportTargetTable(tab.tableSchema, tab.tableName) : undefined}
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
      <LazyOnOpen open={mockOpen}>
        <MockDataDialog open={mockOpen} onOpenChange={setMockOpen} />
      </LazyOnOpen>
      <LazyOnOpen open={mapOpen}>
        <PostGisDialog result={result} open={mapOpen} onOpenChange={setMapOpen} />
      </LazyOnOpen>
      <LazyOnOpen open={vectorOpen}>
        <PgVectorDialog result={result} open={vectorOpen} onOpenChange={setVectorOpen} />
      </LazyOnOpen>
    </div>
  );
}

/**
 * Row range + paging. Table tabs page on the server (real COUNT or
 * estimate); SQL tabs page the in-memory result.
 */
function RowRange() {
  const tab = useActiveTabSansSql();
  const setPage = useSession((s) => s.setPage);
  const setPageSize = useSession((s) => s.setPageSize);
  const [jump, setJump] = useState('');
  if (!tab?.queryResult) return null;

  const isTable = tab.kind === 'table';
  const pageRows = tab.queryResult.rows.length;
  // F8: while COUNT is loading (or failed) the total is unknown — a full
  // page means there may be more, so Next stays available.
  const countKnown = !isTable || tab.totalRowCount !== null;
  const mayHaveMore = isTable && !countKnown && pageRows >= tab.pageSize;
  const totalRows = isTable ? (tab.totalRowCount ?? tab.page * tab.pageSize + pageRows) : pageRows;
  const totalPages = Math.max(1, Math.ceil(totalRows / tab.pageSize)) + (mayHaveMore ? 1 : 0);
  const page = countKnown ? Math.min(tab.page, totalPages - 1) : tab.page;
  const start = pageRows === 0 && totalRows === 0 ? 0 : page * tab.pageSize + 1;
  const end = isTable ? start + pageRows - 1 : Math.min(totalRows, (page + 1) * tab.pageSize);
  const paged = totalPages > 1 || page > 0;
  const limited = !isTable && tab.queryResult.truncated;
  const cap = rowLimitCap(pageRows);

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
      <span className="shrink-0 whitespace-nowrap px-1" data-testid="row-range">
        {paged ? (
          <>
            {start.toLocaleString()}–{Math.max(start, end).toLocaleString()} of{' '}
            {tab.countLoading ? '…' : countKnown ? totalRows.toLocaleString() : 'many'}
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
          <span className="text-[var(--wb-text)]" title={cap}>
            {' '}
            · limited
          </span>
        )}
      </span>
      {paged && (
        <IconButton
          label="Next page"
          variant="plain"
          disabled={countKnown ? page >= totalPages - 1 : !mayHaveMore}
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
        <PopoverContent side="top" sideOffset={6} className="w-[264px] p-3">
          <div className="mb-2 text-[12px] font-medium text-[var(--wb-text-2)]">Rows per page</div>
          <div className="mb-3 flex flex-nowrap gap-1">
            {pageSizeChoices(tab.pageSize).map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setPageSize(n)}
                className={cn(
                  'shrink-0 whitespace-nowrap rounded-[6px] px-2 py-1 font-mono text-[12px] transition-colors',
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
            {countKnown ? `Go to page (1–${totalPages.toLocaleString()})` : 'Go to page'}
          </div>
          <form
            className="flex gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              const n = Number(jump);
              if (Number.isInteger(n) && n >= 1 && (!countKnown || n <= totalPages)) setPage(n - 1);
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

/** Tooltip for "· limited": the real cap the result stopped at (F16). */
function rowLimitCap(rows: number): string {
  const limit = useWorkbench.getState().rowLimit;
  if (limit === null || limit >= MAX_RESULT_ROWS) {
    return `Stopped at ${rows.toLocaleString()} rows — "No limit" is capped at ${MAX_RESULT_ROWS.toLocaleString()} rows (or the result byte cap).`;
  }
  return `Stopped at the editor row limit (${limit.toLocaleString()} rows).`;
}
