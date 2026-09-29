/**
 * Command-palette ranking (VF23 / H1). cmdk's built-in fuzzy scorer ranks
 * any scattered-letter match close to a real prefix match ("ord" put
 * "Toggle dark mode" above the `orders` table) and only filters what is
 * rendered, so the palette used to cap tables *before* filtering. We
 * filter and rank ourselves, then cap.
 */

export interface RankedItem {
  /** Primary text the user searches (label / table name). */
  label: string;
  /** Extra searchable text (qualified name, group, synonyms). */
  keywords?: readonly string[];
  /** Small tie-break boost (e.g. actions over tables on equal scores). */
  boost?: number;
}

const WORD_SPLIT = /[\s._\-/:·()]+/;

/**
 * Score `query` against `text`: -1 = no match; higher is better.
 * exact > prefix > word-prefix > substring > in-order subsequence.
 */
export function scoreText(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  if (t === q) return 1000;
  if (t.startsWith(q)) return 900 - Math.min(100, t.length - q.length);
  const words = t.split(WORD_SPLIT).filter(Boolean);
  if (words.some((w) => w.startsWith(q))) return 700 - Math.min(100, t.length - q.length);
  // Multi-word query: every query word prefixes some word ("tog dark").
  const qWords = q.split(/\s+/).filter(Boolean);
  if (qWords.length > 1 && qWords.every((qw) => words.some((w) => w.startsWith(qw)))) return 600;
  const idx = t.indexOf(q);
  if (idx !== -1) return 500 - Math.min(100, idx);
  // Subsequence: rewarded for contiguous runs and word-start hits.
  let ti = 0;
  let score = 0;
  let run = 0;
  for (const ch of q) {
    if (ch === ' ') continue;
    const found = t.indexOf(ch, ti);
    if (found === -1) return -1;
    run = found === ti ? run + 1 : 0;
    const wordStart = found === 0 || WORD_SPLIT.test(t[found - 1]!);
    score += 1 + run * 2 + (wordStart ? 3 : 0);
    ti = found + 1;
  }
  return Math.min(300, 100 + score);
}

export function scoreItem(query: string, item: RankedItem): number {
  let best = scoreText(query, item.label);
  for (const k of item.keywords ?? []) {
    // Keywords count, but a label hit of the same strength wins.
    const s = scoreText(query, k);
    if (s > 0) best = Math.max(best, s - 5);
  }
  return best < 0 ? -1 : best + (item.boost ?? 0);
}

/**
 * Filter + rank `items` for `query`, keeping at most `limitPerGroup`
 * matches per group (tables are capped *after* filtering, so table 101+
 * is still findable) and `limit` overall. Stable for equal scores.
 */
export function rankItems<T extends RankedItem & { group: string }>(
  query: string,
  items: readonly T[],
  opts: { limit?: number; limitPerGroup?: Record<string, number> } = {},
): T[] {
  const scored: { item: T; score: number; i: number }[] = [];
  items.forEach((item, i) => {
    const score = scoreItem(query, item);
    if (score >= 0) scored.push({ item, score, i });
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  const perGroup = new Map<string, number>();
  const out: T[] = [];
  for (const { item } of scored) {
    const cap = opts.limitPerGroup?.[item.group];
    const n = perGroup.get(item.group) ?? 0;
    if (cap !== undefined && n >= cap) continue;
    perGroup.set(item.group, n + 1);
    out.push(item);
    if (opts.limit !== undefined && out.length >= opts.limit) break;
  }
  return out;
}
