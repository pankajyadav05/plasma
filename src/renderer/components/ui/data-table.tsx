import { cn } from '@/lib/cn';
import { useEffect, useRef } from 'react';

/**
 * Read-only data grid with the Postgres result-grid look (TablePlus
 * parity): 26px header, 24px zebra rows, vertical column lines only,
 * 13px mono cells, dim `NULL`, row-number gutter, accent selection.
 *
 * Used by the Redis and OpenSearch views for collections, hits, SQL
 * results, slowlog and analysis tables. Not virtualised — callers cap
 * rows (Redis collections are capped at 1000 elements by the driver).
 */

export interface DataColumn<T> {
  key: string;
  label: React.ReactNode;
  /** Header tooltip, e.g. `name — type`. */
  title?: string;
  align?: 'left' | 'right';
  /** Fixed/min width in px. The last column stretches. */
  width?: number;
  /** Cell content; return `null`/`undefined` to render a dim NULL. */
  render: (row: T, index: number) => React.ReactNode;
  /** Plain text for the cell tooltip (defaults to none). */
  titleOf?: (row: T) => string | undefined;
  /** Sans instead of mono (labels, badges). */
  sans?: boolean;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  selectedIndex = null,
  onSelect,
  onActivate,
  rowNumbers = true,
  rowNumberOffset = 0,
  empty,
  className,
  stripeFill = true,
  ariaLabel,
}: {
  columns: DataColumn<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  selectedIndex?: number | null;
  onSelect?: (row: T, index: number) => void;
  /** Double-click / Enter on a row. */
  onActivate?: (row: T, index: number) => void;
  rowNumbers?: boolean;
  /** Added to displayed row numbers (paged results). */
  rowNumberOffset?: number;
  empty?: React.ReactNode;
  className?: string;
  /** Keep zebra stripes going below the last row (TablePlus). */
  stripeFill?: boolean;
  ariaLabel: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keyboard: ↑/↓ move the selection, Enter activates.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !onSelect) return;
    const onKey = (e: KeyboardEvent) => {
      if (rows.length === 0) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const cur = selectedIndex ?? -1;
        const next =
          e.key === 'ArrowDown' ? Math.min(rows.length - 1, cur + 1) : Math.max(0, cur - 1);
        const row = rows[next];
        if (row !== undefined) onSelect(row, next);
      } else if (e.key === 'Enter' && selectedIndex !== null && onActivate) {
        const row = rows[selectedIndex];
        if (row !== undefined) onActivate(row, selectedIndex);
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [rows, selectedIndex, onSelect, onActivate]);

  // Keep the selected row in view when it changes via keyboard.
  useEffect(() => {
    if (selectedIndex === null) return;
    scrollRef.current
      ?.querySelector<HTMLElement>(`[data-row="${selectedIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  return (
    <div
      ref={scrollRef}
      tabIndex={onSelect ? 0 : undefined}
      aria-label={ariaLabel}
      className={cn(
        'relative min-h-0 flex-1 overflow-auto bg-[var(--wb-content)] outline-none',
        className,
      )}
      style={
        stripeFill
          ? {
              // Stripes continue under the last row; aligned below the 26px header.
              backgroundImage:
                'repeating-linear-gradient(to bottom, var(--grid-row-a) 0 24px, var(--grid-row-b) 24px 48px)',
              backgroundPosition: '0 26px',
              backgroundRepeat: 'repeat-x',
              backgroundAttachment: 'local',
            }
          : undefined
      }
    >
      <table className="min-w-full border-separate border-spacing-0 text-[13px]">
        <thead className="sticky top-0 z-10">
          <tr>
            {rowNumbers && (
              <th
                className="sticky left-0 z-20 h-[26px] w-11 min-w-11 border-b border-r border-[var(--grid-line)] bg-[var(--wb-content)] px-1 text-center font-mono text-[11px] font-normal text-[var(--wb-text-3)]"
                aria-label="Row number"
              >
                #
              </th>
            )}
            {columns.map((c) => (
              <th
                key={c.key}
                title={c.title}
                className={cn(
                  'h-[26px] whitespace-nowrap border-b border-r border-[var(--grid-line)] bg-[var(--wb-content)] px-2.5 font-sans font-semibold text-[var(--grid-text)]',
                  c.align === 'right' ? 'text-right' : 'text-left',
                )}
                style={c.width ? { width: c.width, minWidth: c.width } : undefined}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const selected = i === selectedIndex;
            return (
              // biome-ignore lint/a11y/useKeyWithClickEvents: ↑/↓/Enter are handled on the focusable table container
              <tr
                key={rowKey(row, i)}
                data-row={i}
                onClick={onSelect ? () => onSelect(row, i) : undefined}
                onDoubleClick={onActivate ? () => onActivate(row, i) : undefined}
                aria-selected={onSelect ? selected : undefined}
                className={cn(
                  onSelect && 'cursor-default',
                  selected
                    ? 'bg-[color-mix(in_srgb,var(--wb-accent)_18%,var(--grid-row-b))]'
                    : i % 2 === 0
                      ? 'bg-[var(--grid-row-a)]'
                      : 'bg-[var(--grid-row-b)]',
                )}
              >
                {rowNumbers && (
                  <td className="sticky left-0 z-[1] h-6 border-r border-[var(--grid-line)] bg-[var(--wb-content)] px-1 text-center font-mono text-[12px] tabular-nums text-[var(--wb-text-3)]">
                    {(rowNumberOffset + i + 1).toLocaleString()}
                  </td>
                )}
                {columns.map((c) => {
                  const v = c.render(row, i);
                  return (
                    <td
                      key={c.key}
                      title={c.titleOf?.(row)}
                      className={cn(
                        'h-6 max-w-[520px] truncate whitespace-nowrap border-r border-[var(--grid-line)] px-2.5 text-[var(--grid-text)]',
                        c.sans ? 'font-sans' : 'font-mono',
                        c.align === 'right' && 'text-right tabular-nums',
                        selected && 'first-of-type:shadow-[inset_2px_0_0_var(--wb-accent)]',
                      )}
                    >
                      {v === null || v === undefined ? <NullText /> : v}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && (
        <div className="px-4 py-6 text-center text-[13px] text-[var(--wb-text-2)]">
          {empty ?? 'No rows'}
        </div>
      )}
    </div>
  );
}

export function NullText() {
  return <span className="font-mono text-[var(--grid-null)]">NULL</span>;
}
