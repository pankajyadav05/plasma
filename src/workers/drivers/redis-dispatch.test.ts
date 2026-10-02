import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatCompositeCursor, parseCompositeCursor } from './redis';
import { REDIS_RESPONSE_KIND, dispatchRedis } from './redis-dispatch';

describe('redis response kinds (S4 / R1)', () => {
  it('main expects exactly the response kind the worker sends', () => {
    const main = readFileSync(
      fileURLToPath(new URL('../../main/index.ts', import.meta.url)),
      'utf8',
    );
    let checked = 0;
    for (const [req, res] of Object.entries(REDIS_RESPONSE_KIND)) {
      const re = new RegExp(
        `callWorker\\(\\s*\\{\\s*kind:\\s*'${req}'[\\s\\S]*?\\},\\s*'([a-zA-Z]+)'`,
        'g',
      );
      const found = [...main.matchAll(re)].map((m) => m[1]);
      for (const f of found) expect(`${req}→${f}`).toBe(`${req}→${res}`);
      checked += found.length;
    }
    expect(checked).toBeGreaterThanOrEqual(Object.keys(REDIS_RESPONSE_KIND).length - 1);
  });

  it('dispatch sends the declared kind', async () => {
    const sent: string[] = [];
    const fake = {
      bulkDelete: async () => ({ deleted: ['a'], failed: [] }),
      deleteByPattern: async () => ({
        matched: 0,
        deleted: 0,
        sample: [],
        capped: false,
        failed: 0,
        dryRun: true,
      }),
      cancel: () => {},
    } as never;
    await dispatchRedis(fake, { kind: 'redisBulkDelete', id: '1', keys: ['a'] }, (r) =>
      sent.push(r.kind),
    );
    await dispatchRedis(
      fake,
      { kind: 'redisDeleteByPattern', id: '2', match: 'a*', dryRun: true, limit: 10 },
      (r) => sent.push(r.kind),
    );
    await dispatchRedis(fake, { kind: 'redisCancel', id: '3' }, (r) => sent.push(r.kind));
    expect(sent).toEqual([
      REDIS_RESPONSE_KIND.redisBulkDelete,
      REDIS_RESPONSE_KIND.redisDeleteByPattern,
      REDIS_RESPONSE_KIND.redisCancel,
    ]);
  });
});

describe('cluster composite cursor', () => {
  it('round-trips and degrades to plain cursors on one node', () => {
    expect(parseCompositeCursor('0', 3)).toEqual({ node: 0, cursor: '0' });
    expect(parseCompositeCursor(formatCompositeCursor(2, '123', 3), 3)).toEqual({
      node: 2,
      cursor: '123',
    });
    expect(formatCompositeCursor(0, '55', 1)).toBe('55');
    expect(parseCompositeCursor('9:1', 3)).toEqual({ node: 0, cursor: '1' });
  });
});

describe('cluster SCAN cursor follows node identity (P2-13)', () => {
  const ids = ['a:7000', 'b:7001', 'c:7002'];

  it('round-trips by node id', () => {
    const cur = formatCompositeCursor(1, '77', ids);
    expect(cur).toBe('b:7001|77');
    expect(parseCompositeCursor(cur, ids)).toEqual({ node: 1, cursor: '77' });
  });

  it('keeps pointing at the same master when the node order changes', () => {
    const cur = formatCompositeCursor(1, '77', ids);
    // A master was added before it: the positional index would now mean another node.
    const after = ['a:7000', 'a:7005', 'b:7001', 'c:7002'];
    expect(parseCompositeCursor(cur, after)).toEqual({ node: 2, cursor: '77' });
  });

  it('restarts at the next node, from 0, when the named master is gone', () => {
    const cur = formatCompositeCursor(1, '77', ids);
    expect(parseCompositeCursor(cur, ['a:7000', 'c:7002'])).toEqual({ node: 1, cursor: '0' });
    expect(parseCompositeCursor(cur, ['a:7000'])).toEqual({ node: 0, cursor: '0' });
  });

  it('still reads the legacy positional form', () => {
    expect(parseCompositeCursor('2:55', ids)).toEqual({ node: 2, cursor: '55' });
  });
});
