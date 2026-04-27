import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';

export interface CellDetail {
  columnName: string;
  dataTypeName: string;
  value: unknown;
  anchorRect: DOMRect;
}

/**
 * Full-value viewer for a single result-grid cell. Opens as a shadcn
 * Popover anchored to the clicked cell (or to the selected cell's rect
 * when invoked by Space). We use a virtual anchor — a zero-interaction
 * `position: fixed` span positioned to the cell's bounding rect — so
 * Radix's collision detection places the popover naturally next to the
 * cell instead of centering a dialog on the viewport.
 */
export function CellDetailDialog({
  detail,
  onOpenChange,
}: {
  detail: CellDetail | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);

  const formatted = formatValue(detail?.value);
  const isMultiline = formatted.includes('\n') || formatted.length > 160;

  const handleCopy = () => {
    if (!detail) return;
    const text =
      detail.value === null || detail.value === undefined
        ? ''
        : typeof detail.value === 'object'
          ? JSON.stringify(detail.value)
          : String(detail.value);
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  const rect = detail?.anchorRect;

  return (
    <Popover open={!!detail} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>
        <span
          aria-hidden
          style={{
            position: 'fixed',
            top: rect?.top ?? 0,
            left: rect?.left ?? 0,
            width: rect?.width ?? 0,
            height: rect?.height ?? 0,
            pointerEvents: 'none',
          }}
        />
      </PopoverAnchor>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={4}
        className="w-[440px] max-w-[90vw] p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex items-baseline justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            <div className="truncate font-mono text-sm font-semibold text-foreground">
              {detail?.columnName}
            </div>
            <div className="text-xs text-muted-foreground">{detail?.dataTypeName}</div>
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={handleCopy}
            aria-label="Copy value"
            title="Copy"
          >
            {copied ? <Check className="text-primary" /> : <Copy />}
          </Button>
        </div>

        <div className="max-h-[360px] overflow-auto bg-muted/40 p-3">
          {detail?.value === null || detail?.value === undefined ? (
            <span className="font-display text-sm italic text-muted-foreground">
              {detail?.value === null ? 'null' : 'undefined'}
            </span>
          ) : detail?.value === '' ? (
            <span className="font-display text-sm italic text-muted-foreground">
              (empty string)
            </span>
          ) : (
            <pre
              className={
                isMultiline
                  ? 'whitespace-pre font-mono text-xs text-foreground'
                  : 'whitespace-pre-wrap break-words font-mono text-xs text-foreground'
              }
            >
              {formatted}
            </pre>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 px-4 py-2 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {detail?.value !== null && detail?.value !== undefined
              ? `${formatted.length.toLocaleString()} chars`
              : ''}
          </span>
          <span className="text-muted-foreground/80">Esc to close</span>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function formatValue(value: unknown): string {
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
