import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Pill } from '@/components/ui/workbench';
import { cn } from '@/lib/cn';
import {
  type ClipboardFormat,
  type ExportFormat,
  copyResultAs,
  copyResultToClipboard,
  pickRows,
} from '@/lib/export';
import type { QueryResult } from '@shared/protocol';
import { Check, Copy, Download, FileJson, FileText, FileType2 } from 'lucide-react';
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
        <Pill
          title={hasSelection ? `Export — ${selectedCount} selected rows` : 'Export results'}
          className={hasSelection ? 'text-primary' : undefined}
        >
          <Download />
          Export…
          {hasSelection && (
            <span className="rounded-[4px] bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground">
              {selectedCount}
            </span>
          )}
        </Pill>
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
        <div className="my-1 h-px bg-border" />
        <div className="px-2 pb-0.5 pt-1 text-[10px] uppercase tracking-wider text-muted-foreground">
          copy as
        </div>
        <div className="flex flex-wrap gap-1 px-2 pb-1.5">
          <CopyAsChip label="Markdown" format="markdown" result={effectiveResult} />
          <CopyAsChip label="HTML" format="html" result={effectiveResult} />
          <CopyAsChip label="TSV" format="tsv" result={effectiveResult} />
        </div>
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
      className="flex items-center gap-1 rounded-sm border border-border px-2 py-1 text-xs text-foreground transition-colors hover:bg-accent"
    >
      {copied ? <Check className="h-3 w-3 text-primary" /> : <Copy className="h-3 w-3" />}
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
    void window.plasma.export.save({ format, defaultPath: filename, columns: result.columns, rows: result.rows });
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
