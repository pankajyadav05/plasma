import { isConnectionLostError } from '@shared/connection-loss';
import type { ConnectionConfig } from '@shared/protocol';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { RedisDriver } from '../redis';
import { allCapabilities } from './capabilities';
import { listOptOuts, scenarioFor } from './scenario';
import { FlakyProxy } from './tcp-proxy';

/**
 * The subset of the conformance scenarios that applies to Redis: connect,
 * introspect (SCAN), command, cancel, read-only, errors and caps. What does
 * not apply is declared below with the reason and shows up as a skipped test.
 *
 * `PLASMA_LIVE_REDIS=redis://host:port` (a throwaway server is best; this
 * suite only touches keys under its own prefix and never flushes).
 */
export const REDIS_URL = process.env.PLASMA_LIVE_REDIS;

export const redisCaps = allCapabilities({
  badCredentials: { no: 'the conformance server runs without a password' },
  primaryKeys: { no: 'Redis has keys, not tables: there is no schema to introspect' },
  foreignKeys: { no: 'Redis has no relations' },
  constraints: { no: 'Redis has no constraints' },
  transactions: {
    no: 'MULTI / EXEC are refused on the shared connection; atomic work goes through EVAL',
  },
  multiStatement: { no: 'a command is one request; there are no scripts of statements' },
  statementTimeout: {
    no: 'Redis has no statement timeout; blocking commands carry their own deadline',
  },
  aiQuery: { no: 'the agent reads Redis through the same classified read-only commands' },
  rowEdit: { no: 'values are edited through typed write operations, not SQL row edits' },
  keylessEdit: { no: 'there are no tables, so no key-less rows' },
  exportStream: { no: 'Redis values are read page by page, not streamed as a result set' },
  exactDecimal: { no: 'Redis stores strings; numbers are not typed on the server' },
  timestamptz: { no: 'Redis has no date types' },
  json: { no: 'JSON is a module type (RedisJSON), not part of the base server' },
  arrays: { no: 'lists are value types read page by page, not array columns' },
});

export function registerRedisConformance(opts: { enabled: boolean }): void {
  const suite = opts.enabled ? describe : describe.skip;
  suite('conformance: redis', () => {
    const scenario = scenarioFor(redisCaps);
    const prefix = `plasma:conf:${process.pid}:`;
    const k = (name: string) => `${prefix}${name}`;
    const url = new URL(REDIS_URL ?? 'redis://127.0.0.1:6379');
    const host = url.hostname;
    const port = Number(url.port || 6379);
    const config = (
      o: { readOnly?: boolean; port?: number; host?: string } = {},
    ): ConnectionConfig =>
      ({
        id: 'conf-redis',
        name: 'conf',
        engine: 'redis',
        host: o.host ?? host,
        port: o.port ?? port,
        database: '0',
        user: '',
        password: '',
        ssl: false,
        readOnly: o.readOnly === true,
      }) as ConnectionConfig;

    let raw: Redis;
    let r: RedisDriver;
    let proxy: FlakyProxy;
    const drivers: RedisDriver[] = [];
    const open = async (o: Parameters<typeof config>[0] = {}) => {
      const d = new RedisDriver();
      drivers.push(d);
      await d.connect(config(o));
      return d;
    };
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const rejection = async (p: Promise<unknown>): Promise<Error> => {
      try {
        await p;
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        return err as Error;
      }
      throw new Error('expected the call to be rejected, but it resolved');
    };
    const wipe = async () => {
      let cursor = '0';
      do {
        const [next, keys] = await raw.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
        cursor = next;
        if (keys.length > 0) await raw.del(...keys);
      } while (cursor !== '0');
    };

    beforeAll(async () => {
      raw = new Redis({ host, port });
      proxy = new FlakyProxy(host, port);
      await proxy.start();
      await wipe();
      r = await open();
    }, 30_000);

    afterAll(async () => {
      await Promise.allSettled(drivers.map((d) => d.disconnect()));
      await wipe().catch(() => undefined);
      raw?.disconnect();
      await proxy?.stop();
    }, 30_000);

    describe('connect', () => {
      scenario('connect resolves with the server version and PING answers', null, async () => {
        const d = new RedisDriver();
        drivers.push(d);
        expect(await d.connect(config())).toMatch(/^\d+\.\d+/);
        expect((await d.command(['PING'])).reply).toBe('PONG');
        await d.disconnect();
      });

      scenario(
        'disconnect is idempotent and a disconnected driver refuses commands',
        null,
        async () => {
          const d = await open();
          await d.disconnect();
          await d.disconnect();
          await rejection(d.command(['PING']));
        },
      );

      scenario('the same driver connects again after disconnect', 'reconnect', async () => {
        const d = await open();
        await d.disconnect();
        expect(await d.connect(config())).toMatch(/^\d+\.\d+/);
        expect((await d.command(['PING'])).reply).toBe('PONG');
      });

      scenario('connect() on a live driver replaces its session', 'reconnect', async () => {
        const d = await open();
        await d.connect(config());
        expect((await d.command(['PING'])).reply).toBe('PONG');
      });
    });

    describe('keyspace', () => {
      scenario('SCAN lists the keys of a prefix with their type and TTL', null, async () => {
        await raw.set(k('s'), 'v');
        await raw.set(k('ttl'), 'v', 'EX', 1000);
        await raw.hset(k('h'), 'f', 'v');
        await raw.rpush(k('l'), 'a', 'b');
        await raw.sadd(k('set'), 'm');
        await raw.zadd(k('z'), 1, 'm');
        await raw.xadd(k('x'), '*', 'n', '1');
        const res = await r.scan({ cursor: '0', match: `${prefix}*`, count: 100, minResults: 7 });
        const by = Object.fromEntries(res.keys.map((m) => [m.key, m]));
        expect(by[k('s')]?.type).toBe('string');
        expect(by[k('h')]?.type).toBe('hash');
        expect(by[k('l')]?.type).toBe('list');
        expect(by[k('set')]?.type).toBe('set');
        expect(by[k('z')]?.type).toBe('zset');
        expect(by[k('x')]?.type).toBe('stream');
        expect(by[k('s')]?.ttlMs).toBeNull();
        expect(by[k('ttl')]?.ttlMs).toBeGreaterThan(0);
      });

      scenario('the overview reports the version and the keyspace', null, async () => {
        const o = await r.refreshOverview();
        expect(o.redisVersion).toMatch(/^\d+\.\d+/);
        expect(o.keyspace.some((d) => d.db === 0 && d.keys > 0)).toBe(true);
      });

      scenario('databases are kept apart', null, async () => {
        await raw.select(3);
        await raw.set(k('only-in-3'), 'x');
        await raw.select(0);
        try {
          const res = await r.scan({ cursor: '0', match: k('only-in-3'), count: 100, db: 3 });
          expect(res.keys.map((m) => m.key)).toEqual([k('only-in-3')]);
          const none = await r.scan({ cursor: '0', match: k('only-in-3'), count: 100, db: 0 });
          expect(none.keys).toEqual([]);
        } finally {
          await raw.select(3);
          await raw.del(k('only-in-3'));
          await raw.select(0);
        }
      });
    });

    describe('values', () => {
      scenario(
        'unicode, emoji and the empty string round-trip, a missing key is "none"',
        null,
        async () => {
          const text = `héllo 日本語 🎉 "quotes" 'single' back\\slash`;
          await r.write({ kind: 'setString', key: k('uni'), value: text });
          await r.write({ kind: 'setString', key: k('empty'), value: '' });
          const uni = await r.getKey(k('uni'));
          const empty = await r.getKey(k('empty'));
          const missing = await r.getKey(k('nope'));
          expect(uni.value).toBe(text);
          expect(empty.type).toBe('string');
          expect(empty.value).toBe('');
          expect(missing.type).toBe('none');
          expect(missing.value).toBeNull();
        },
      );

      scenario('integers beyond 2^53 keep every digit', 'bigint', async () => {
        await r.write({ kind: 'setString', key: k('big'), value: '9007199254740993' });
        expect((await r.getKey(k('big'))).value).toBe('9007199254740993');
        expect((await r.command(['GET', k('big')])).reply).toBe('9007199254740993');
        await r.command(['INCR', k('big')]);
        expect((await r.command(['GET', k('big')])).reply).toBe('9007199254740994');
      });

      scenario(
        'bytes that are not UTF-8 come back as base64 with their length',
        'binary',
        async () => {
          await raw.set(k('bin'), Buffer.from([0xff, 0x00, 0x41, 0xfe]));
          const v = await r.getKey(k('bin'));
          expect(v.value).toEqual({
            $binary: Buffer.from([0xff, 0x00, 0x41, 0xfe]).toString('base64'),
            $bytes: 4,
          });
        },
      );
    });

    describe('commands and errors', () => {
      scenario('a command returns its reply and its name', null, async () => {
        await r.command(['SET', k('c'), 'v']);
        const got = await r.command(['GET', k('c')]);
        expect(got.reply).toBe('v');
        expect(got.command).toBe('GET');
        expect((await r.command(['GET', k('absent')])).reply).toBeNull();
      });

      scenario(
        'errors name the server reason and keep the connection usable',
        'errorKeepsSession',
        async () => {
          await raw.rpush(k('alist'), 'a');
          const wrongArgs = await rejection(r.command(['GET']));
          expect(wrongArgs.message).toMatch(/wrong number of arguments/i);
          const wrongType = await rejection(r.command(['GET', k('alist')]));
          expect(wrongType.message).toMatch(/WRONGTYPE/);
          const unknown = await rejection(r.command(['FOOBAR']));
          expect(unknown.message).toMatch(/unknown command/i);
          for (const err of [wrongArgs, wrongType, unknown]) {
            expect(isConnectionLostError(err)).toBe(false);
          }
          expect((await r.command(['PING'])).reply).toBe('PONG');
        },
      );

      scenario(
        'commands that would take over the shared connection are refused',
        null,
        async () => {
          for (const cmd of [
            ['MULTI'],
            ['SUBSCRIBE', 'x'],
            ['MONITOR'],
            ['AUTH', 'x'],
            ['HELLO', '3'],
          ]) {
            await rejection(r.command(cmd));
          }
          expect((await r.command(['PING'])).reply).toBe('PONG');
        },
      );
    });

    describe('cancellation', () => {
      scenario(
        'a blocking command is stopped within 2 s and the connection survives',
        'cancel',
        async () => {
          const d = await open();
          const waiting = d.command(['BLPOP', k('never'), '30']).then(
            (res) => ({ ok: true as const, reply: res.reply }),
            (err: Error) => ({ ok: false as const, message: err.message }),
          );
          await sleep(400);
          const asked = Date.now();
          d.cancel();
          const outcome = await waiting;
          expect(Date.now() - asked).toBeLessThan(2000);
          // Redis cancels by unblocking the wait: an empty reply, or a "cancelled" error.
          if (outcome.ok) expect(outcome.reply).toBeNull();
          else expect(outcome.message).toMatch(/cancel/i);
          expect((await d.command(['PING'])).reply).toBe('PONG');
        },
      );
    });

    describe('read-only', () => {
      const writes: string[][] = [
        ['SET', 'ro:k', 'x'],
        ['DEL', 'ro:k'],
        ['UNLINK', 'ro:k'],
        ['EXPIRE', 'ro:k', '100'],
        ['PERSIST', 'ro:k'],
        ['RENAME', 'ro:k', 'ro:k2'],
        ['APPEND', 'ro:k', 'x'],
        ['INCR', 'ro:n'],
        ['LPUSH', 'ro:l', 'x'],
        ['SADD', 'ro:s', 'x'],
        ['ZADD', 'ro:z', '1', 'x'],
        ['HSET', 'ro:h', 'f', 'v'],
        ['XADD', 'ro:x', '*', 'f', 'v'],
        ['FLUSHDB'],
        ['FLUSHALL'],
        ['CONFIG', 'SET', 'maxmemory', '0'],
        ['SCRIPT', 'FLUSH'],
        ['DEBUG', 'SLEEP', '0'],
        ['PUBLISH', 'ro:ch', 'x'],
      ];
      // Writes that do not look like one: scripts, store variants, TTL side effects, casing.
      const hidden: string[][] = [
        ['EVAL', "return redis.call('set', KEYS[1], 'x')", '1', 'ro:k'],
        ['eval', "return redis.call('set', KEYS[1], 'x')", '1', 'ro:k'],
        ['EVALSHA', 'a'.repeat(40), '0'],
        ['FCALL', 'fn', '0'],
        ['sEt', 'ro:k', 'x'],
        ['GETEX', 'ro:src', 'EX', '100'],
        ['GETDEL', 'ro:src'],
        ['SORT', 'ro:list', 'STORE', 'ro:dst'],
        ['COPY', 'ro:src', 'ro:dst'],
        ['MOVE', 'ro:src', '1'],
        ['SINTERSTORE', 'ro:dst', 'ro:set'],
        ['ZRANGESTORE', 'ro:dst', 'ro:zset', '0', '-1'],
        ['BITFIELD', 'ro:src', 'SET', 'u8', '0', '1'],
        ['SETRANGE', 'ro:src', '0', 'x'],
        ['LMPOP', '1', 'ro:list', 'LEFT'],
        ['SWAPDB', '0', '1'],
      ];

      scenario(
        'a read-only connection refuses every write command and changes nothing',
        'readOnlyConnection',
        async () => {
          await raw.set('ro:src', 'seed');
          await raw.set('ro:k', 'seed');
          const ttlBefore = await raw.pttl('ro:src');
          const sizeBefore = await raw.dbsize();
          const ro = await open({ readOnly: true });
          for (const cmd of [...writes, ...hidden]) {
            const err = await rejection(ro.command(cmd));
            expect(err.message, cmd.join(' ')).toMatch(/read-only/i);
          }
          expect(await raw.get('ro:k')).toBe('seed');
          expect(await raw.get('ro:src')).toBe('seed');
          expect(await raw.pttl('ro:src')).toBe(ttlBefore);
          expect(await raw.dbsize()).toBe(sizeBefore);
          // Reading is still possible.
          expect((await ro.command(['GET', 'ro:src'])).reply).toBe('seed');
          expect((await ro.command(['INFO', 'server'])).reply).toEqual(expect.any(String));
          await raw.del('ro:src', 'ro:k');
        },
      );

      scenario('the typed write operations are refused too', 'readOnlyConnection', async () => {
        await raw.set(k('typed'), 'seed');
        const ro = await open({ readOnly: true });
        await rejection(ro.write({ kind: 'setString', key: k('typed'), value: 'x' }));
        await rejection(ro.deleteKey(k('typed')));
        await rejection(ro.setTtl(k('typed'), 100));
        await rejection(ro.bulkDelete([k('typed')]));
        await rejection(ro.deleteByPattern({ match: `${prefix}typed`, limit: 10, dryRun: false }));
        expect(await raw.get(k('typed'))).toBe('seed');
        // The dry run only counts, so it is a read.
        const dry = await ro.deleteByPattern({ match: `${prefix}typed`, limit: 10, dryRun: true });
        expect(dry.deleted).toBe(0);
      });

      scenario('SELECT does not lift read-only mode', 'readOnlyBypass', async () => {
        const ro = await open({ readOnly: true });
        await ro.command(['SELECT', '2']);
        await rejection(ro.command(['SET', k('after-select'), 'x']));
        await rejection(ro.command(['SET', k('after-select'), 'x'], 2));
        expect(await raw.exists(k('after-select'))).toBe(0);
      });
    });

    describe('result caps', () => {
      scenario('a long list is paged, with a cursor for the rest', 'resultCap', async () => {
        const pipe = raw.pipeline();
        for (let i = 0; i < 1200; i++) pipe.rpush(k('biglist'), `el-${i}`);
        await pipe.exec();
        const p1 = await r.getKey(k('biglist'), { count: 500 });
        expect((p1.value as { items: string[] }).items).toHaveLength(500);
        expect(p1.nextCursor).toBe('500');
        const p3 = await r.getKey(k('biglist'), { count: 500, cursor: '1000' });
        expect((p3.value as { items: string[] }).items).toHaveLength(200);
        expect(p3.nextCursor).toBeNull();
      });

      scenario(
        'a string over the fetch budget is not pulled, only sized and previewed',
        'byteCap',
        async () => {
          await raw.set(k('huge'), Buffer.alloc(1_500_000, 0x61));
          const v = await r.getKey(k('huge'));
          const stub = v.value as { truncated?: boolean; sizeBytes?: number };
          expect(stub.truncated).toBe(true);
          expect(stub.sizeBytes).toBe(1_500_000);
        },
      );
    });

    describe('connection loss', () => {
      scenario(
        'losing the server is reported as a lost connection, and reconnect works',
        'connectionLoss',
        async () => {
          const d = await open({ host: '127.0.0.1', port: proxy.port });
          expect((await d.command(['PING'])).reply).toBe('PONG');
          await proxy.kill();
          await sleep(300);
          const err = await rejection(d.command(['PING']));
          expect(isConnectionLostError(err), err.message).toBe(true);
          await proxy.restart();
          await d.connect(config({ host: '127.0.0.1', port: proxy.port }));
          expect((await d.command(['PING'])).reply).toBe('PONG');
        },
        60_000,
      );

      scenario(
        'losing the server under a blocking command rejects it',
        'connectionLoss',
        async () => {
          const d = await open({ host: '127.0.0.1', port: proxy.port });
          const waiting = d.command(['BLPOP', k('never2'), '30']).then(
            () => null,
            (e: Error) => e,
          );
          await sleep(400);
          const killedAt = Date.now();
          await proxy.kill();
          const err = await waiting;
          expect(Date.now() - killedAt).toBeLessThan(15_000);
          expect(err).toBeInstanceOf(Error);
          expect(isConnectionLostError(err), err?.message).toBe(true);
          await proxy.restart();
          await d.connect(config({ host: '127.0.0.1', port: proxy.port }));
          expect((await d.command(['PING'])).reply).toBe('PONG');
        },
        60_000,
      );
    });

    describe('opt-outs', () => {
      listOptOuts(redisCaps);
    });
  });
}
