import { describe, expect, it } from 'vitest';
import { parseJsonKeepingBigInts } from './json-bigint';

describe('parseJsonKeepingBigInts', () => {
  it('keeps an integer beyond 2^53 as its exact digits', () => {
    expect(parseJsonKeepingBigInts('{"id":9007199254740993,"n":[-9223372036854775808]}')).toEqual({
      id: '9007199254740993',
      n: ['-9223372036854775808'],
    });
  });

  it('leaves every other number alone', () => {
    expect(parseJsonKeepingBigInts('[1, -2, 1.5, 1e3, 9007199254740991, 0.1]')).toEqual([
      1, -2, 1.5, 1000, 9007199254740991, 0.1,
    ]);
    // A float that happens to be huge is not an integer literal: JSON.parse behaviour.
    expect(parseJsonKeepingBigInts('1e30')).toBe(1e30);
  });

  it('keeps strings that look like numbers, and rejects bad JSON like JSON.parse', () => {
    expect(parseJsonKeepingBigInts('"9007199254740993"')).toBe('9007199254740993');
    expect(() => parseJsonKeepingBigInts('{nope')).toThrow();
  });
});
