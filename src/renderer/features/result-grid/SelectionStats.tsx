import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useWorkbench } from '@/stores/workbench';
import { type ColumnStat, formatStatLine, formatStatNumber } from './column-stats';

/** Short footer label: the first numeric column's sum / avg, else just the cell count. */
export function summarizeSelection(
  stats: readonly ColumnStat[],
  cells: number,
  rows: number,
): string {
  const numeric = stats.find((s) => s.sum !== undefined);
  const size = `${rows.toLocaleString('en-US')} × ${stats.length.toLocaleString('en-US')}`;
  if (!numeric || numeric.sum === undefined || numeric.avg === undefined) {
    return `${cells.toLocaleString('en-US')} cells (${size})`;
  }
  const prefix = stats.length > 1 ? `${numeric.name}: ` : '';
  return `${prefix}count ${numeric.count.toLocaleString('en-US')} · sum ${formatStatNumber(numeric.sum)} · avg ${formatStatNumber(numeric.avg)}`;
}

/**
 * Quick stats for the grid's selected cell range, shown in the result
 * footer. Click for every selected column (count, sum, avg, min, max).
 */
export function SelectionStatsChip({ tabId }: { tabId: string }) {
  const sel = useWorkbench((s) => s.selectionStats);
  if (!sel || sel.tabId !== tabId || sel.stats.length === 0) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Selection statistics"
          data-testid="selection-stats"
          className="min-w-0 max-w-full shrink truncate rounded-[6px] bg-[var(--wb-control)] px-2 py-0.5 text-[12px] tabular-nums text-[var(--wb-text-2)] hover:bg-[var(--wb-control-hover)] hover:text-[var(--wb-text)] @max-[700px]:hidden"
        >
          {summarizeSelection(sel.stats, sel.cells, sel.rows)}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="center"
        sideOffset={6}
        className="w-[420px] max-w-[92vw] p-2"
      >
        <div className="mb-1.5 px-1 text-[12px] font-medium text-[var(--wb-text-2)]">
          Selection · {sel.rows.toLocaleString('en-US')} row{sel.rows === 1 ? '' : 's'} ×{' '}
          {sel.stats.length.toLocaleString('en-US')} column{sel.stats.length === 1 ? '' : 's'}
        </div>
        <ul className="flex max-h-[260px] flex-col gap-0.5 overflow-auto">
          {sel.stats.map((s) => (
            <li key={s.col} className="rounded-[5px] px-1 py-1 hover:bg-[var(--wb-control-hover)]">
              <div className="truncate font-mono text-[12px] text-[var(--wb-text)]">{s.name}</div>
              <div className="text-[12px] tabular-nums text-[var(--wb-text-2)]">
                {formatStatLine(s)}
              </div>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
