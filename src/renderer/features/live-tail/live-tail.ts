/**
 * Shared bookkeeping for the live tails (Redis pub/sub + keyspace events,
 * Postgres LISTEN/NOTIFY): newest-first buffer with a cap and a drop counter,
 * text filter, JSON pretty-printing.
 */

export const TAIL_MAX_MESSAGES = 2000;

/** Channel of the synthetic row the workers emit when a flood was thinned. */
export const TAIL_SYSTEM_CHANNEL = '(plasma)';

export interface TailRowBase {
  seq: number;
  channel: string;
}

/** Prepend `row`; once over `cap` the oldest fall off and are counted. */
export function pushCapped<T>(
  rows: readonly T[],
  row: T,
  cap: number = TAIL_MAX_MESSAGES,
): { rows: T[]; dropped: number } {
  const next = [row, ...rows];
  if (next.length <= cap) return { rows: next, dropped: 0 };
  const dropped = next.length - cap;
  next.length = cap;
  return { rows: next, dropped };
}

/** The `N` of a worker "N messages/notifications were dropped" notice, else 0. */
export function droppedFromNotice(channel: string, text: string): number {
  if (channel !== TAIL_SYSTEM_CHANNEL) return 0;
  const m = /^([\d,]+) (?:messages|notifications) were dropped/.exec(text);
  return m ? Number((m[1] as string).replace(/,/g, '')) : 0;
}

/**
 * Case-insensitive substring filter over channel and payload. A leading
 * `channel:` or `payload:` limits the search to that field; `!term` negates.
 */
export function matchesTailFilter(channel: string, payload: string, filter: string): boolean {
  let q = filter.trim();
  if (!q) return true;
  let negate = false;
  if (q.startsWith('!')) {
    negate = true;
    q = q.slice(1).trim();
    if (!q) return true;
  }
  let field: 'both' | 'channel' | 'payload' = 'both';
  const m = /^(channel|payload):(.*)$/i.exec(q);
  if (m) {
    field = m[1]?.toLowerCase() as 'channel' | 'payload';
    q = (m[2] ?? '').trim();
  }
  const needle = q.toLowerCase();
  const hit =
    (field !== 'payload' && channel.toLowerCase().includes(needle)) ||
    (field !== 'channel' && payload.toLowerCase().includes(needle));
  return negate ? !hit : hit;
}

/** Pretty-print JSON payloads; anything else passes through. */
export function prettyPayload(message: string): string {
  const t = message.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return message;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return message;
  }
}

export function isJsonPayload(message: string): boolean {
  const t = message.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

export function fmtTailTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, w = 2) => n.toString().padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
