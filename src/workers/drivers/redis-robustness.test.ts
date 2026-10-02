import { describe, expect, it } from 'vitest';
import { pubsubText, withServerBlockTimeout } from './redis';

describe('withServerBlockTimeout (P2-12)', () => {
  it('cuts "forever" and over-long waits to the cap so the server ends the wait first', () => {
    expect(withServerBlockTimeout(['BLPOP', 'q', '0'], 28_000)).toEqual(['BLPOP', 'q', '28']);
    expect(withServerBlockTimeout(['brpop', 'a', 'b', '600'], 28_000)).toEqual([
      'brpop',
      'a',
      'b',
      '28',
    ]);
    expect(withServerBlockTimeout(['BLMOVE', 's', 'd', 'LEFT', 'RIGHT', '0'], 28_000).at(-1)).toBe(
      '28',
    );
    expect(withServerBlockTimeout(['BLMPOP', '0', '1', 'q', 'LEFT'], 28_000)[1]).toBe('28');
    expect(withServerBlockTimeout(['XREAD', 'BLOCK', '0', 'STREAMS', 's', '$'], 28_000)[2]).toBe(
      '28000',
    );
  });

  it('leaves shorter waits and other commands alone', () => {
    expect(withServerBlockTimeout(['BLPOP', 'q', '5'], 28_000)).toEqual(['BLPOP', 'q', '5']);
    expect(withServerBlockTimeout(['GET', 'k'], 28_000)).toEqual(['GET', 'k']);
    expect(withServerBlockTimeout(['BLPOP', 'q', '1.5'], 28_000).at(-1)).toBe('1.5');
  });
});

describe('pubsubText (P2-9)', () => {
  it('keeps UTF-8, escapes binary, and caps huge payloads', () => {
    expect(pubsubText(Buffer.from('héllo'))).toBe('héllo');
    expect(pubsubText(Buffer.from([0xff, 0x41]))).toBe('\\xffA');
    const big = pubsubText(Buffer.alloc(200 * 1024, 0x61));
    expect(big.length).toBeLessThan(70 * 1024);
    expect(big).toMatch(/truncated\)$/);
  });
});
