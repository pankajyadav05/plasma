import {
  cellBytes,
  cellNote,
  cellText,
  escapeBytes,
  hexBytes,
  isEditableCell,
} from '@shared/redis-cell';
import { describe, expect, it } from 'vitest';
import { encodeCell } from './redis-value';

describe('redis cells (R12)', () => {
  it('keeps valid UTF-8 as plain editable strings', () => {
    const c = encodeCell(Buffer.from('héllo'));
    expect(c).toBe('héllo');
    expect(isEditableCell(c)).toBe(true);
  });

  it('ships binary as base64 and round-trips the bytes', () => {
    const bytes = Buffer.from([0xff, 0x00, 0x41]);
    const c = encodeCell(bytes)!;
    expect(isEditableCell(c)).toBe(false);
    expect(Buffer.from(cellBytes(c)).equals(bytes)).toBe(true);
    expect(cellText(c)).toBe('\\xff\\x00A');
    expect(cellNote(c)).toBe('binary · 3 B');
  });

  it('truncates large elements without splitting a UTF-8 character', () => {
    const c = encodeCell(Buffer.from('aé'.repeat(10)), 4)!;
    expect(c).toEqual({ $text: 'aéa', $bytes: 30, $truncated: true });
    expect(cellText(c)).toMatch(/^aéa… \(30 B\)$/);
  });

  it('escapes and hex-dumps', () => {
    expect(escapeBytes(new Uint8Array([0x22, 0x0a, 0x7f]))).toBe('\\"\\n\\x7f');
    expect(hexBytes(new Uint8Array([0x41, 0x42]))).toMatch(/^00000000 {2}4142\s+AB$/);
  });
});
