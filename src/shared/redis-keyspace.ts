/**
 * Redis keyspace notifications tail. The tail is an ordinary PSUBSCRIBE on
 * `__keyevent@<db>__:*`; whether the server publishes anything depends on
 * the `notify-keyspace-events` setting, which these helpers read and amend.
 */

export const NOTIFY_CONFIG_KEY = 'notify-keyspace-events';
export const KEYSPACE_ENABLE_COMMAND = ['CONFIG', 'SET', NOTIFY_CONFIG_KEY] as const;

/** The pattern that tails every key event of one logical database. */
export function keyeventPattern(db: number): string {
  return `__keyevent@${Math.max(0, Math.floor(db))}__:*`;
}

/** True for a `__keyevent@N__:*` tail pattern (what the keyspace banner keys off). */
export function isKeyeventPattern(channel: string): boolean {
  return /^__keyevent@\d+__:\*$/.test(channel);
}

/** `__keyevent@0__:expired` → `{ db: 0, event: 'expired' }`. */
export function parseKeyeventChannel(channel: string): { db: number; event: string } | null {
  const m = /^__keyevent@(\d+)__:(.+)$/.exec(channel);
  return m ? { db: Number(m[1]), event: m[2] as string } : null;
}

/** Pull the setting's value out of a `CONFIG GET` reply (flat array, object or bare string). */
export function parseNotifyConfigReply(reply: unknown): string | null {
  if (Array.isArray(reply)) {
    const i = reply.findIndex((v) => v === NOTIFY_CONFIG_KEY);
    const v = i >= 0 ? reply[i + 1] : reply.length === 1 ? reply[0] : undefined;
    return typeof v === 'string' ? v : null;
  }
  if (reply && typeof reply === 'object') {
    const v = (reply as Record<string, unknown>)[NOTIFY_CONFIG_KEY];
    return typeof v === 'string' ? v : null;
  }
  return typeof reply === 'string' ? reply : null;
}

const CLASS_LETTERS = 'g$lshzxetdmn';

/**
 * Does this flag string publish key *events* (the `E` channel family) for at
 * least one event class? (`K` alone only publishes `__keyspace@…` channels.)
 */
export function keyeventsEnabled(flags: string | null): boolean {
  if (!flags) return false;
  if (!flags.includes('E')) return false;
  return flags.includes('A') || [...CLASS_LETTERS].some((c) => flags.includes(c));
}

/** Current flags with keyevent publishing added; existing flags are kept. */
export function flagsWithKeyevents(current: string | null): string {
  const set = new Set((current ?? '').split('').filter(Boolean));
  set.add('E');
  if (![...CLASS_LETTERS].some((c) => set.has(c)) && !set.has('A')) set.add('A');
  return [...set].join('');
}
