import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { cn } from '@/lib/cn';
import type { ColumnMeta } from '@shared/protocol';
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

export interface RowDetail {
  tabTitle: string;
  rowNumber: number;
  columns: ColumnMeta[];
  row: unknown[];
}

/**
 * Row inspector drawer. Opens when the user hits Enter on a selected
 * cell, or clicks the row-number column. Lays the row out vertically so
 * every column fits on screen — essential for wide tables, JSON
 * columns, and long text fields that truncate in the grid.
 *
 * Each field has a per-value copy button. Null/undefined/empty string
 * render with italic placeholders so they're distinguishable. Typed
 * values (numbers, dates, bools) pick up the same type-tint classes the
 * grid uses, so the drawer feels like an extension of the cell, not a
 * separate widget.
 */
export function RowDetailSheet({
  detail,
  onOpenChange,
}: {
  detail: RowDetail | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={!!detail} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Row {detail?.rowNumber.toLocaleString() ?? ''}</SheetTitle>
          <SheetDescription>{detail?.tabTitle}</SheetDescription>
        </SheetHeader>

        <div className="-mx-6 min-h-0 flex-1 overflow-y-auto px-6 pt-2">
          {detail?.columns.map((col, i) => (
            <FieldRow key={`${col.name}-${i}`} col={col} value={detail.row[i]} />
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function FieldRow({ col, value }: { col: ColumnMeta; value: unknown }) {
  const [copied, setCopied] = useState(false);

  const formatted = formatFieldValue(value);
  const isMultiline =
    typeof formatted === 'string' && (formatted.includes('\n') || formatted.length > 120);
  const isNullish = value === null || value === undefined;
  const isEmpty = typeof value === 'string' && value === '';

  const handleCopy = () => {
    const text =
      value === null || value === undefined
        ? ''
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value);
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1000);
    });
  };

  return (
    <div className="group/field border-b py-3 last:border-b-0">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate font-mono text-sm font-medium text-foreground">{col.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{col.dataTypeName}</span>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={handleCopy}
          className="opacity-0 transition-opacity duration-150 group-hover/field:opacity-100 focus-visible:opacity-100"
          aria-label={`Copy ${col.name}`}
          title="Copy value"
        >
          {copied ? <Check className="text-primary" /> : <Copy />}
        </Button>
      </div>
      {isNullish ? (
        <div className="font-display text-sm italic text-muted-foreground">
          {value === null ? 'null' : 'undefined'}
        </div>
      ) : isEmpty ? (
        <div className="font-display text-sm italic text-muted-foreground">(empty string)</div>
      ) : (
        <pre
          className={cn(
            'font-mono text-xs text-foreground',
            isMultiline
              ? 'max-h-48 overflow-auto whitespace-pre rounded-md border bg-muted p-2'
              : 'whitespace-pre-wrap break-words',
          )}
        >
          {formatted}
        </pre>
      )}
    </div>
  );
}

function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return String(value);
}
