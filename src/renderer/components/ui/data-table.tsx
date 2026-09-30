import { ROW_HEIGHT_PX, computeRowWindow } from '@/features/result-grid/windowed-rows';
import { cn } from '@/lib/cn';
import { useSession } from '@/stores/session';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

/** Header height (26px) — rows start below it. */
const HEADER_PX = 26;

/**
 * Read-only data grid with the Postgres result-grid look (TablePlus
 * parity): 26px header, 24px zebra rows, vertical column lines only,
 * 13px mono cells, dim `NULL`, row-number gutter, accent selection.
 *
 * Used by the Redis and OpenSearch views for collections, hits, SQL
 * results, slowlog and analysis tables. Rows are windowed (PF15): only
 * the visible slice (plus overscan) is mounted, so thousands of pub/sub
 * messages or collection elements stay cheap to re-render.
 *
 * Exposed as an ARIA grid: ↑/↓/Home/End/PageUp/PageDown move the
 * selection and Enter activates while the table has focus.
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
  const zebra = useSession((s) => s.settings.gridAlternatingRows !== false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const idBase = useId();
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(400);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => setScrollTop(el.scrollTop);
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height;
      if (typeof h === 'number' && h > 0) setViewport(h);
    });
    el.addEventListener('scroll', onScroll, { passive: true });
    ro.observe(el);
    setViewport(el.clientHeight || 400);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  }, []);

  const win = useMemo(
    () => computeRowWindow(rows.length, Math.max(0, scrollTop - HEADER_PX), viewport),
    [rows.length, scrollTop, viewport],
  );

  // Keyboard: ↑/↓/Home/End/PageUp/PageDown move the selection, Enter activates.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !onSelect) return;
    const onKey = (e: KeyboardEvent) => {
      if (rows.length === 0 || e.target !== el) return;
      const cur = selectedIndex ?? -1;
      const page = Math.max(1, Math.floor(el.clientHeight / ROW_HEIGHT_PX) - 1);
      let next: number | null = null;
      if (e.key === 'ArrowDown') next = Math.min(rows.length - 1, cur + 1);
      else if (e.key === 'ArrowUp') next = Math.max(0, cur - 1);
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = rows.length - 1;
      else if (e.key === 'PageDown') next = Math.min(rows.length - 1, cur + page);
      else if (e.key === 'PageUp') next = Math.max(0, cur - page);
      if (next !== null) {
        e.preventDefault();
        const row = rows[next];
        if (row !== undefined) onSelect(row, next);
      } else if (e.key === 'Enter' && selectedIndex !== null && onActivate) {
        e.preventDefault();
        const row = rows[selectedIndex];
        if (row !== undefined) onActivate(row, selectedIndex);
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [rows, selectedIndex, onSelect, onActivate]);

  // Keep the selected row in view (rows may not be mounted — use math).
  useEffect(() => {
    const el = scrollRef.current;
    if (selectedIndex === null || !el) return;
    const top = HEADER_PX + selectedIndex * ROW_HEIGHT_PX;
    if (top < el.scrollTop + HEADER_PX) el.scrollTop = top - HEADER_PX;
    else if (top + ROW_HEIGHT_PX > el.scrollTop + el.clientHeight) {
      el.scrollTop = top + ROW_HEIGHT_PX - el.clientHeight;
    }
  }, [selectedIndex]);

  const colCount = columns.length + (rowNumbers ? 1 : 0);
  const visible = rows.slice(win.start, win.end);

  return (
    <div
      ref={scrollRef}
      tabIndex={onSelect ? 0 : undefined}
      role={onSelect ? 'grid' : 'table'}
      aria-label={ariaLabel}
      aria-rowcount={rows.length + 1}
      aria-colcount={colCount}
      aria-activedescendant={
        onSelect && selectedIndex !== null && selectedIndex >= win.start && selectedIndex < win.end
          ? `${idBase}-r${selectedIndex}`
          : undefined
      }
      className={cn(
        'relative min-h-0 flex-1 overflow-auto bg-[var(--wb-content)] outline-none',
        'focus-visible:shadow-[inset_0_0_0_1px_var(--wb-accent)]',
        className,
      )}
      style={
        stripeFill && zebra
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
          <tr aria-rowindex={1}>
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
          {win.topPadPx > 0 && (
            // biome-ignore lint/a11y/noAriaHiddenOnFocusable: spacer row, never focusable
            <tr aria-hidden="true" style={{ height: win.topPadPx }}>
              <td colSpan={colCount} />
            </tr>
          )}
          {visible.map((row, vi) => {
            const i = win.start + vi;
            const selected = i === selectedIndex;
            return (
              // biome-ignore lint/a11y/useKeyWithClickEvents: ↑/↓/Enter are handled on the focusable table container
              <tr
                key={rowKey(row, i)}
                id={`${idBase}-r${i}`}
                aria-rowindex={i + 2}
                data-row={i}
                onClick={onSelect ? () => onSelect(row, i) : undefined}
                onDoubleClick={onActivate ? () => onActivate(row, i) : undefined}
                aria-selected={onSelect ? selected : undefined}
                className={cn(
                  onSelect && 'cursor-default',
                  selected
                    ? 'bg-[color-mix(in_srgb,var(--wb-accent)_18%,transparent)]'
                    : zebra && i % 2 === 0
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
          {win.bottomPadPx > 0 && (
            // biome-ignore lint/a11y/noAriaHiddenOnFocusable: spacer row, never focusable
            <tr aria-hidden="true" style={{ height: win.bottomPadPx }}>
              <td colSpan={colCount} />
            </tr>
          )}
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
