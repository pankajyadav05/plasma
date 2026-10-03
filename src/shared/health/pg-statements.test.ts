import { describe, expect, it } from 'vitest';
import { runStatementsCheck } from './pg-checks';
import { explainSql, interpretStatements, loadStatements, parseStatements } from './pg-statements';

const row = (over: Record<string, unknown>) => ({
  queryid: '1',
  query: 'SELECT 1',
  calls: 10,
  total_ms: 100,
  mean_ms: 10,
  rows: 10,
  shared_blks_hit: 90,
  shared_blks_read: 10,
  ...over,
});

describe('pg_stat_statements', () => {
  it('computes hit percentage and handles zero blocks', () => {
    const [a, b] = parseStatements([row({}), row({ shared_blks_hit: 0, shared_blks_read: 0 })]);
    expect(a?.hitPct).toBe(90);
    expect(b?.hitPct).toBeNull();
  });

  it('flags a dominant statement and slow averages', () => {
    const r = interpretStatements([
      row({ queryid: 'a', total_ms: 90_000, mean_ms: 3000, calls: 30 }),
      row({ queryid: 'b', total_ms: 1000, mean_ms: 5, calls: 200 }),
    ]);
    expect(r.findings.map((f) => f.id)).toEqual(['stmt-share:a', 'stmt-slow:a']);
  });

  it('builds EXPLAIN text, using GENERIC_PLAN for normalised statements', () => {
    expect(explainSql('SELECT * FROM t;')).toBe('EXPLAIN SELECT * FROM t;');
    expect(explainSql('SELECT * FROM t WHERE id = $1')).toContain(
      'EXPLAIN (GENERIC_PLAN) SELECT * FROM t WHERE id = $1;',
    );
  });

  it('falls back to pre-13 column names', async () => {
    const seen: string[] = [];
    const rows = await loadStatements(async (sql) => {
      seen.push(sql);
      if (sql.includes('total_exec_time'))
        throw new Error('column "total_exec_time" does not exist');
      return [row({})];
    });
    expect(rows).toHaveLength(1);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain('total_time');
  });

  it('reports the extension as not installed, and privilege errors as unavailable', async () => {
    const missing = await runStatementsCheck(async () => {
      throw new Error('relation "pg_stat_statements" does not exist');
    });
    expect(missing.state).toBe('not-installed');
    const loaded = await runStatementsCheck(async () => {
      throw new Error('pg_stat_statements must be loaded via "shared_preload_libraries"');
    });
    expect(loaded.state).toBe('not-installed');
    const denied = await runStatementsCheck(async () => {
      throw new Error('permission denied for view pg_stat_statements');
    });
    expect(denied.state).toBe('unavailable');
    expect(denied.result.summary).toBe('needs pg_monitor');
  });
});
