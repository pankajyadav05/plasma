/**
 * Small line + word diff for the side-by-side "Fix with AI" view. LCS based
 * (inputs are one SQL statement, a few hundred lines at most; capped).
 */

export interface DiffSegment {
  text: string;
  changed: boolean;
}

export interface DiffRow {
  kind: 'same' | 'change' | 'remove' | 'add';
  /** Left (original) side; absent for `add`. */
  left?: DiffSegment[];
  /** Right (suggested) side; absent for `remove`. */
  right?: DiffSegment[];
}

const MAX_LINES = 400;

function lcsTable<T>(a: readonly T[], b: readonly T[]): Uint32Array[] {
  const t = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      t[i]![j] = a[i] === b[j] ? t[i + 1]![j + 1]! + 1 : Math.max(t[i + 1]![j]!, t[i]![j + 1]!);
    }
  }
  return t;
}

/** Edit script between two sequences: [op, item] with op '=' | '-' | '+'. */
function editScript<T>(a: readonly T[], b: readonly T[]): Array<['=' | '-' | '+', T]> {
  const t = lcsTable(a, b);
  const out: Array<['=' | '-' | '+', T]> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(['=', a[i]!]);
      i++;
      j++;
    } else if (t[i + 1]![j]! >= t[i]![j + 1]!) {
      out.push(['-', a[i++]!]);
    } else {
      out.push(['+', b[j++]!]);
    }
  }
  while (i < a.length) out.push(['-', a[i++]!]);
  while (j < b.length) out.push(['+', b[j++]!]);
  return out;
}

const TOKEN = /\s+|[A-Za-z0-9_$]+|./g;

/** Word-level diff of two lines: segments for each side, `changed` marking the differences. */
export function diffWords(a: string, b: string): { left: DiffSegment[]; right: DiffSegment[] } {
  const ta = a.match(TOKEN) ?? [];
  const tb = b.match(TOKEN) ?? [];
  const left: DiffSegment[] = [];
  const right: DiffSegment[] = [];
  const push = (side: DiffSegment[], text: string, changed: boolean) => {
    const last = side[side.length - 1];
    if (last && last.changed === changed) last.text += text;
    else side.push({ text, changed });
  };
  for (const [op, tok] of editScript(ta, tb)) {
    if (op === '=') {
      push(left, tok, false);
      push(right, tok, false);
    } else if (op === '-') push(left, tok, true);
    else push(right, tok, true);
  }
  return { left, right };
}

/**
 * Side-by-side rows. A run of removed lines followed by added lines is
 * paired up row by row as `change` (with word-level highlights); leftovers
 * are plain `remove` / `add` rows.
 */
export function diffLines(original: string, suggested: string): DiffRow[] {
  const a = original.split('\n').slice(0, MAX_LINES);
  const b = suggested.split('\n').slice(0, MAX_LINES);
  const script = editScript(a, b);
  const rows: DiffRow[] = [];
  let k = 0;
  while (k < script.length) {
    const [op, line] = script[k]!;
    if (op === '=') {
      rows.push({
        kind: 'same',
        left: [{ text: line, changed: false }],
        right: [{ text: line, changed: false }],
      });
      k++;
      continue;
    }
    const removed: string[] = [];
    const added: string[] = [];
    while (k < script.length && script[k]![0] !== '=') {
      (script[k]![0] === '-' ? removed : added).push(script[k]![1]);
      k++;
    }
    const pairs = Math.min(removed.length, added.length);
    for (let p = 0; p < pairs; p++) {
      const w = diffWords(removed[p]!, added[p]!);
      rows.push({ kind: 'change', left: w.left, right: w.right });
    }
    for (const line2 of removed.slice(pairs)) {
      rows.push({ kind: 'remove', left: [{ text: line2, changed: true }] });
    }
    for (const line2 of added.slice(pairs)) {
      rows.push({ kind: 'add', right: [{ text: line2, changed: true }] });
    }
  }
  return rows;
}

/** True when the two texts are identical ignoring surrounding whitespace and a trailing `;`. */
export function sameStatement(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/;\s*$/, '').trim();
  return norm(a) === norm(b);
}

/**
 * Replace the failed statement in the editor buffer with `fixed`. Uses the
 * recorded error range while the text there is still the failed statement,
 * else a unique textual match; null when the statement can't be located
 * safely (the caller then offers "open in a new tab").
 */
export function applyFixToBuffer(
  buffer: string,
  range: { start: number; end: number } | null,
  original: string,
  fixed: string,
): string | null {
  if (range && buffer.slice(range.start, range.end) === original) {
    return buffer.slice(0, range.start) + fixed + buffer.slice(range.end);
  }
  const first = buffer.indexOf(original);
  if (first === -1 || buffer.indexOf(original, first + 1) !== -1) return null;
  return buffer.slice(0, first) + fixed + buffer.slice(first + original.length);
}
