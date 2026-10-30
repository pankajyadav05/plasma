import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Pill } from '@/components/ui/workbench';
import { maskResultForClipboard } from '@/features/presentation/presentation';
import { cn } from '@/lib/cn';
import {
  type ClipboardFormat,
  type ExportFormat,
  type FullExportSource,
  copyResultAs,
  copyResultToClipboard,
  pickRows,
} from '@/lib/export';
import { useExportJob } from '@/stores/export-job';
import { useSession } from '@/stores/session';
import { type ExportAllFormat, type NamedResult, formatAllResultsJson } from '@shared/export-all';
import type { QueryResult } from '@shared/protocol';
import {
  Check,
  Copy,
  Download,
  FileArchive,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileType2,
  Loader2,
} from 'lucide-react';
import { useEffect, useState } from 'react';

/**
 * Popover that owns the Export menu. Holds the scope toggle (All vs
 * Selected rows) and threads the chosen QueryResult slice into each
 * ExportRow. When rows are selected, the trigger label updates to
 * surface the count.
 */
export function ExportPopover({
  open,
  onOpenChange,
  result,
  selected,
  filename,
  full,
  targetTable,
  allResults,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  result: QueryResult;
  selected: Set<number>;
  filename: string;
  /** F7: server-side export of the whole table / untruncated result. */
  full?: FullExportSource | null;
  /** Quoted INSERT target for SQL export (table tabs). */
  targetTable?: string;
  /** Every row-returning result of a multi-statement run; "All results" shows from two. */
  allResults?: NamedResult[];
}) {
  const selectedCount = selected.size;
  const hasSelection = selectedCount > 0;
  const [scope, setScope] = useState<'all' | 'selected' | 'full'>('all');
  const fullScope = scope === 'full' && full ? full : null;

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
        <Pill
          title={hasSelection ? `Export — ${selectedCount} selected rows` : 'Export results'}
          className="px-3"
        >
          Export…
          {hasSelection && (
            <span className="rounded-[4px] bg-[var(--wb-control-active)] px-1 font-mono text-[11px] leading-4 tabular-nums text-[var(--wb-text)]">
              {selectedCount}
            </span>
          )}
        </Pill>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={4} className="w-[280px] p-1">
        {allResults && allResults.length > 1 && (
          <ExportAllSection
            results={allResults}
            filename={filename}
            onDone={() => onOpenChange(false)}
          />
        )}
        {(hasSelection || full) && (
          <div
            className={cn(
              'mb-1 grid h-6 gap-px rounded-[7px] bg-[var(--wb-control)] p-px',
              hasSelection && full ? 'grid-cols-3' : 'grid-cols-2',
            )}
            role="tablist"
            aria-label="Export scope"
          >
            {hasSelection && (
              <ScopeTab
                active={scope === 'selected'}
                onClick={() => setScope('selected')}
                label="Selected"
                count={selectedCount}
              />
            )}
            <ScopeTab
              active={scope === 'all'}
              onClick={() => setScope('all')}
              label={full ? 'Loaded' : 'All rows'}
              count={result.rows.length}
            />
            {full && (
              <ScopeTab
                active={scope === 'full'}
                onClick={() => setScope('full')}
                label={full.label}
              />
            )}
          </div>
        )}
        {result.truncated && !fullScope && (
          <div className="px-2 pb-1 text-[12px] text-[var(--wb-text-2)]">
            Only the first {result.rows.length.toLocaleString()} rows were loaded.
            {full ? ` Choose "${full.label}" to export everything.` : ''}
          </div>
        )}
        <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-1 px-2 pb-1 pt-1 text-[11px] text-[var(--wb-text-3)]">
          <span />
          <span className="px-1 text-center">copy</span>
          <span className="px-1 text-center">file</span>
        </div>
        <ExportRow
          icon={<FileText className="h-3.5 w-3.5 text-[var(--wb-text-2)]" />}
          label="CSV"
          hint=".csv"
          format="csv"
          result={effectiveResult}
          filename={effectiveFilename}
          full={fullScope}
          targetTable={fullScope?.targetTable ?? targetTable}
          onClose={() => onOpenChange(false)}
        />
        <ExportRow
          icon={<FileJson className="h-3.5 w-3.5 text-[var(--wb-text-2)]" />}
          label="JSON"
          hint=".json"
          format="json"
          result={effectiveResult}
          filename={effectiveFilename}
          full={fullScope}
          targetTable={fullScope?.targetTable ?? targetTable}
          onClose={() => onOpenChange(false)}
        />
        <ExportRow
          icon={<FileType2 className="h-3.5 w-3.5 text-[var(--wb-text-2)]" />}
          label="SQL INSERT"
          hint=".sql"
          format="sql"
          result={effectiveResult}
          filename={effectiveFilename}
          full={fullScope}
          targetTable={fullScope?.targetTable ?? targetTable}
          onClose={() => onOpenChange(false)}
        />
        <div className="my-1 h-px bg-[var(--wb-separator)]" />
        <div className="px-2 pb-0.5 pt-1 text-[11px] text-[var(--wb-text-3)]">Copy as</div>
        <div className="flex flex-wrap gap-1 px-2 pb-1.5">
          <CopyAsChip label="Markdown" format="markdown" result={effectiveResult} />
          <CopyAsChip label="HTML" format="html" result={effectiveResult} />
          <CopyAsChip label="TSV" format="tsv" result={effectiveResult} />
        </div>
      </PopoverContent>
    </Popover>
  );
}

const ALL_FORMATS: {
  format: ExportAllFormat;
  label: string;
  hint: string;
  icon: React.ReactNode;
}[] = [
  {
    format: 'xlsx',
    label: 'Excel workbook',
    hint: '.xlsx',
    icon: <FileSpreadsheet className="h-3.5 w-3.5 text-[var(--wb-text-2)]" />,
  },
  {
    format: 'csv',
    label: 'CSV files',
    hint: '.zip',
    icon: <FileArchive className="h-3.5 w-3.5 text-[var(--wb-text-2)]" />,
  },
  {
    format: 'json',
    label: 'JSON files',
    hint: '.zip',
    icon: <FileArchive className="h-3.5 w-3.5 text-[var(--wb-text-2)]" />,
  },
];

/**
 * Every result of the run in one file: an Excel workbook with a sheet per
 * result, or a zip with a CSV / JSON file per result. Uses the rows already
 * loaded, like "Loaded" above.
 */
function ExportAllSection({
  results,
  filename,
  onDone,
}: {
  results: NamedResult[];
  filename: string;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState<ExportAllFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const truncated = results.some((r) => r.truncated);

  const save = async (format: ExportAllFormat) => {
    setBusy(format);
    setError(null);
    try {
      const res = await window.plasma.export.saveAll({
        format,
        defaultPath: `${filename}-all-results`,
        results: results.map(({ label, columns, rows }) => ({ label, columns, rows })),
      });
      if (res.ok) onDone();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
          : String(err),
      );
    } finally {
      setBusy(null);
    }
  };

  const [copied, setCopied] = useState(false);
  /** JSON is the one format where every result fits one clipboard text. */
  const copyJson = async () => {
    setError(null);
    try {
      // Presentation mode masks the clipboard copy here too.
      const masked = results.map((r) => ({
        ...r,
        rows: maskResultForClipboard({
          columns: r.columns,
          rows: r.rows,
          rowCount: r.rows.length,
          durationMs: 0,
        }).rows,
      }));
      await navigator.clipboard.writeText(formatAllResultsJson(masked));
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      setError('Could not copy to the clipboard.');
    }
  };

  return (
    <div data-testid="export-all">
      <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-1 px-2 pb-1 pt-1 text-[11px] text-[var(--wb-text-3)]">
        <span>All {results.length} results</span>
        <span className="px-1 text-center">copy</span>
        <span className="px-1 text-center">file</span>
      </div>
      {ALL_FORMATS.map(({ format, label, hint, icon }) => (
        <div
          key={format}
          className="grid grid-cols-[1fr_auto_auto] items-center gap-x-1 rounded-[5px] px-2 py-0.5 transition-colors hover:bg-[var(--wb-control)]"
        >
          <div className="flex min-w-0 items-center gap-2 text-[13px] text-[var(--wb-text)]">
            {icon}
            <span className="truncate">{label}</span>
            <span className="ml-1 font-mono text-[12px] text-[var(--wb-text-3)]">{hint}</span>
          </div>
          {format === 'json' ? (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => void copyJson()}
              title={`Copy all ${results.length} results as one JSON object`}
              aria-label="Copy all results as JSON"
              data-testid="export-all-copy-json"
            >
              {copied ? <Check /> : <Copy />}
            </Button>
          ) : (
            // A workbook or a zip is a file; there is no clipboard form of it.
            <span className="w-6" aria-hidden />
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={busy !== null}
            onClick={() => void save(format)}
            title={`Download every result as ${label.toLowerCase()} (${hint})`}
            aria-label={`Download all results as ${label}`}
            data-testid={`export-all-${format}`}
          >
            {busy === format ? <Loader2 className="animate-spin" /> : <Download />}
          </Button>
        </div>
      ))}
      {truncated && (
        <div className="px-2 pb-1 text-[12px] text-[var(--wb-text-2)]">
          Some results were cut at the row limit; their loaded rows are exported.
        </div>
      )}
      {error && (
        <div className="px-2 pb-1 text-[12px] text-destructive" role="alert">
          {error}
        </div>
      )}
      <div className="my-1 h-px bg-[var(--wb-separator)]" />
      <div className="px-2 pb-0.5 pt-1 text-[11px] text-[var(--wb-text-3)]">This result</div>
    </div>
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
  count?: number;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'flex cursor-pointer items-center justify-center gap-1.5 rounded-[6px] px-2 text-[13px] transition-colors duration-150',
        active
          ? 'bg-[var(--wb-control-active)] text-[var(--wb-text)]'
          : 'text-[var(--wb-text-2)] hover:text-[var(--wb-text)]',
      )}
    >
      <span>{label}</span>
      {count !== undefined && (
        <span className="tabular-nums text-[var(--wb-text-2)]">{count.toLocaleString()}</span>
      )}
    </button>
  );
}

/** Clipboard-only formats — handy for pasting into docs, tickets, sheets. */
function CopyAsChip({
  label,
  format,
  result,
}: {
  label: string;
  format: ClipboardFormat;
  result: QueryResult;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void copyResultAs(result, format)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          })
          .catch(() => {
            /* clipboard unavailable */
          });
      }}
      title={`Copy ${label} to clipboard`}
      className="flex h-6 items-center gap-1 rounded-[6px] bg-[var(--wb-control)] px-2 text-[13px] text-[var(--wb-text)] transition-colors hover:bg-[var(--wb-control-hover)]"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {label}
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
  full,
  targetTable,
  onClose,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  format: ExportFormat;
  result: QueryResult;
  filename: string;
  full?: FullExportSource | null;
  targetTable?: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await copyResultToClipboard(result, format, {
        targetTable,
        csv: useSession.getState().settings.csvExport,
      });
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };

  const handleDownload = () => {
    void useExportJob.getState().start(
      full
        ? {
            format,
            defaultPath: filename,
            columns: result.columns,
            sql: full.sql,
            params: full.params,
            targetTable,
          }
        : {
            format,
            defaultPath: filename,
            columns: result.columns,
            rows: result.rows,
            targetTable,
          },
    );
    onClose();
  };

  return (
    <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-1 rounded-[5px] px-2 py-0.5 transition-colors hover:bg-[var(--wb-control)]">
      <div className="flex min-w-0 items-center gap-2 text-[13px] text-[var(--wb-text)]">
        {icon}
        <span className="truncate">{label}</span>
        <span className="ml-1 font-mono text-[12px] text-[var(--wb-text-3)]">{hint}</span>
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={() => void handleCopy()}
        disabled={Boolean(full)}
        title={`Copy ${label} to clipboard`}
        aria-label={`Copy ${label}`}
      >
        {copied ? <Check /> : <Copy />}
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
