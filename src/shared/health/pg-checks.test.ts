import { describe, expect, it } from 'vitest';
import { PG_CHECKS, runPgCheck } from './pg-checks';

describe('runPgCheck', () => {
  const check = PG_CHECKS[0];
  if (!check) throw new Error('no checks');

  it('degrades a privilege error to an unknown result instead of throwing', async () => {
    const r = await runPgCheck(check, async () => {
      throw new Error('permission denied for function pg_ls_waldir');
    });
    expect(r.status).toBe('unknown');
    expect(r.summary).toBe('needs pg_monitor');
  });

  it('passes the check timeout and params to the query function', async () => {
    const seen: Array<[unknown[] | undefined, number]> = [];
    const sessions = PG_CHECKS.find((c) => c.id === 'ov-sessions');
    if (!sessions) throw new Error('missing');
    await runPgCheck(sessions, async (_sql, params, t) => {
      seen.push([params, t]);
      return [];
    });
    expect(seen[0]).toEqual([[300, 60], 15000]);
  });

  it('has unique ids and only read-only SQL', () => {
    const ids = PG_CHECKS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of PG_CHECKS)
      expect(c.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|VACUUM)\b/i);
  });
});
