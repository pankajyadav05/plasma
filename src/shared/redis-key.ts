/**
 * Binary-safe Redis key names over IPC (P2-8).
 *
 * Keys travel as strings, but Redis keys are byte strings. Decoding every
 * key as UTF-8 turned `\xff\xfe` into U+FFFD, after which TYPE / GET /
 * DEL / UNLINK addressed a different (non-existent) key, so such keys
 * vanished from the browser (or "deleted" nothing).
 *
 * A key whose bytes are not valid UTF-8, or that starts with NUL (the
 * marker itself), is sent in escaped form:  NUL + text, where backslash is
 * `\\` and every byte outside printable ASCII is `\xHH`. The renderer shows
 * it without the NUL (see `displayRedisKey`); the worker turns it back into
 * the exact Buffer before talking to Redis. All other keys are untouched.
 */

const MARK = '\u0000';

function isValidUtf8(buf: Buffer): boolean {
  return Buffer.from(buf.toString('utf8'), 'utf8').equals(buf);
}

/** Wire name for a key returned by Redis as raw bytes. */
export function encodeKey(buf: Buffer): string {
  if (buf.length > 0 && buf[0] !== 0 && isValidUtf8(buf)) return buf.toString('utf8');
  if (buf.length === 0) return '';
  let out = MARK;
  for (const b of buf) {
    if (b === 0x5c) out += '\\\\';
    else if (b >= 0x20 && b <= 0x7e) out += String.fromCharCode(b);
    else out += `\\x${b.toString(16).padStart(2, '0')}`;
  }
  return out;
}

/** True when `wire` is an escaped binary key. */
export function isBinaryKey(wire: string): boolean {
  return wire.startsWith(MARK);
}

/** The argument to hand to Redis for a wire key: the exact bytes for binary keys. */
export function decodeKey(wire: string): string | Buffer {
  if (!isBinaryKey(wire)) return wire;
  const bytes: number[] = [];
  const body = wire.slice(1);
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] as string;
    if (ch === '\\') {
      const next = body[i + 1];
      if (next === '\\') {
        bytes.push(0x5c);
        i += 1;
      } else if (next === 'x' && /^[0-9a-fA-F]{2}$/.test(body.slice(i + 2, i + 4))) {
        bytes.push(Number.parseInt(body.slice(i + 2, i + 4), 16));
        i += 3;
      } else {
        throw new Error('malformed binary key');
      }
    } else {
      bytes.push(ch.charCodeAt(0));
    }
  }
  return Buffer.from(bytes);
}

/** Text to show for a key: binary keys appear in their escaped form. */
export function displayRedisKey(wire: string): string {
  return isBinaryKey(wire) ? wire.slice(1) : wire;
}
