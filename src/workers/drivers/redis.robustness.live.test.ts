/**
 * Live Redis checks for the robustness fixes (P2-8, P2-9, P2-10, P2-12) —
 * opt-in: PLASMA_LIVE_REDIS=redis://127.0.0.1:6502 (a throwaway server: the
 * suite FLUSHALLs it). Run it alone or with --no-file-parallelism:
 * redis.live.test.ts shares the server and flushes it too.
 */
import type { ConnectionConfig, RedisPubsubMessage } from '@shared/protocol';
import { decodeKey, displayRedisKey, encodeKey } from '@shared/redis-key';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisDriver } from './redis';

const LIVE = process.env.PLASMA_LIVE_REDIS;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function config(): ConnectionConfig {
  const url = new URL(LIVE ?? 'redis://127.0.0.1:6379');
  return {
    id: 'live-redis-rob',
    name: 'live',
    engine: 'redis',
    host: url.hostname,
    port: Number(url.port || 6379),
    database: '0',
    user: '',
    password: '',
    ssl: false,
    readOnly: false,
  } as ConnectionConfig;
}

describe.skipIf(!LIVE)('RedisDriver robustness (live)', () => {
  let raw: InstanceType<typeof Redis>;
  const r = new RedisDriver();
  const binKey = Buffer.from([0xff, 0xfe, 0x6b, 0x00, 0x80]);

  beforeAll(async () => {
    const url = new URL(LIVE as string);
    raw = new Redis({ host: url.hostname, port: Number(url.port || 6379) });
    await raw.flushall();
    await raw.set(binKey, 'binary-value');
    await raw.set('plain:key', 'v');
    await r.connect(config());
  });

  afterAll(async () => {
    await r.disconnect();
    raw.disconnect();
  });

  it('P2-8: a non-UTF-8 key is listed, readable, and deletable by its exact bytes', async () => {
    const res = await r.scan({ cursor: '0', count: 100, minResults: 2 });
    const bin = res.keys.find((k) => k.key !== 'plain:key');
    expect(bin).toBeDefined();
    expect(bin?.type).toBe('string');
    expect(displayRedisKey(bin!.key)).toBe('\\xff\\xfek\\x00\\x80');
    expect((decodeKey(bin!.key) as Buffer).equals(binKey)).toBe(true);
    expect(bin!.key).toBe(encodeKey(binKey));

    const got = await r.getKey(bin!.key);
    expect(got.type).toBe('string');
    expect(got.value).toBe('binary-value');
    expect(got.key).toBe(bin!.key);

    await r.setTtl(bin!.key, 500);
    expect(await raw.ttl(binKey)).toBeGreaterThan(0);

    await r.write({ kind: 'setString', key: bin!.key, value: 'changed' });
    expect((await raw.getBuffer(binKey))?.toString()).toBe('changed');

    const del = await r.bulkDelete([bin!.key]);
    expect(del.deleted).toEqual([bin!.key]);
    expect(await raw.exists(binKey)).toBe(0);
  });

  it('P2-8: delete-by-pattern really removes the binary keys it counted', async () => {
    await raw.flushall();
    await raw.set(Buffer.from([0xc3, 0x28, 0x7a]), '1');
    await raw.set(Buffer.from([0xff, 0xff]), '2');
    await raw.set('plain:key', 'v');
    const dry = await r.deleteByPattern({ match: '*', dryRun: true, limit: 100 });
    expect(dry.matched).toBe(3);
    const real = await r.deleteByPattern({ match: '*', dryRun: false, limit: 100 });
    expect(real).toMatchObject({ matched: 3, deleted: 3, failed: 0 });
    expect(await raw.dbsize()).toBe(0);
    await raw.set('plain:key', 'v');
  });

  it('P2-9: concurrent subscribes share one subscriber connection', async () => {
    const before = Number(/connected_clients:(\d+)/.exec(await raw.info('clients'))?.[1] ?? 0);
    const seen: RedisPubsubMessage[] = [];
    r.setPubsubListener((m) => seen.push(m));
    await Promise.all([
      r.subscribe('chan:a', false),
      r.subscribe('chan:b', false),
      r.subscribe('chan:*', true),
    ]);
    const during = Number(/connected_clients:(\d+)/.exec(await raw.info('clients'))?.[1] ?? 0);
    expect(during - before).toBe(1);
    await raw.publish('chan:a', 'hello');
    await sleep(150);
    expect(seen.filter((m) => m.message === 'hello').length).toBe(2); // exact + pattern
    await Promise.all([
      r.unsubscribe('chan:a', false),
      r.unsubscribe('chan:b', false),
      r.unsubscribe('chan:*', true),
    ]);
    await sleep(100);
    const after = Number(/connected_clients:(\d+)/.exec(await raw.info('clients'))?.[1] ?? 0);
    expect(after).toBe(before);
    r.setPubsubListener(null);
  });

  it('P2-9: a flood is batched and capped, with one notice for the drops', async () => {
    const seen: RedisPubsubMessage[] = [];
    r.setPubsubListener((m) => seen.push(m));
    await r.subscribe('flood', false);
    const pipe = raw.pipeline();
    for (let i = 0; i < 2000; i++) pipe.publish('flood', `m${i}`);
    await pipe.exec();
    await sleep(400);
    const real = seen.filter((m) => m.channel === 'flood');
    const notice = seen.find((m) => m.channel === '(plasma)');
    expect(real.length).toBeLessThan(2000);
    expect(real.length).toBeGreaterThan(0);
    expect(notice?.message).toMatch(/dropped/);
    await r.unsubscribe('flood', false);
    r.setPubsubListener(null);
  });

  it('P2-9: binary pub/sub payloads are shown escaped, not mangled', async () => {
    const seen: RedisPubsubMessage[] = [];
    r.setPubsubListener((m) => seen.push(m));
    await r.subscribe('bin', false);
    await raw.publish('bin', Buffer.from([0xff, 0x41]) as unknown as string);
    await sleep(150);
    expect(seen.find((m) => m.channel === 'bin')?.message).toBe('\\xffA');
    await r.unsubscribe('bin', false);
    r.setPubsubListener(null);
  });

  it('P2-10: a list of large elements is read in windows and still returns every preview', async () => {
    const big = 'x'.repeat(2 * 1024 * 1024); // 2 MB each
    await raw.del('hugelist');
    for (let i = 0; i < 12; i++) await raw.rpush('hugelist', big);
    // MONITOR counts the LRANGE round trips: windows, not one 500-element read.
    const mon = await raw.monitor();
    const ranges: string[] = [];
    mon.on('monitor', (_t, args) => {
      if (String(args[0]).toUpperCase() === 'LRANGE') ranges.push(args.join(' '));
    });
    const res = await r.getKey('hugelist', { count: 500 });
    mon.disconnect();
    const items = (res.value as { items: unknown[] }).items;
    expect(items).toHaveLength(12);
    expect(res.nextCursor).toBeNull();
    // 2 MB average -> windows of 1 element rather than a single 500-element LRANGE.
    expect(ranges.length).toBeGreaterThan(1);
    await raw.del('hugelist');
  });

  it('P2-12: a blocking pop is cut by the server before the client gives up, and cancel does not lose an element', async () => {
    await raw.del('q');
    const pending = r.command(['BLPOP', 'q', '0']);
    await sleep(200);
    r.cancel();
    const outcome = await Promise.race([
      pending.then(
        (x) => x,
        (e: Error) => e,
      ),
      sleep(3000).then(() => 'hung'),
    ]);
    expect(outcome).not.toBe('hung');
    // An element pushed right after the cancel is still there.
    await raw.rpush('q', 'important');
    await sleep(300);
    expect(await raw.lrange('q', 0, -1)).toEqual(['important']);
    await raw.del('q');
  });

  it('P2-12: idle per-db clients are closed, the default one is kept', async () => {
    await r.scan({ cursor: '0', count: 10, db: 3 });
    await r.scan({ cursor: '0', count: 10, db: 4 });
    expect(r.openDatabases()).toEqual([0, 3, 4]);
    expect(r.sweepIdleClients(Date.now() + 10 * 60_000)).toBe(2);
    expect(r.openDatabases()).toEqual([0]);
    // And they come back on demand.
    await r.scan({ cursor: '0', count: 10, db: 3 });
    expect(r.openDatabases()).toEqual([0, 3]);
  });
});
