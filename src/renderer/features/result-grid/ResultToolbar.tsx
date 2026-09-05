import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { ChartDialog } from '@/features/chart/ChartDialog';
import { ExplainDialog } from '@/features/explain/ExplainDialog';
import { MockDataDialog } from '@/features/mock-data/MockDataDialog';
import { PgVectorDialog } from '@/features/pgvector/PgVectorDialog';
import { PostGisDialog } from '@/features/postgis/PostGisDialog';
import { cn } from '@/lib/cn';
import { type ExportFormat, copyResultToClipboard, exportResult, pickRows } from '@/lib/export';
import { formatDuration } from '@/lib/format';
import { useActiveTab, useSession } from '@/stores/session';
import type { QueryResult } from '@shared/protocol';
import {
  BarChart3,
  Brain,
  Check,
  Copy,
  Download,
  FileJson,
  FileText,
  FileType2,
  Gauge,
  Map,
  Plus,
  RefreshCw,
  Sparkles,
  Wand2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { ColumnsPopover } from './ColumnsPopover';
import { InsertRowDialog } from './InsertRowDialog';
import { SortPopover } from './SortPopover';

/**
 * Toolbar above the result grid. Layout:
 *
 *   ┌─────────────────────────────────────────────────────────┐
 *   │ [Columns] [Sort]               [Export ▾] [↻] 1.2 ms   │
 *   └─────────────────────────────────────────────────────────┘
 *
 * Filter trigger lives in the FilterRow above. Role + RLS moved to
 * the RightRail (icons on the far right of the window). Insert
 * appears on the far right of the toolbar when edit mode is on.
 */
export function ResultToolbar() {
  const tab = useActiveTab();
  const refreshTable = useSession((s) => s.refreshTable);
  const runQuery = useSession((s) => s.runQuery);
  const editMode = useSession((s) => s.editMode);
  const connectionReadOnly = useSession((s) => Boolean(s.activeConfig?.readOnly));
  const formatActiveSql = useSession((s) => s.formatActiveSql);
  const [exportOpen, setExportOpen] = useState(false);
  const [insertOpen, setInsertOpen] = useState(false);
  const [chartOpen, setChartOpen] = useState(false);
  const [explainOpen, setExplainOpen] = useState(false);
  const [mockOpen, setMockOpen] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [vectorOpen, setVectorOpen] = useState(false);

  // Listen for menu-driven export events so File → Export Results works
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ kind: 'csv' | 'json' }>).detail;
      const current = useSession.getState();
      const activeT = current.tabs.find((t) => t.id === current.activeTabId);
      if (!activeT?.queryResult) return;
      exportResult(activeT.queryResult, detail.kind, activeT.title.replace(/\.sql$/i, ''));
    };
    window.addEventListener('plasma:export', handler);
    return () => window.removeEventListener('plasma:export', handler);
  }, []);

  if (!tab) return null;

  const isTable = tab.kind === 'table';
  const hasResult =
    Boolean(tab.queryResult && tab.queryResult.columns.length > 0) && !tab.queryError;
  const canRefresh = Boolean(tab.queryResult) || isTable;

  const handleRefresh = () => {
    if (isTable) void refreshTable();
    else void runQuery();
  };

  // Don't render the toolbar at all for SQL tabs with nothing to act on
  if (!isTable && !hasResult && !canRefresh) return null;

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b bg-background px-3">
      {/* ── Left cluster: Columns + Sort.
           Filter trigger lives in the FilterRow above; don't duplicate. ── */}
      <div className="flex items-center gap-1">
        {(isTable || hasResult) && <ColumnsPopover />}
        {(isTable || hasResult) && <SortPopover />}
      </div>

      <InsertRowDialog open={insertOpen} onOpenChange={setInsertOpen} />

      <div className="flex-1" />

      {/* ── Right cluster: Format · Explain · Chart · Export · Refresh · duration · Insert ── */}
      {!isTable && tab.sql.trim().length > 0 && (
        <Button
          variant="ghost"
          size="xs"
          onClick={() => void formatActiveSql()}
          title="Format SQL (⌘⇧F)"
        >
          <Wand2 />
          Format
        </Button>
      )}

      {!isTable && tab.sql.trim().length > 0 && (
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setExplainOpen(true)}
          title="EXPLAIN ANALYZE — runs the query for real"
        >
          <Gauge />
          Explain
        </Button>
      )}

      {hasResult && tab.queryResult && tab.queryResult.rows.length > 0 && (
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setChartOpen(true)}
          title="Chart this result"
        >
          <BarChart3 />
          Chart
        </Button>
      )}

      {hasResult &&
        tab.queryResult &&
        tab.queryResult.rows.length > 0 &&
        tab.queryResult.columns.some((c) => /geometry|geography/i.test(c.dataTypeName)) && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setMapOpen(true)}
            title="Map preview (PostGIS)"
          >
            <Map />
            Map
          </Button>
        )}

      {hasResult &&
        tab.queryResult &&
        tab.queryResult.rows.length > 0 &&
        tab.queryResult.columns.some((c) => /vector/i.test(c.dataTypeName)) && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setVectorOpen(true)}
            title="pgvector — find similar"
          >
            <Brain />
            Vector
          </Button>
        )}

      {hasResult && tab.queryResult && (
        <ExportPopover
          open={exportOpen}
          onOpenChange={setExportOpen}
          result={tab.queryResult}
          selected={tab.selectedRows}
          filename={tab.title.replace(/\.sql$/i, '')}
        />
      )}

      {canRefresh && (
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={handleRefresh}
          disabled={tab.queryRunState === 'running'}
          aria-label="Refresh"
          title={isTable ? 'Refresh (re-run query)' : 'Re-run query'}
        >
          <RefreshCw className={tab.queryRunState === 'running' ? 'animate-spin' : ''} />
        </Button>
      )}

      {hasResult && tab.queryResult && (
        <>
          <Separator orientation="vertical" className="h-4" />
          <span
            className="tabular-nums text-xs text-muted-foreground"
            title={`Query duration · ${tab.queryResult.durationMs.toLocaleString()} ms`}
          >
            {formatDuration(tab.queryResult.durationMs)}
          </span>
        </>
      )}

      {isTable && editMode && !connectionReadOnly && (
        <>
          <Separator orientation="vertical" className="h-4" />
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setMockOpen(true)}
            title="Generate mock rows"
          >
            <Sparkles />
            Mock
          </Button>
          <Button
            variant="primary"
            size="xs"
            onClick={() => setInsertOpen(true)}
            title="Insert a new row"
            className="shadow-offset-md"
          >
            <Plus />
            Insert
          </Button>
        </>
      )}

      <MockDataDialog open={mockOpen} onOpenChange={setMockOpen} />
      <PostGisDialog result={tab.queryResult} open={mapOpen} onOpenChange={setMapOpen} />
      <PgVectorDialog result={tab.queryResult} open={vectorOpen} onOpenChange={setVectorOpen} />

      <ChartDialog
        result={tab.queryResult}
        open={chartOpen}
        onOpenChange={setChartOpen}
        defaultTitle={tab.title}
      />
      {!isTable && <ExplainDialog open={explainOpen} onOpenChange={setExplainOpen} sql={tab.sql} />}
    </div>
  );
}

/**
 * Popover that owns the Export menu. Holds the scope toggle (All vs
 * Selected rows) and threads the chosen QueryResult slice into each
 * ExportRow. When rows are selected, the trigger label updates to
 * surface the count.
 */
function ExportPopover({
  open,
  onOpenChange,
  result,
  selected,
  filename,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  result: QueryResult;
  selected: Set<number>;
  filename: string;
}) {
  const selectedCount = selected.size;
  const hasSelection = selectedCount > 0;
  const [scope, setScope] = useState<'all' | 'selected'>('all');

  // Default scope to 'selected' whenever the popover opens with a
  // non-empty selection — that's almost always what the user means.
  useEffect(() => {
    if (open) setScope(hasSelection ? 'selected' : 'all');
  }, [open, hasSelection]);

  const effectiveResult =
    scope === 'selected' && hasSelection ? pickRows(result, selected) : result;
  const effectiveFilename =
    scope === 'selected' && hasSelection ? `${filename}-selected` : filename;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant={hasSelection ? 'outline' : 'ghost'}
          size="xs"
          title={hasSelection ? `Export — ${selectedCount} selected` : 'Export results'}
          className={hasSelection ? 'border-primary text-primary' : ''}
        >
          <Download />
          Export
          {hasSelection && (
            <span className="rounded-sm bg-primary px-1 py-0.5 text-[10px] font-semibold leading-none text-primary-foreground">
              {selectedCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={4} className="w-[280px] p-1">
        {hasSelection && (
          <div
            className="mb-1 grid grid-cols-2 gap-0.5 rounded-md border border-border p-0.5"
            role="tablist"
            aria-label="Export scope"
          >
            <ScopeTab
              active={scope === 'selected'}
              onClick={() => setScope('selected')}
              label="Selected"
              count={selectedCount}
            />
            <ScopeTab
              active={scope === 'all'}
              onClick={() => setScope('all')}
              label="All rows"
              count={result.rows.length}
            />
          </div>
        )}
        <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-1 px-2 pb-1 pt-1 text-[10px] uppercase tracking-wider text-muted-foreground">
          <span />
          <span className="px-1 text-center">copy</span>
          <span className="px-1 text-center">file</span>
        </div>
        <ExportRow
          icon={<FileText className="h-3.5 w-3.5 text-muted-foreground" />}
          label="CSV"
          hint=".csv"
          format="csv"
          result={effectiveResult}
          filename={effectiveFilename}
          onClose={() => onOpenChange(false)}
        />
        <ExportRow
          icon={<FileJson className="h-3.5 w-3.5 text-muted-foreground" />}
          label="JSON"
          hint=".json"
          format="json"
          result={effectiveResult}
          filename={effectiveFilename}
          onClose={() => onOpenChange(false)}
        />
        <ExportRow
          icon={<FileType2 className="h-3.5 w-3.5 text-muted-foreground" />}
          label="SQL INSERT"
          hint=".sql"
          format="sql"
          result={effectiveResult}
          filename={effectiveFilename}
          onClose={() => onOpenChange(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

function ScopeTab({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'flex cursor-pointer items-center justify-center gap-1.5 rounded-sm px-2 py-1 text-xs transition-colors duration-150',
        active
          ? 'bg-accent font-medium text-accent-foreground'
          : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
      )}
    >
      <span>{label}</span>
      <span className="tabular-nums text-muted-foreground">{count.toLocaleString()}</span>
    </button>
  );
}

/**
 * One row in the Export popover — left cell is the format label, right
 * two cells are Copy and Download icon buttons.
 */
function ExportRow({
  icon,
  label,
  hint,
  format,
  result,
  filename,
  onClose,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  format: ExportFormat;
  result: QueryResult;
  filename: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await copyResultToClipboard(result, format);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };

  const handleDownload = () => {
    exportResult(result, format, filename);
    onClose();
  };

  return (
    <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-1 rounded-sm px-2 py-1 transition-colors hover:bg-accent/40">
      <div className="flex min-w-0 items-center gap-2 text-sm text-foreground">
        {icon}
        <span className="truncate">{label}</span>
        <span className="ml-1 text-xs text-muted-foreground">{hint}</span>
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={() => void handleCopy()}
        title={`Copy ${label} to clipboard`}
        aria-label={`Copy ${label}`}
      >
        {copied ? <Check className="text-primary" /> : <Copy />}
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={handleDownload}
        title={`Download ${hint} file`}
        aria-label={`Download ${label}`}
      >
        <Download />
      </Button>
    </div>
  );
}
