/**
 * Column auto-fit (pure): the width that fits a header and the widest
 * sampled cell texts, clamped. Text width comes from an injected `measure`
 * (a canvas 2D context in the app) so the rule is testable without a DOM.
 */
export interface AutoFitOptions {
  /** Horizontal padding added to the widest content (cell padding + FK arrow room). */
  padding?: number;
  min?: number;
  max?: number;
  /** Rows measured; the longest texts are picked from a larger sample first. */
  sampleRows?: number;
  /** Extra room for the sort arrow + header menu button. */
  headerExtra?: number;
  /** Header text uses a different font than the cells. */
  measureHeader?: (text: string) => number;
}

export const AUTOFIT_MIN_PX = 60;
/** Matches the grid cell's max-width, so a fitted column never outgrows what a cell can show. */
export const AUTOFIT_MAX_PX = 480;

/**
 * Width in px for a column. Only the few longest strings (by char count) are
 * measured — in a proportional or monospace font the widest string is among
 * them — which keeps a 10k-row page instant.
 */
export function autoFitWidth(
  header: string,
  cellTexts: Iterable<string | null | undefined>,
  measure: (text: string) => number,
  opts: AutoFitOptions = {},
): number {
  const {
    padding = 24,
    min = AUTOFIT_MIN_PX,
    max = AUTOFIT_MAX_PX,
    sampleRows = 2000,
    headerExtra = 48,
  } = opts;
  const longest: string[] = [];
  let seen = 0;
  for (const t of cellTexts) {
    if (seen++ >= sampleRows) break;
    if (!t) continue;
    // Multi-line values render on one line, truncated: measure the first line.
    const line = t.includes('\n') ? (t.split('\n')[0] ?? '') : t;
    longest.push(line.length > 400 ? line.slice(0, 400) : line);
  }
  longest.sort((a, b) => b.length - a.length);
  let widest = 0;
  for (const t of longest.slice(0, 12)) widest = Math.max(widest, measure(t));
  const headerWidth = (opts.measureHeader ?? measure)(header) + headerExtra;
  return Math.round(Math.min(max, Math.max(min, Math.max(widest + padding, headerWidth))));
}

/**
 * Columns to pin so that everything from the left edge up to and including
 * `target` is frozen. `visibleNames` is the display order; columns already
 * pinned are left out (the caller toggles the returned ones on).
 */
export function columnsToFreeze(
  visibleNames: readonly string[],
  target: string,
  alreadyPinned: ReadonlySet<string>,
): string[] {
  const end = visibleNames.indexOf(target);
  if (end < 0) return [];
  return visibleNames.slice(0, end + 1).filter((n) => !alreadyPinned.has(n));
}
