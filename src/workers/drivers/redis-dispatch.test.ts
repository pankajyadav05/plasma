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
