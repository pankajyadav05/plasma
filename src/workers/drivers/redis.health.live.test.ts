/**
 * Redis health advisor against a real server — opt-in:
 * PLASMA_LIVE_REDIS=redis://127.0.0.1:6401 (throwaway: the suite FLUSHALLs db 0).
 */
import {
  buildPrefixTree,
  clientKillCommand,
  interpretBigKeys,
  interpretClients,
  interpretHotKeys,
  interpretLatency,
  interpretMemory,
  interpretSlowlog,
  isLfuError,
  parseClientList,
  parseInfo,
  parseLatencyLatest,
  topPrefixes,
} from '@shared/health/redis-health';
import type { ConnectionConfig } from '@shared/protocol';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisDriver } from './redis';

const LIVE = process.env.PLASMA_LIVE_REDIS;

function config(readOnly = false): ConnectionConfig {
  const url = new URL(LIVE ?? 'redis://127.0.0.1:6379');
  return {
    id: 'live-redis-health',
    name: 'live',
    engine: 'redis',
    host: url.hostname,
    port: Number(url.port || 6379),
    database: '0',
    user: '',
    password: '',
    ssl: false,
    readOnly,
  } as ConnectionConfig;
}

describe.skipIf(!LIVE)('Redis health advisor (live)', { timeout: 30_000 }, () => {
  const r = new RedisDriver();
  const ro = new RedisDriver();
  let raw: InstanceType<typeof Redis>;

  beforeAll(async () => {
    const url = new URL(LIVE as string);
    raw = new Redis({ host: url.hostname, port: Number(url.port || 6379) });
    await raw.flushall();
    const p = raw.pipeline();
    for (let i = 0; i < 200; i++) p.set(`cache:page:${i}`, 'x'.repeat(100));
    for (let i = 0; i < 20; i++) p.set(`session:${i}`, 'y'.repeat(50));
    p.set('cache:blob', 'z'.repeat(3 * 1024 * 1024));
    p.set('plain', '1');
    await p.exec();
    await raw.config('SET', 'maxmemory-policy', 'noeviction');
    await raw.config('SET', 'latency-monitor-threshold', '1');
    await r.connect(config());
    await ro.connect(config(true));
  });

  afterAll(async () => {
    await raw.config('SET', 'maxmemory-policy', 'noeviction').catch(() => {});
    await r.disconnect();
    await ro.disconnect();
    raw.disconnect();
  });

  it('finds the big key and the heaviest prefix from a sample', async () => {
    const res = await r.analyze({ sampleCap: 1000 });
    expect(res.scanned).toBe(222);
    const big = interpretBigKeys(res.samples, res.scanned);
    expect(big.findings[0]?.id).toBe('bigkey:cache:blob');
    expect(big.status).toBe('warn');
    const top = topPrefixes(buildPrefixTree(res.samples));
    expect(top[0]?.name).toBe('cache');
    expect(top[0]?.count).toBe(201);
  });

  it('can be stopped and returns what it scanned', async () => {
    const run = r.analyze({ sampleCap: 50_000 });
    await r.cancel();
    const res = await run;
    expect(res.scanned).toBeLessThanOrEqual(222);
  });

  it('reports that OBJECT FREQ needs an LFU policy, then reads frequencies once enabled', async () => {
    const err = await r.command(['OBJECT', 'FREQ', 'plain']).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isLfuError((err as Error).message)).toBe(true);
    expect(interpretHotKeys([], false).status).toBe('unknown');

    await raw.config('SET', 'maxmemory-policy', 'allkeys-lfu');
    for (let i = 0; i < 50; i++) await raw.get('session:1');
    const freq = await r.command(['OBJECT', 'FREQ', 'session:1']);
    expect(Number(freq.reply)).toBeGreaterThan(0);
    const hot = interpretHotKeys([{ key: 'session:1', freq: Number(freq.reply) }], true);
    expect(hot.table?.rows[0]?.key).toBe('session:1');
  });

  it('reads memory, latency, slow log and clients', async () => {
    const info = parseInfo((await r.command(['INFO', 'memory'])).reply);
    expect(Number(info.used_memory)).toBeGreaterThan(0);
    expect(interpretMemory(info).summary).toContain('no limit');

    const latest = parseLatencyLatest((await r.command(['LATENCY', 'LATEST'])).reply);
    expect(interpretLatency(latest).status).toMatch(/ok|warn|crit/);
    const doctor = await r.command(['LATENCY', 'DOCTOR']);
    expect(typeof doctor.reply).toBe('string');

    await raw.config('SET', 'slowlog-log-slower-than', '0');
    await raw.keys('cache:*');
    await raw.config('SET', 'slowlog-log-slower-than', '10000');
    const slow = await r.slowlog(50);
    expect(interpretSlowlog(slow).table?.rows.some((row) => row.command === 'KEYS')).toBe(true);

    const clients = parseClientList((await r.command(['CLIENT', 'LIST'])).reply);
    expect(clients.length).toBeGreaterThanOrEqual(2);
    expect(interpretClients(clients).summary).toBe(`${clients.length} client(s)`);
  });

  it('kills a client by id and refuses on a read-only connection', async () => {
    const victim = new Redis({
      host: new URL(LIVE as string).hostname,
      port: Number(new URL(LIVE as string).port),
    });
    await victim.client('SETNAME', 'victim');
    const id = String(await victim.client('ID'));
    const parts = clientKillCommand(id);
    expect(parts).not.toBeNull();
    await expect(ro.command(parts as string[])).rejects.toThrow(/read-only/i);
    const killed = await r.command(parts as string[]);
    expect(Number(killed.reply)).toBe(1);
    const left = parseClientList((await r.command(['CLIENT', 'LIST'])).reply);
    expect(left.some((c) => c.id === id)).toBe(false);
    victim.disconnect();
  });
});
