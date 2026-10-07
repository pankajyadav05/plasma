/**
 * JSON.parse that does not round integers beyond 2^53.
 *
 * `{"id": 9007199254740993}` parses to 9007199254740992 in a JS number, and a
 * cell edited or re-sent from that value then writes a different number back.
 * Those integers (and only those) come through as their exact digits in a
 * string; every other number, key order and duplicate keys behave as
 * JSON.parse does. Needs the `context.source` reviver argument (Node 21+,
 * Electron 30+); older engines get plain JSON.parse behaviour.
 */
export function parseJsonKeepingBigInts(text: string): unknown {
  return JSON.parse(text, function reviver(_key, value, context?: { source?: string }) {
    if (
      typeof value === 'number' &&
      Number.isInteger(value) &&
      !Number.isSafeInteger(value) &&
      typeof context?.source === 'string' &&
      /^-?\d+$/.test(context.source)
    ) {
      return context.source;
    }
    return value;
  } as Parameters<typeof JSON.parse>[1]);
}
