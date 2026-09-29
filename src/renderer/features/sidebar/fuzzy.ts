/**
 * Small fuzzy matcher for sidebar search (PC5). The query's characters
 * must appear in order in the text (case-insensitive); the score rewards
 * a prefix / exact match, consecutive runs and matches at word starts
 * (`user_accounts` ← "ua"), and penalises gaps and long names.
 */
export interface FuzzyMatch {
  score: number;
  /** Indices into `text` of each matched character. */
  indices: number[];
}

const BOUNDARY = /[\s_\-.:/]/;

function isWordStart(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1]!;
  const cur = text[i]!;
  if (BOUNDARY.test(prev)) return true;
  // camelCase hump
  return prev === prev.toLowerCase() && cur !== cur.toLowerCase();
}

export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, indices: [] };
  const t = text.toLowerCase();

  // Plain substring hits outrank scattered subsequences.
  const sub = t.indexOf(q);
  if (sub !== -1) {
    const indices = Array.from({ length: q.length }, (_, k) => sub + k);
    let score = 1000 - sub * 2 - (t.length - q.length);
    if (sub === 0) score += 500;
    if (t.length === q.length) score += 1000;
    else if (isWordStart(text, sub)) score += 200;
    return { score, indices };
  }

  // Greedy subsequence walk, preferring word starts when the next query
  // character appears at one before the plain next occurrence.
  const indices: number[] = [];
  let score = 0;
  let from = 0;
  let prev = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]!;
    let at = t.indexOf(ch, from);
    if (at === -1) return null;
    if (at !== prev + 1) {
      for (let j = at; j < t.length; j++) {
        if (t[j] === ch && isWordStart(text, j)) {
          // Only jump ahead if the rest of the query can still match.
          if (canMatch(q, qi + 1, t, j + 1)) at = j;
          break;
        }
      }
    }
    if (at === prev + 1) score += 15;
    else if (prev >= 0) score -= Math.min(at - prev - 1, 10);
    if (isWordStart(text, at)) score += 10;
    indices.push(at);
    prev = at;
    from = at + 1;
  }
  if (indices[0] === 0) score += 20;
  score -= Math.floor(t.length / 4);
  return { score, indices };
}

function canMatch(q: string, qi: number, t: string, from: number): boolean {
  let pos = from;
  for (let k = qi; k < q.length; k++) {
    pos = t.indexOf(q[k]!, pos);
    if (pos === -1) return false;
    pos++;
  }
  return true;
}

/**
 * Filter + rank `items` by `query`. Stable for equal scores. An empty
 * query returns the items unchanged.
 */
export function fuzzyFilter<T>(items: readonly T[], query: string, key: (item: T) => string): T[] {
  if (!query.trim()) return items.slice();
  const scored: Array<{ item: T; score: number; idx: number }> = [];
  items.forEach((item, idx) => {
    const m = fuzzyMatch(query, key(item));
    if (m) scored.push({ item, score: m.score, idx });
  });
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return scored.map((s) => s.item);
}
