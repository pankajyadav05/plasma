import { describe, expect, it } from 'vitest';
import {
  computeColumnStats,
  formatStatLine,
  formatStatNumber,
  isNumericTypeName,
} from './column-stats';

const data: Record<string, string | null | undefined> = {
  '0:0': '10',
  '1:0': '2.5',
  '2:0': null,
  '3:0': '-4',
  '0:1': 'a',
  '1:1': null,
  '2:1': 'c',
  '3:1': undefined,
  '0:2': '2024-03-01',
  '1:2': '2023-12-31',
  '2:2': '2024-05-09',
  '3:2': null,
  '0:3': 'NaN',
  '1:3': '5',
};
const textAt = (r: number, c: number) => {
  const k = `${r}:${c}`;
  if (k in data) return data[k];
  return r > 1 && c === 3 ? null : undefined;
};

describe('computeColumnStats', () => {
  const stats = computeColumnStats(
    [
      { col: 0, name: 'amount', typeName: 'numeric' },
      { col: 1, name: 'label', typeName: 'text' },
      { col: 2, name: 'day', typeName: 'date' },
      { col: 3, name: 'f', typeName: 'float8' },
    ],
    0,
    3,
    textAt,
  );
  it('sums, averages and bounds numeric columns, ignoring NULLs', () => {
    expect(stats[0]).toMatchObject({ count: 3, nulls: 1, cells: 4, sum: 8.5, min: -4, max: 10 });
    expect(stats[0]?.avg).toBeCloseTo(8.5 / 3);
  });
  it('counts text columns without numeric aggregates and skips DEFAULT placeholders', () => {
    expect(stats[1]).toMatchObject({ count: 2, nulls: 1, cells: 3 });
    expect(stats[1]?.sum).toBeUndefined();
    expect(stats[1]?.min).toBeUndefined();
  });
  it('bounds date columns chronologically', () => {
    expect(stats[2]).toMatchObject({ count: 3, min: '2023-12-31', max: '2024-05-09' });
    expect(stats[2]?.sum).toBeUndefined();
  });
  it('ignores NaN when aggregating', () => {
    expect(stats[3]).toMatchObject({ count: 2, numericCount: 1, sum: 5, min: 5, max: 5 });
  });
  it('handles an all-NULL numeric column', () => {
    const s = computeColumnStats([{ col: 5, name: 'x', typeName: 'int4' }], 0, 1, () => null)[0]!;
    expect(s).toMatchObject({ count: 0, nulls: 2 });
    expect(s.sum).toBeUndefined();
    expect(formatStatLine(s)).toBe('count 0 · null 2');
  });
});

describe('formatting', () => {
  it('trims float noise and groups thousands', () => {
    expect(formatStatNumber(0.1 + 0.2)).toBe('0.3');
    expect(formatStatNumber(1234567)).toBe('1,234,567');
    expect(formatStatNumber(28.375)).toBe('28.375');
    expect(formatStatNumber(1 / 3)).toBe('0.3333');
  });
  it('writes a one-line summary', () => {
    const line = formatStatLine({
      col: 0,
      name: 'p',
      cells: 12,
      count: 12,
      nulls: 0,
      numeric: true,
      numericCount: 12,
      sum: 340.5,
      avg: 28.375,
      min: 1,
      max: 99,
    });
    expect(line).toBe('count 12 · sum 340.5 · avg 28.375 · min 1 · max 99');
  });
  it('recognises numeric type names', () => {
    expect(isNumericTypeName('int8')).toBe(true);
    expect(isNumericTypeName('numeric(10,2)')).toBe(true);
    expect(isNumericTypeName('text')).toBe(false);
  });
});
