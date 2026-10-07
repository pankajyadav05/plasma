import { cn } from '@/lib/cn';
import {
  type CompareSource,
  type DiffKind,
  type DiffResult,
  type DiffRow,
  leftCell,
  rightCell,
} from '@shared/result-compare';
import { KeyRound } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cellText, columnWidth, isNullish } from './cell-text';

export const ROW_H = 28;
const GUTTER_W = 34;
const OVERSCAN = 8;

/** Tints come from existing tokens, so every palette (light and dark) gets them. */
export const KIND_TINT: Record<DiffKind, string> = {
  added: 'color-mix(in srgb, var(--status-local) 17%, transparent)',
  removed: 'color-mix(in srgb, var(--destructive) 15%, transparent)',
  changed: 'transparent',
  unchanged: 'transparent',
  duplicate: 'color-mix(in srgb, var(--status-warn) 14%, transparent)',
};
export const CHANGED_CELL_TINT = 'color-mix(in srgb, var(--status-warn) 26%, transparent)';

export const KIND_GLYPH: Record<DiffKind, { glyph: string; label: string; color: string }> = {
  added: { glyph: '+', label: 'Added', color: 'var(--status-local)' },
  removed: { glyph: '−', label: 'Removed', color: 'var(--destructive)' },
  changed: { glyph: '~', label: 'Changed', color: 'var(--status-warn)' },
  unchanged: { glyph: '=', label: 'Unchanged', color: 'var(--wb-text-3)' },
  duplicate: { glyph: '!', label: 'Duplicate key', color: 'var(--status-warn)' },
};

function Value({ v }: { v: unknown }) {
  if (isNullish(v)) return <span className="text-[var(--grid-null)]">NULL</span>;
  return <>{cellText(v)}</>;
}

interface Props {
  diff: DiffResult;
  left: CompareSource;
  right: CompareSource;
  rows: DiffRow[];
  selected: number | null;
  onSelect(index: number): void;
}

/**
 * Virtualised diff table: a fixed 28px row, key columns and the kind gutter
 * pinned left, changed cells shown as `old → new`. Colour is never the only
 * signal: every row has a glyph and an accessible kind.
 */
export function DiffGrid({ diff, left, right, rows, selected, onSelect }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(400);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    setViewH(el.clientHeight);
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A new set of rows (filter, re-compare) starts at the top.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the rows change
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
    setScrollTop(0);
  }, [diff, rows.length]);

  const widths = useMemo(() => {
    const sample = rows.slice(0, 150);
    return diff.columns.map((name, c) => {
      let longest = 0;
      for (const r of sample) {
        const a = r.li < 0 ? '' : cellText(leftCell(diff, left, r, c));
        const b = r.ri < 0 ? '' : cellText(rightCell(diff, right, r, c));
        const len =
          r.kind === 'changed' && r.changed.includes(c)
            ? a.length + b.length + 5
            : Math.max(a.length, b.length);
        if (len > longest) longest = len;
      }
      return columnWidth(name.length + (c < diff.keys.length ? 3 : 0), Math.min(longest, 60));
    });
  }, [diff, left, right, rows]);

  const keyCount = diff.keys.length;
  const keyLeft = useMemo(() => {
    const out: number[] = [];
    let x = GUTTER_W;
    for (let c = 0; c < keyCount; c++) {
      out.push(x);
      x += widths[c]!;
    }
    return out;
  }, [widths, keyCount]);
  const totalW = GUTTER_W + widths.reduce((a, b) => a + b, 0);

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);

  const ensureVisible = useCallback((i: number) => {
    const el = scroller.current;
    if (!el) return;
    const top = i * ROW_H;
    const bodyH = el.clientHeight - ROW_H; // sticky header covers the first row height
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + bodyH) el.scrollTop = top + ROW_H - bodyH;
  }, []);

  const move = (to: number) => {
    if (rows.length === 0) return;
    const i = Math.max(0, Math.min(rows.length - 1, to));
    onSelect(i);
    ensureVisible(i);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const page = Math.max(1, Math.floor((viewH - ROW_H) / ROW_H) - 1);
    const at = selected ?? -1;
    switch (e.key) {
      case 'ArrowDown':
        move(at + 1);
        break;
      case 'ArrowUp':
        move(at < 0 ? 0 : at - 1);
        break;
      case 'PageDown':
        move(at + page);
        break;
      case 'PageUp':
        move(at - page);
        break;
      case 'Home':
        move(0);
        break;
      case 'End':
        move(rows.length - 1);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const stickyBg = (tint: string) => ({
    backgroundImage: `linear-gradient(${tint}, ${tint})`,
    backgroundColor: 'var(--wb-content)',
  });

  return (
    <div
      ref={scroller}
      role="grid"
      aria-label="Differences"
      aria-rowcount={rows.length + 1}
      aria-colcount={diff.columns.length + 1}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      className="relative min-h-0 flex-1 overflow-auto bg-[var(--wb-content)] text-[12.5px] outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--wb-accent)]"
      data-testid="compare-grid"
    >
      <div style={{ width: totalW, minWidth: '100%' }}>
        {/* header */}
        <div
          role="row"
          aria-rowindex={1}
          className="sticky top-0 z-20 flex border-b border-[var(--wb-separator)] bg-[var(--wb-content)]"
          style={{ height: ROW_H, width: totalW }}
        >
          <div
            role="columnheader"
            aria-label="Kind"
            className="sticky left-0 z-30 shrink-0 border-r border-[var(--wb-separator)] bg-[var(--wb-content)]"
            style={{ width: GUTTER_W }}
          />
          {diff.columns.map((name, c) => {
            const isKey = c < keyCount;
            const changed = diff.changedPerColumn[c] ?? 0;
            return (
              <div
                key={name}
                role="columnheader"
                className={cn(
                  'flex shrink-0 items-center gap-1 border-r border-[var(--grid-line)] px-2 text-[12px] font-medium text-[var(--wb-text)]',
                  isKey && 'sticky z-30 bg-[var(--wb-content)]',
                )}
                style={{ width: widths[c], ...(isKey ? { left: keyLeft[c] } : {}) }}
                title={isKey ? `${name} (key)` : name}
              >
                {isKey && (
                  <KeyRound
                    className="h-3 w-3 shrink-0 text-[var(--wb-text-2)]"
                    aria-label="key column"
                  />
                )}
                <span className="truncate">{name}</span>
                {!isKey && changed > 0 && (
                  <span
                    className="ml-auto shrink-0 rounded-[8px] px-1.5 text-[11px] tabular-nums text-[var(--wb-text)]"
                    style={{ backgroundColor: CHANGED_CELL_TINT }}
                    title={`${changed.toLocaleString()} changed`}
                  >
                    {changed.toLocaleString()}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {/* body */}
        <div className="relative" style={{ height: rows.length * ROW_H }}>
          {rows.slice(first, last).map((row, k) => {
            const i = first + k;
            const kind = KIND_GLYPH[row.kind];
            const tint = KIND_TINT[row.kind];
            const isSel = selected === i;
            return (
              // biome-ignore lint/a11y/useKeyWithClickEvents: the grid container handles the keyboard
              <div
                key={`${row.li}:${row.ri}:${i}`}
                role="row"
                aria-rowindex={i + 2}
                aria-selected={isSel}
                data-kind={row.kind}
                data-testid="compare-row"
                onClick={() => onSelect(i)}
                className="absolute left-0 flex border-b border-[var(--grid-line)]"
                style={{ top: i * ROW_H, height: ROW_H, width: totalW, backgroundColor: tint }}
              >
                <div
                  role="gridcell"
                  aria-label={kind.label}
                  className="sticky left-0 z-10 grid shrink-0 place-items-center border-r border-[var(--wb-separator)] text-[13px] font-semibold"
                  style={{ width: GUTTER_W, color: kind.color, ...stickyBg(tint) }}
                >
                  {kind.glyph}
                </div>
                {diff.columns.map((name, c) => {
                  const isKey = c < keyCount;
                  const a = leftCell(diff, left, row, c);
                  const b = rightCell(diff, right, row, c);
                  const isChanged = row.kind === 'changed' && row.changed.includes(c);
                  let content: React.ReactNode;
                  if (row.kind === 'duplicate' && !isKey) {
                    content =
                      c === keyCount ? (
                        <span className="text-[var(--wb-text-2)]">
                          {(row.lis?.length ?? 0).toLocaleString()} in A ·{' '}
                          {(row.ris?.length ?? 0).toLocaleString()} in B
                        </span>
                      ) : null;
                  } else if (isChanged) {
                    content = (
                      <>
                        <span className="truncate text-[var(--wb-text)] line-through decoration-[var(--wb-text-2)]">
                          <Value v={a} />
                        </span>
                        <span className="mx-1 shrink-0 text-[var(--wb-text-3)]" aria-hidden>
                          →
                        </span>
                        <span className="truncate font-semibold text-[var(--wb-text)]">
                          <Value v={b} />
                        </span>
                        <span className="sr-only">
                          changed from {isNullish(a) ? 'NULL' : cellText(a)} to{' '}
                          {isNullish(b) ? 'NULL' : cellText(b)}
                        </span>
                      </>
                    );
                  } else {
                    content = (
                      <span className="truncate">
                        <Value v={row.li >= 0 ? a : b} />
                      </span>
                    );
                  }
                  return (
                    <div
                      key={name}
                      role="gridcell"
                      className={cn(
                        'flex shrink-0 items-center border-r border-[var(--grid-line)] px-2 font-mono text-[var(--grid-text)]',
                        isKey && 'sticky z-10',
                      )}
                      style={{
                        width: widths[c],
                        ...(isKey ? { left: keyLeft[c], ...stickyBg(tint) } : {}),
                        ...(isChanged ? { backgroundColor: CHANGED_CELL_TINT } : {}),
                      }}
                      title={
                        isChanged
                          ? `${isNullish(a) ? 'NULL' : cellText(a)} → ${isNullish(b) ? 'NULL' : cellText(b)}`
                          : undefined
                      }
                    >
                      {content}
                    </div>
                  );
                })}
                {isSel && (
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-0 z-20 shadow-[inset_0_0_0_1.5px_var(--wb-accent)]"
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
