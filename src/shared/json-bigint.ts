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

/** Like `parseJsonKeepingBigInts`, and says whether any integer had to be kept as text. */
export function parseJsonReportingBigInts(text: string): { value: unknown; kept: boolean } {
  let kept = false;
  const value = JSON.parse(text, function reviver(_key, v, context?: { source?: string }) {
    if (
      typeof v === 'number' &&
      Number.isInteger(v) &&
      !Number.isSafeInteger(v) &&
      typeof context?.source === 'string' &&
      /^-?\d+$/.test(context.source)
    ) {
      kept = true;
      return context.source;
    }
    return v;
  } as Parameters<typeof JSON.parse>[1]);
  return { value, kept };
}

/** The text of the value of top-level `key` in a JSON object, untouched, or null. */
export function topLevelJsonValue(text: string, key: string): string | null {
  const n = text.length;
  let i = 0;
  const skipWs = () => {
    while (i < n && /\s/.test(text[i] as string)) i++;
  };
  const readString = (): string => {
    const start = i;
    i++;
    while (i < n && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i++;
    return text.slice(start, i);
  };
  const skipValue = (): void => {
    skipWs();
    const c = text[i];
    if (c === '"') {
      readString();
    } else if (c === '{' || c === '[') {
      let depth = 0;
      while (i < n) {
        const d = text[i];
        if (d === '"') {
          readString();
          continue;
        }
        if (d === '{' || d === '[') depth++;
        if (d === '}' || d === ']') depth--;
        i++;
        if (depth === 0) break;
      }
    } else {
      while (i < n && !/[,}\]\s]/.test(text[i] as string)) i++;
    }
  };
  skipWs();
  if (text[i] !== '{') return null;
  i++;
  while (i < n) {
    skipWs();
    if (text[i] === '}') return null;
    if (text[i] === ',') {
      i++;
      continue;
    }
    if (text[i] !== '"') return null;
    const name = JSON.parse(readString()) as string;
    skipWs();
    if (text[i] !== ':') return null;
    i++;
    skipWs();
    const start = i;
    skipValue();
    if (name === key) return text.slice(start, i);
  }
  return null;
}

/** Indent JSON text without parsing its numbers, so every digit stays as it was. */
export function prettyJsonText(text: string, indent = 2): string {
  let out = '';
  let depth = 0;
  const n = text.length;
  const pad = () => `\n${' '.repeat(depth * indent)}`;
  for (let i = 0; i < n; i++) {
    const c = text[i] as string;
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']';
      let j = i + 1;
      while (j < n && /\s/.test(text[j] as string)) j++;
      if (text[j] === close) {
        out += c + close;
        i = j;
      } else {
        depth++;
        out += c + pad();
      }
    } else if (c === '}' || c === ']') {
      depth--;
      out += pad() + c;
    } else if (c === ',') {
      out += `,${pad()}`;
    } else if (c === ':') {
      out += ': ';
    } else if (!/\s/.test(c)) {
      out += c;
    }
  }
  return out;
}
