import { describe, expect, it } from 'vitest';
import { decodeKey, displayRedisKey, encodeKey, isBinaryKey } from './redis-key';

describe('binary-safe Redis keys (P2-8)', () => {
  it('passes ordinary UTF-8 keys through untouched', () => {
    for (const k of ['user:1', 'ключ', '日本語', 'a b', 'with\\backslash']) {
      expect(encodeKey(Buffer.from(k))).toBe(k);
      expect(decodeKey(k)).toBe(k);
    }
  });

  it('escapes non-UTF-8 keys and restores the exact bytes', () => {
    const raw = Buffer.from([0xff, 0xfe, 0x41, 0x5c, 0x00, 0x80]);
    const wire = encodeKey(raw);
    expect(isBinaryKey(wire)).toBe(true);
    expect(displayRedisKey(wire)).toBe('\\xff\\xfeA\\\\\\x00\\x80');
    expect((decodeKey(wire) as Buffer).equals(raw)).toBe(true);
  });

  it('marks a valid key that starts with NUL so it cannot be confused with the marker', () => {
    const raw = Buffer.from('\u0000bin:abc');
    const wire = encodeKey(raw);
    expect(isBinaryKey(wire)).toBe(true);
    expect((decodeKey(wire) as Buffer).equals(raw)).toBe(true);
  });

  it('keeps a literal \\xHH text key as text', () => {
    expect(decodeKey('\\xff')).toBe('\\xff');
  });

  it('rejects a malformed escape', () => {
    expect(() => decodeKey('\u0000\\q')).toThrow(/malformed/);
  });
});
