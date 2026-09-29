import { describe, expect, it } from 'vitest';
import { globEscape, globToRegExp, naturalCompare, plural, streamIdTime } from './redis-format';

describe('redis-format', () => {
  it('sorts naturally (F11)', () => {
    expect(['167', '321', '69', '1', '10', 'a'].sort(naturalCompare)).toEqual([
      '1',
      '10',
      '69',
      '167',
      '321',
      'a',
    ]);
  });
  it('pluralises (F38)', () => {
    expect(plural(1, 'key')).toBe('1 key');
    expect(plural(2, 'key')).toBe('2 keys');
    expect(plural(1204, 'entry', 'entries')).toBe('1,204 entries');
  });
  it('humanises stream ids (F38)', () => {
    expect(streamIdTime('1727600000000-0')).toMatch(/^2024-09-29 \d\d:\d\d:20\.000$/);
    expect(streamIdTime('not-an-id')).toBeNull();
  });
  it('globs', () => {
    expect(globEscape('a*b[1]')).toBe('a\\*b\\[1\\]');
    expect(globToRegExp('news:*').test('news:sports')).toBe(true);
    expect(globToRegExp('h?llo').test('hello')).toBe(true);
    expect(globToRegExp('h[ae]llo').test('hillo')).toBe(false);
    expect(globToRegExp('a.b').test('axb')).toBe(false);
    expect(globToRegExp('a\\*').test('a*')).toBe(true);
  });
});
