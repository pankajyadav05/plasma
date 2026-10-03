/**
 * Redis keyspace notifications tail — opt-in live checks:
 *
 *   PLASMA_LIVE_REDIS=redis://127.0.0.1:6403 pnpm vitest run \
 *     src/workers/drivers/redis.keyspace.live.test.ts
 *
 * Needs a throwaway server (the suite changes `notify-keyspace-events`, FLUSHALLs).
 */
import type { ConnectionConfig, RedisPubsubMessage } from '@shared/protocol';
import {
  flagsWithKeyevents,
  keyeventPattern,
  keyeventsEnabled,
  parseNotifyConfigReply,
} from '@shared/redis-keyspace';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisDriver } from './redis';

const LIVE = process.env.PLASMA_LIVE_REDIS;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(25);
}

function config(readOnly = false): ConnectionConfig {
  const url = new URL(LIVE ?? 'redis://127.0.0.1:6379');
  return {
    id: 'live-redis-keyspace',
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

describe.skipIf(!LIVE)('Redis keyspace tail (live)', () => {
  let raw: InstanceType<typeof Redis>;
  const r = new RedisDriver();
  const seen: RedisPubsubMessage[] = [];

  beforeAll(async () => {
    const url = new URL(LIVE as string);
    raw = new Redis({ host: url.hostname, port: Number(url.port || 6379) });
    await raw.flushall();
    await raw.config('SET', 'notify-keyspace-events', '');
    await r.connect(config());
    r.setPubsubListener((m) => seen.push(m));
  });

  afterAll(async () => {
    r.setPubsubListener(null);
    await r.disconnect();
    await raw.config('SET', 'notify-keyspace-events', '');
    raw.disconnect();
  });

  const flags = async () =>
    parseNotifyConfigReply((await r.command(['CONFIG', 'GET', 'notify-keyspace-events'])).reply);

  it('detects that notifications are off, and a tail then sees nothing', async () => {
    expect(keyeventsEnabled(await flags())).toBe(false);
    await r.subscribe(keyeventPattern(0), true);
    await raw.set('quiet', '1');
    await sleep(200);
    expect(seen).toHaveLength(0);
  });

  it('enables them with CONFIG SET and then tails key events', async () => {
    const next = flagsWithKeyevents(await flags());
    await r.command(['CONFIG', 'SET', 'notify-keyspace-events', next]);
    expect(keyeventsEnabled(await flags())).toBe(true);
    await raw.set('user:1', 'a');
    await raw.del('user:1');
    await raw.set('tmp', 'x', 'PX', 50);
    await until(() => seen.some((m) => m.channel.endsWith(':expired')), 4000);
    const pairs = seen.map((m) => [m.channel, m.message]);
    expect(pairs).toContainEqual(['__keyevent@0__:set', 'user:1']);
    expect(pairs).toContainEqual(['__keyevent@0__:del', 'user:1']);
    expect(pairs).toContainEqual(['__keyevent@0__:expired', 'tmp']);
    expect(seen.every((m) => m.pattern)).toBe(true);
  });

  it('only tails the chosen database', async () => {
    seen.length = 0;
    await raw.select(1);
    await raw.set('other-db', '1');
    await raw.select(0);
    await sleep(200);
    expect(seen.filter((m) => m.message === 'other-db')).toHaveLength(0);
  });

  it('floods are capped with a drop notice, like pub/sub', async () => {
    seen.length = 0;
    const pipe = raw.pipeline();
    for (let i = 0; i < 2000; i++) pipe.set(`k:${i}`, '1');
    await pipe.exec();
    await until(() => seen.some((m) => m.channel === '(plasma)'), 4000);
    expect(seen.some((m) => m.channel === '(plasma)')).toBe(true);
  });

  it('refuses CONFIG SET on a read-only connection and unsubscribes cleanly', async () => {
    await r.unsubscribe(keyeventPattern(0), true);
    const ro = new RedisDriver();
    await ro.connect(config(true));
    await expect(ro.command(['CONFIG', 'SET', 'notify-keyspace-events', 'KEA'])).rejects.toThrow(
      /read-only|write/i,
    );
    await ro.disconnect();
    seen.length = 0;
    await raw.set('after', '1');
    await sleep(200);
    expect(seen).toHaveLength(0);
  });
});
