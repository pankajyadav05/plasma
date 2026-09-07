import { describe, expect, it } from 'vitest';
import {
  HISTORY_DURATION_MS,
  buildHistoryListQuery,
  escapeLike,
} from './history-query';

describe('escapeLike', () => {
  it('escapes backslash, percent, and underscore', () => {
    expect(escapeLike(`a%b_c\\d`)).toBe(`a\\%b\\_c\\\\d`);
  });

  it('leaves ordinary SQL text alone', () => {
    expect(escapeLike(`SELECT * FROM users WHERE id = 1`)).toBe(
      `SELECT * FROM users WHERE id = 1`,
    );
  });
});

describe('buildHistoryListQuery', () => {
  it('defaults to global newest-first with limit 500', () => {
    const q = buildHistoryListQuery();
    expect(q.sql).toMatch(/ORDER BY executed_at DESC/);
    expect(q.sql).toMatch(/LIMIT \?/);
    expect(q.params).toEqual([500]);
    expect(q.sql).not.toMatch(/WHERE/);
  });

  it('filters by connection_id so the composite index can be used', () => {
    const q = buildHistoryListQuery({ connectionId: 'conn-1', limit: 50 });
    expect(q.sql).toMatch(/WHERE connection_id = \?/);
    expect(q.params).toEqual(['conn-1', 50]);
  });

  it('adds a LIKE clause with escaped wildcards', () => {
    const q = buildHistoryListQuery({ search: 'foo%bar_baz' });
    expect(q.sql).toMatch(/sql LIKE \? ESCAPE '\\'/);
    expect(q.params[0]).toBe('%foo\\%bar\\_baz%');
    expect(q.params.at(-1)).toBe(500);
  });

  it('ignores blank search', () => {
    const q = buildHistoryListQuery({ search: '   ' });
    expect(q.sql).not.toMatch(/LIKE/);
  });

  it('facets by status=ok / error', () => {
    expect(buildHistoryListQuery({ status: 'ok' }).sql).toMatch(/error IS NULL/);
    expect(buildHistoryListQuery({ status: 'error' }).sql).toMatch(/error IS NOT NULL/);
    expect(buildHistoryListQuery({ status: 'all' }).sql).not.toMatch(/error IS/);
  });

  it('facets by duration buckets', () => {
    const fast = buildHistoryListQuery({ duration: 'fast' });
    expect(fast.sql).toMatch(/duration_ms < \?/);
    expect(fast.params).toContain(HISTORY_DURATION_MS.fastMax);

    const medium = buildHistoryListQuery({ duration: 'medium' });
    expect(medium.sql).toMatch(/duration_ms >= \? AND duration_ms <= \?/);
    expect(medium.params).toEqual([
      HISTORY_DURATION_MS.fastMax,
      HISTORY_DURATION_MS.mediumMax,
      500,
    ]);

    const slow = buildHistoryListQuery({ duration: 'slow' });
    expect(slow.sql).toMatch(/duration_ms > \?/);
    expect(slow.params).toContain(HISTORY_DURATION_MS.mediumMax);
  });

  it('combines connection + search + status + duration', () => {
    const q = buildHistoryListQuery({
      connectionId: 'c1',
      search: 'select',
      status: 'error',
      duration: 'slow',
      limit: 25,
    });
    expect(q.sql).toMatch(/connection_id = \?/);
    expect(q.sql).toMatch(/sql LIKE \?/);
    expect(q.sql).toMatch(/error IS NOT NULL/);
    expect(q.sql).toMatch(/duration_ms > \?/);
    expect(q.params).toEqual([
      'c1',
      '%select%',
      HISTORY_DURATION_MS.mediumMax,
      25,
    ]);
  });

  it('clamps limit to [1, 5000]', () => {
    expect(buildHistoryListQuery({ limit: 0 }).params.at(-1)).toBe(1);
    expect(buildHistoryListQuery({ limit: 99999 }).params.at(-1)).toBe(5000);
  });
});
