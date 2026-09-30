import { describe, expect, it } from 'vitest';
import { runBootstrapSql } from './pg-bootstrap';

describe('runBootstrapSql', () => {
  it('runs each statement in order', async () => {
    const seen: string[] = [];
    const n = await runBootstrapSql(
      { query: async (s) => void seen.push(s) },
      "SET search_path = app, public;\nSET TIME ZONE 'UTC'; -- done",
    );
    expect(n).toBe(2);
    expect(seen).toEqual(['SET search_path = app, public', "SET TIME ZONE 'UTC'"]);
  });
  it('does nothing for blank input', async () => {
    expect(
      await runBootstrapSql({ query: async () => Promise.reject(new Error('no')) }, '  '),
    ).toBe(0);
    expect(await runBootstrapSql({ query: async () => undefined }, undefined)).toBe(0);
  });
  it('aborts with the failing statement', async () => {
    const seen: string[] = [];
    await expect(
      runBootstrapSql(
        {
          query: async (s) => {
            seen.push(s);
            if (s.startsWith('SET bad')) throw new Error('unrecognized parameter');
          },
        },
        'SET a = 1; SET bad = 2; SET c = 3',
      ),
    ).rejects.toThrow(/Bootstrap SQL failed at "SET bad = 2": unrecognized parameter/);
    expect(seen).toEqual(['SET a = 1', 'SET bad = 2']);
  });
});
