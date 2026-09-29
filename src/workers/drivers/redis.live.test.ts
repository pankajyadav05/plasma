/**
 * Live Redis driver checks — opt-in: PLASMA_LIVE_REDIS=redis://127.0.0.1:6399
 * (a throwaway server: the suite FLUSHALLs db 0–2).
 */
import type { ConnectionConfig } from '@shared/protocol';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisDriver } from './redis';

const LIVE = process.env.PLASMA_LIVE_REDIS;

function config(readOnly = false, database = '0'): ConnectionConfig {
  const url = new URL(LIVE ?? 'redis://127.0.0.1:6379');
  return {
    id: 'live-redis',
    name: 'live',
    engine: 'redis',
    host: url.hostname,
    port: Number(url.port || 6379),
    database,
    user: '',
    password: '',
    ssl: false,
    readOnly,
  } as ConnectionConfig;
}

describe.skipIf(!LIVE)('RedisDriver (live)', () => {
  const r = new RedisDriver();
  let raw: InstanceType<typeof Redis>;

  beforeAll(async () => {
    const url = new URL(LIVE!);
    raw = new Redis({ host: url.hostname, port: Number(url.port || 6379) });
    await raw.flushall();
    const p = raw.pipeline();
    for (let i = 1; i <= 3000; i++) p.set(`noise:${i}`, String(i));
    p.hset('supplier:1', 'name', 'Acme', 'country', 'JP');
    p.set('bin', Buffer.from([0xff, 0x00, 0x41, 0xfe]));
    for (let i = 0; i < 1200; i++) p.rpush('biglist', `el-${i}`);
    for (let i = 0; i < 10; i++) p.xadd('st', '*', 'n', String(i));
    p.set('ttlkey', 'v', 'EX', 1000);
    await p.exec();
    await raw.select(2);
    await raw.set('only-in-db2', 'x');
    await raw.select(0);
    await r.connect(config());
  });

  afterAll(async () => {
    await r.disconnect();
    raw.disconnect();
  });

  it('MATCH scan keeps scanning until it finds the key (R8/F10)', async () => {
    const res = await r.scan({ cursor: '0', match: 'supplier:*', count: 100, minResults: 1 });
    expect(res.keys.map((k) => k.key)).toContain('supplier:1');
    expect(res.iterations).toBeGreaterThanOrEqual(1);
  });

  it('keeps databases apart (R5/R20)', async () => {
    const db2 = await r.scan({ cursor: '0', count: 100, db: 2, minResults: 10 });
    expect(db2.keys.map((k) => k.key)).toEqual(['only-in-db2']);
    const cli = await r.command(['SELECT', '2']);
    expect(cli.reply).toBe('OK');
    const v = await r.command(['GET', 'only-in-db2'], 2);
    expect(v.reply).toBe('x');
    // The default db is untouched by the CLI SELECT.
    const again = await r.getKey('supplier:1');
    expect(again.type).toBe('hash');
  });

  it('reads binary strings without corrupting them (R12)', async () => {
    const k = await r.getKey('bin');
    expect(k.value).toEqual({
      $binary: Buffer.from([0xff, 0x00, 0x41, 0xfe]).toString('base64'),
      $bytes: 4,
    });
  });

  it('pages lists (R24)', async () => {
    const p1 = await r.getKey('biglist', { count: 500 });
    expect((p1.value as { items: string[] }).items).toHaveLength(500);
    expect(p1.nextCursor).toBe('500');
    const p3 = await r.getKey('biglist', { count: 500, cursor: '1000' });
    expect((p3.value as { items: string[] }).items[0]).toBe('el-1000');
    expect(p3.nextCursor).toBeNull();
  });

  it('pages streams by id', async () => {
    const p1 = await r.getKey('st', { count: 4 });
    const items = (p1.value as { items: { id: string }[] }).items;
    expect(items).toHaveLength(4);
    const p2 = await r.getKey('st', { count: 10, cursor: p1.nextCursor! });
    expect((p2.value as { items: unknown[] }).items).toHaveLength(6);
  });

  it('keeps the TTL when editing a string (R9)', async () => {
    await r.write({ kind: 'setString', key: 'ttlkey', value: 'w', keepTtl: true });
    expect(await raw.ttl('ttlkey')).toBeGreaterThan(900);
    expect(await raw.get('ttlkey')).toBe('w');
  });

  it('creates, renames, copies (R21)', async () => {
    await r.write({
      kind: 'createKey',
      key: 'new:h',
      keyType: 'hash',
      field: 'f',
      value: 'v',
      ttlSeconds: 100,
    });
    await expect(
      r.write({ kind: 'createKey', key: 'new:h', keyType: 'string', value: 'x' }),
    ).rejects.toThrow(/already exists/);
    await r.write({ kind: 'copy', key: 'new:h', newKey: 'new:h2' });
    expect(await raw.hget('new:h2', 'f')).toBe('v');
    await r.write({ kind: 'rename', key: 'new:h2', newKey: 'new:h3' });
    await expect(r.write({ kind: 'rename', key: 'new:h3', newKey: 'new:h' })).rejects.toThrow(
      /already exists/,
    );
    await r.write({ kind: 'hashRename', key: 'new:h3', field: 'f', newField: 'g' });
    expect(await raw.hgetall('new:h3')).toEqual({ g: 'v' });
  });

  it('bulk delete returns the per-key result (R1)', async () => {
    const res = await r.bulkDelete(['noise:1', 'noise:2']);
    expect(res.deleted).toEqual(['noise:1', 'noise:2']);
  });

  it('deletes by pattern with a dry run first (R26)', async () => {
    const dry = await r.deleteByPattern({ match: 'noise:1*', dryRun: true, limit: 100000 });
    expect(dry.matched).toBeGreaterThan(100);
    expect(await raw.exists('noise:10')).toBe(1);
    const real = await r.deleteByPattern({ match: 'noise:1*', dryRun: false, limit: 100000 });
    expect(real.deleted).toBe(dry.matched);
    expect(await raw.exists('noise:10')).toBe(0);
  });

  it('refuses subscriber / transaction commands on the shared client (R3)', async () => {
    await expect(r.command(['SUBSCRIBE', 'x'])).rejects.toThrow(/Pub\/sub/);
    await expect(r.command(['MULTI'])).rejects.toThrow();
    expect((await r.command(['PING'])).reply).toBe('PONG');
  });

  it('runs blocking commands off the shared connection (R3)', async () => {
    const started = Date.now();
    const pending = r.command(['BLPOP', 'nothing-here', '1']);
    // The shared client still answers while BLPOP blocks.
    expect((await r.command(['PING'])).reply).toBe('PONG');
    expect(Date.now() - started).toBeLessThan(900);
    expect((await pending).reply).toBeNull();
  });

  it('analyzer keeps unavailable sizes as null and aggregates', async () => {
    const res = await r.analyze({ sampleCap: 200 });
    expect(res.scanned).toBeGreaterThan(0);
    expect(res.samples[0]!.bytes).toBeGreaterThan(0);
  });

  it('enforces read-only connections in the worker (S1/R2)', async () => {
    const ro = new RedisDriver();
    await ro.connect(config(true));
    await expect(ro.write({ kind: 'setString', key: 'x', value: 'y' })).rejects.toThrow(
      /read-only/,
    );
    await expect(ro.deleteKey('supplier:1')).rejects.toThrow(/read-only/);
    await expect(ro.command(['SET', 'x', 'y'])).rejects.toThrow(/read-only/);
    expect((await ro.command(['HGET', 'supplier:1', 'name'])).reply).toBe('Acme');
    await ro.disconnect();
  });

  it('reference-counts pub/sub subscriptions (R13)', async () => {
    const got: string[] = [];
    r.setPubsubListener((m) => got.push(m.message));
    await r.subscribe('ch', false);
    await r.subscribe('ch', false);
    await r.unsubscribe('ch', false);
    await raw.publish('ch', 'hello');
    await new Promise((res) => setTimeout(res, 100));
    expect(got).toEqual(['hello']);
    await r.unsubscribe('ch', false);
  });

  it('reports the configured database count (R15)', async () => {
    const o = await r.refreshOverview();
    expect(o.dbCount).toBe(16);
  });
});

/**
 * Topologies (R19) — opt-in:
 *   PLASMA_LIVE_REDIS_SENTINEL=sentinel://127.0.0.1:26379/mymaster
 *   PLASMA_LIVE_REDIS_SOCKET=/tmp/redis.sock
 *   PLASMA_LIVE_REDIS_CLUSTER=127.0.0.1:7000   (any node; auto-detected)
 */
function topo(host: string, port = 6379): ConnectionConfig {
  return { ...config(), host, port } as ConnectionConfig;
}

describe.skipIf(!process.env.PLASMA_LIVE_REDIS_SENTINEL)('RedisDriver sentinel (live)', () => {
  it('connects through Sentinel', async () => {
    const r = new RedisDriver();
    await r.connect(topo(process.env.PLASMA_LIVE_REDIS_SENTINEL!));
    expect((await r.command(['PING'])).reply).toBe('PONG');
    expect((await r.refreshOverview()).mode).toBe('sentinel');
    await r.disconnect();
  });
});

describe.skipIf(!process.env.PLASMA_LIVE_REDIS_SOCKET)('RedisDriver unix socket (live)', () => {
  it('connects over a unix socket', async () => {
    const r = new RedisDriver();
    await r.connect(topo(process.env.PLASMA_LIVE_REDIS_SOCKET!));
    expect((await r.command(['PING'])).reply).toBe('PONG');
    await r.disconnect();
  });
});

describe.skipIf(!process.env.PLASMA_LIVE_REDIS_CLUSTER)('RedisDriver cluster (live)', () => {
  it('detects a cluster node, scans every master and routes keys', async () => {
    const [host, port] = process.env.PLASMA_LIVE_REDIS_CLUSTER!.split(':');
    const r = new RedisDriver();
    await r.connect(topo(host!, Number(port)));
    expect(r.isCluster).toBe(true);
    const keys = Array.from({ length: 50 }, (_, i) => `ck:${i}`);
    for (const k of keys) await r.write({ kind: 'setString', key: k, value: k });
    const seen = new Set<string>();
    let cursor = '0';
    do {
      const page = await r.scan({ cursor, match: 'ck:*', count: 100, minResults: 10 });
      for (const k of page.keys) seen.add(k.key);
      cursor = page.cursor;
    } while (cursor !== '0');
    expect(seen.size).toBe(50);
    expect((await r.getKey('ck:7')).value).toBe('ck:7');
    const o = await r.refreshOverview();
    expect(o.mode).toBe('cluster');
    expect(o.keyspace[0]!.keys).toBeGreaterThanOrEqual(50);
    const del = await r.bulkDelete(keys);
    expect(del.deleted).toHaveLength(50);
    await r.disconnect();
  });
});
