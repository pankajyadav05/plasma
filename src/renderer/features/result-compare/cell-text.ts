/** How a compared cell reads in the diff grid. NULL is shown by the caller (it has its own style). */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'bigint' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString();
  if (v instanceof Uint8Array) {
    const hex = Array.from(v.slice(0, 32), (b) => b.toString(16).padStart(2, '0')).join('');
    return `\\x${hex}${v.length > 32 ? '…' : ''}`;
  }
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

export const isNullish = (v: unknown): boolean => v === null || v === undefined;

/** A pixel width for a column from its header and the longest of a sample of its cells. */
export function columnWidth(headerChars: number, sampleChars: number): number {
  const chars = Math.max(headerChars, sampleChars);
  return Math.round(Math.min(320, Math.max(88, 22 + chars * 7.4)));
}

/** "14:02:11" for today, "Oct 7, 14:02" otherwise. */
export function formatCaptured(at: number | null, now = Date.now()): string {
  if (at === null) return '';
  const d = new Date(at);
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  if (new Date(now).toDateString() === d.toDateString()) return t;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${t}`;
}
