import { describe, expect, it } from 'vitest';
import { MAX_BIND_PARAMS, buildMockInserts } from './mock-insert';

describe('buildMockInserts (R-23)', () => {
  it('splits 5000 rows x 14 columns into batches under the bind-parameter limit', () => {
    const columns = Array.from({ length: 14 }, (_, i) => `c${i}`);
    const batches = buildMockInserts({
      schema: 'public',
      table: 't',
      columns,
      count: 5000,
      cell: (c, r) => `${c}-${r}`,
    });
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.reduce((n, b) => n + b.rows, 0)).toBe(5000);
    for (const b of batches) {
      expect(b.params.length).toBeLessThanOrEqual(MAX_BIND_PARAMS);
      expect(b.params.length).toBeLessThan(65_535);
    }
  });

  it('keeps one statement for small requests and numbers parameters per statement', () => {
    const [only, ...rest] = buildMockInserts({
      schema: 'public',
      table: 'users',
      columns: ['id', 'email', 'note'],
      count: 2,
      cell: (c, r) => (c === 0 ? undefined : c === 2 ? null : `e${r}`),
    });
    expect(rest).toEqual([]);
    expect(only?.sql).toBe(
      'INSERT INTO "public"."users" ("id", "email", "note") VALUES\n(DEFAULT, $1, NULL),\n(DEFAULT, $2, NULL)',
    );
    expect(only?.params).toEqual(['e0', 'e1']);
  });

  it('restarts $n numbering in every batch', () => {
    const batches = buildMockInserts({
      schema: 's',
      table: 't',
      columns: ['a', 'b'],
      count: 5,
      cell: () => 'x',
      maxParams: 4,
    });
    expect(batches.map((b) => b.rows)).toEqual([2, 2, 1]);
    expect(batches[1]?.sql).toContain('($1, $2),\n($3, $4)');
  });
});
