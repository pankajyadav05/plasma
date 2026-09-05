import type {
  ConnectionConfig,
  RedisAnalyzeResult,
  RedisAnalyzeSample,
  RedisCommandResult,
  RedisKeyMeta,
  RedisKeyValue,
  RedisOverview,
  RedisPubsubMessage,
  RedisScanResult,
  RedisSlowlogEntry,
  RedisValueType,
  RedisWriteOp,
} from '@shared/protocol';
import { buildNodeTlsOptions, insecureTlsWarning, resolveTls } from '@shared/tls';
import Redis, { type RedisOptions } from 'ioredis';

type RedisClient = InstanceType<typeof Redis>;

/** Callback fired by the driver whenever a pub/sub message arrives. */
export type RedisPubsubListener = (msg: RedisPubsubMessage) => void;

/**
 * Redis driver — single ioredis client, lazy-typed reads.
 *
 * `database` on the ConnectionConfig is interpreted as the Redis db
 * index (decimal string). Empty / non-numeric → db 0.
 *
 * Sampling rules: list/set/zset/stream are capped at MAX_ELEMENTS so a
 * 5M-element key doesn't OOM the renderer. The viewer surfaces a
 * "showing N of total" banner.
 */

const MAX_ELEMENTS = 1000;

function parseDbIndex(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export class RedisDriver {
  private client: RedisClient | null = null;
  /**
   * Separate connection used exclusively for SUBSCRIBE / PSUBSCRIBE.
   * Redis blocks the primary connection from running normal commands
   * once it enters subscriber mode, so we keep this one isolated.
   */
  private subscriber: RedisClient | null = null;
  /** Active subscriptions: `${pattern ? 'p' : 's'}:${channel}` → true. */
  private subscriptions = new Set<string>();
  private pubsubListener: RedisPubsubListener | null = null;
  private overview: RedisOverview | null = null;
  /** Captured connect config — needed to spin up the subscriber lazily. */
  private connectConfig: ConnectionConfig | null = null;

  isConnected(): boolean {
    return this.client !== null;
  }

  async connect(config: ConnectionConfig): Promise<string> {
    await this.disconnect();

    const client = new Redis(buildClientOptions(config));

    // ioredis emits 'error' before .connect() rejects; swallow them so
    // we don't crash the worker. The reject from .connect() is enough.
    client.on('error', () => {});

    await client.connect();
    this.client = client;
    this.connectConfig = config;

    this.overview = await this.readOverview(client);
    return this.overview.redisVersion;
  }

  /** Register a sink for pub/sub messages. Replaces any prior listener. */
  setPubsubListener(listener: RedisPubsubListener | null): void {
    this.pubsubListener = listener;
  }

  async disconnect(): Promise<void> {
    const c = this.client;
    const s = this.subscriber;
    this.client = null;
    this.subscriber = null;
    this.subscriptions.clear();
    this.overview = null;
    this.connectConfig = null;
    for (const handle of [c, s]) {
      if (!handle) continue;
      try {
        handle.disconnect();
      } catch {
        // best-effort
      }
    }
  }

  getOverview(): RedisOverview | null {
    return this.overview;
  }

  async refreshOverview(): Promise<RedisOverview> {
    if (!this.client) throw new Error('not connected');
    this.overview = await this.readOverview(this.client);
    return this.overview;
  }

  private async readOverview(client: RedisClient): Promise<RedisOverview> {
    const info = await client.info();
    const parsed = parseInfo(info);
    const keyspace = parseKeyspaceSection(parsed.keyspaceLines);
    return {
      redisVersion: parsed.serverFields.redis_version ?? 'unknown',
      mode: parsed.serverFields.redis_mode ?? 'standalone',
      role: parsed.replicationFields.role ?? 'unknown',
      dbCount: 16, // ioredis default; CLUSTER INFO would be more accurate
      keyspace,
    };
  }

  async scan(opts: {
    cursor: string;
    match?: string;
    count: number;
    db?: number;
  }): Promise<RedisScanResult> {
    if (!this.client) throw new Error('not connected');
    if (typeof opts.db === 'number' && opts.db !== this.client.options.db) {
      await this.client.select(opts.db);
    }
    const args: (string | number)[] = ['SCAN', opts.cursor, 'COUNT', opts.count];
    if (opts.match) {
      args.splice(2, 0, 'MATCH', opts.match);
    }
    const reply = (await this.client.call(...(args as [string, ...string[]]))) as [
      string,
      string[],
    ];
    const [nextCursor, keys] = reply;

    if (keys.length === 0) {
      return { cursor: nextCursor, keys: [], scanned: 0 };
    }

    // Pipeline TYPE + PTTL for the full batch — single round-trip.
    const pipe = this.client.pipeline();
    for (const k of keys) {
      pipe.type(k);
      pipe.pttl(k);
    }
    const results = (await pipe.exec()) ?? [];

    const out: RedisKeyMeta[] = [];
    for (let i = 0; i < keys.length; i++) {
      const typeRes = results[i * 2];
      const ttlRes = results[i * 2 + 1];
      const type = (typeRes?.[1] ?? 'unknown') as string;
      const pttl = Number(ttlRes?.[1] ?? -1);
      out.push({
        key: keys[i],
        type: normalizeType(type),
        ttlMs: pttl >= 0 ? pttl : null,
        sizeBytes: null,
      });
    }
    return { cursor: nextCursor, keys: out, scanned: keys.length };
  }

  async getKey(key: string): Promise<RedisKeyValue> {
    if (!this.client) throw new Error('not connected');
    const c = this.client;
    const [typeRaw, pttl] = await Promise.all([c.type(key), c.pttl(key)]);
    const type = normalizeType(typeRaw);
    const ttlMs = pttl >= 0 ? pttl : null;

    let value: unknown = null;
    let encoding: string | undefined;
    try {
      encoding = (await c.call('OBJECT', 'ENCODING', key)) as string;
    } catch {
      // OBJECT ENCODING may be ACL-blocked on hosted Redis — non-fatal.
    }

    switch (type) {
      case 'string':
        value = await c.get(key);
        break;
      case 'list': {
        const len = await c.llen(key);
        const slice = await c.lrange(key, 0, MAX_ELEMENTS - 1);
        value = { items: slice, total: len };
        break;
      }
      case 'set': {
        const card = await c.scard(key);
        const sample: string[] = [];
        let cur = '0';
        do {
          const [next, members] = await c.sscan(key, cur, 'COUNT', 200);
          sample.push(...members);
          cur = next;
          if (sample.length >= MAX_ELEMENTS) break;
        } while (cur !== '0');
        value = { items: sample.slice(0, MAX_ELEMENTS), total: card };
        break;
      }
      case 'zset': {
        const card = await c.zcard(key);
        const raw = await c.zrange(key, 0, MAX_ELEMENTS - 1, 'WITHSCORES');
        const items: [string, string][] = [];
        for (let i = 0; i < raw.length; i += 2) items.push([raw[i], raw[i + 1]]);
        value = { items, total: card };
        break;
      }
      case 'hash': {
        const obj = await c.hgetall(key);
        const items: [string, string][] = Object.entries(obj);
        value = { items, total: items.length };
        break;
      }
      case 'stream': {
        try {
          const len = (await c.call('XLEN', key)) as number;
          const entries = (await c.call('XRANGE', key, '-', '+', 'COUNT', MAX_ELEMENTS)) as Array<
            [string, string[]]
          >;
          const items = entries.map(([id, flat]) => {
            const fields: [string, string][] = [];
            for (let i = 0; i < flat.length; i += 2) fields.push([flat[i], flat[i + 1]]);
            return { id, fields };
          });
          value = { items, total: len };
        } catch (err) {
          value = { error: err instanceof Error ? err.message : String(err) };
        }
        break;
      }
      case 'json': {
        try {
          const raw = (await c.call('JSON.GET', key)) as string | null;
          value = raw ? JSON.parse(raw) : null;
        } catch (err) {
          value = { error: err instanceof Error ? err.message : String(err) };
        }
        break;
      }
      case 'none':
        value = null;
        break;
      default: {
        // Fall back to a string read if Redis surfaces something we
        // don't model explicitly — better than blanking the panel.
        try {
          value = await c.get(key);
        } catch {
          value = null;
        }
      }
    }

    return { key, type, ttlMs, encoding, value };
  }

  async deleteKey(key: string): Promise<void> {
    if (!this.client) throw new Error('not connected');
    await this.client.del(key);
  }

  async setTtl(key: string, seconds: number): Promise<void> {
    if (!this.client) throw new Error('not connected');
    if (seconds <= 0) {
      await this.client.persist(key);
    } else {
      await this.client.expire(key, seconds);
    }
  }

  async bulkDelete(keys: string[]): Promise<void> {
    if (!this.client) throw new Error('not connected');
    if (keys.length === 0) return;
    // Pipelining DEL one-key-per-command is faster than DEL k1 k2 ... kN
    // on cluster setups where the slot routing differs; ioredis handles
    // both gracefully.
    const pipe = this.client.pipeline();
    for (const k of keys) pipe.del(k);
    await pipe.exec();
  }

  async write(op: RedisWriteOp): Promise<void> {
    if (!this.client) throw new Error('not connected');
    const c = this.client;
    switch (op.kind) {
      case 'setString':
        if (op.ttlSeconds && op.ttlSeconds > 0) {
          await c.set(op.key, op.value, 'EX', op.ttlSeconds);
        } else {
          await c.set(op.key, op.value);
        }
        return;
      case 'hashSet':
        await c.hset(op.key, op.field, op.value);
        return;
      case 'hashDel':
        await c.hdel(op.key, op.field);
        return;
      case 'listPush':
        if (op.side === 'l') await c.lpush(op.key, ...op.values);
        else await c.rpush(op.key, ...op.values);
        return;
      case 'listSet':
        await c.lset(op.key, op.index, op.value);
        return;
      case 'setAdd':
        await c.sadd(op.key, ...op.members);
        return;
      case 'setRem':
        await c.srem(op.key, op.member);
        return;
      case 'zsetAdd':
        await c.zadd(op.key, op.score, op.member);
        return;
      case 'zsetRem':
        await c.zrem(op.key, op.member);
        return;
    }
  }

  /**
   * Walk a SCAN sample and pull MEMORY USAGE for each key. Aggregates
   * by Redis value type and `:`-namespace prefix so the renderer can
   * surface "what's eating my memory" without doing N requests itself.
   *
   * Capped at `sampleCap` keys (default 5000) to keep this cheap on
   * production. Sampling order is whatever Redis SCAN gives us — biased
   * toward the start of the keyspace but still useful for pareto analysis.
   */
  async analyze(opts: { sampleCap: number; match?: string }): Promise<RedisAnalyzeResult> {
    if (!this.client) throw new Error('not connected');
    const c = this.client;
    const samples: RedisAnalyzeSample[] = [];
    let cursor = '0';
    let scanned = 0;
    do {
      const args: (string | number)[] = ['SCAN', cursor, 'COUNT', 500];
      if (opts.match) args.splice(2, 0, 'MATCH', opts.match);
      const reply = (await c.call(...(args as [string, ...string[]]))) as [string, string[]];
      const [next, keys] = reply;
      cursor = next;
      if (keys.length === 0) {
        if (cursor === '0') break;
        continue;
      }
      const pipe = c.pipeline();
      for (const k of keys) {
        pipe.type(k);
        pipe.pttl(k);
        pipe.call('MEMORY', 'USAGE', k);
      }
      const results = (await pipe.exec()) ?? [];
      for (let i = 0; i < keys.length; i++) {
        const typeRaw = (results[i * 3]?.[1] ?? 'unknown') as string;
        const pttl = Number(results[i * 3 + 1]?.[1] ?? -1);
        const bytes = Number(results[i * 3 + 2]?.[1] ?? 0);
        samples.push({
          key: keys[i],
          type: normalizeType(typeRaw),
          bytes: Number.isFinite(bytes) ? bytes : 0,
          ttlMs: pttl >= 0 ? pttl : null,
        });
      }
      scanned += keys.length;
      if (scanned >= opts.sampleCap) break;
    } while (cursor !== '0');

    samples.sort((a, b) => b.bytes - a.bytes);
    const totalBytes = samples.reduce((acc, s) => acc + s.bytes, 0);

    const byTypeMap = new Map<RedisValueType, { count: number; bytes: number }>();
    const byPrefixMap = new Map<string, { count: number; bytes: number }>();
    for (const s of samples) {
      const t = byTypeMap.get(s.type) ?? { count: 0, bytes: 0 };
      t.count += 1;
      t.bytes += s.bytes;
      byTypeMap.set(s.type, t);

      const prefix = s.key.split(':')[0] ?? s.key;
      const p = byPrefixMap.get(prefix) ?? { count: 0, bytes: 0 };
      p.count += 1;
      p.bytes += s.bytes;
      byPrefixMap.set(prefix, p);
    }

    return {
      scanned,
      totalBytes,
      // Cap detail rows to the top 1000 — anything deeper isn't useful in
      // a single screen and serializing 50k keys across IPC is wasteful.
      samples: samples.slice(0, 1000),
      byType: [...byTypeMap.entries()]
        .map(([type, v]) => ({ type, ...v }))
        .sort((a, b) => b.bytes - a.bytes),
      byPrefix: [...byPrefixMap.entries()]
        .map(([prefix, v]) => ({ prefix, ...v }))
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 50),
    };
  }

  async slowlog(limit: number): Promise<RedisSlowlogEntry[]> {
    if (!this.client) throw new Error('not connected');
    const reply = (await this.client.call('SLOWLOG', 'GET', String(limit))) as Array<unknown>;
    if (!Array.isArray(reply)) return [];
    const out: RedisSlowlogEntry[] = [];
    for (const raw of reply) {
      if (!Array.isArray(raw)) continue;
      const id = Number(raw[0] ?? 0);
      const ts = Number(raw[1] ?? 0);
      const durationUs = Number(raw[2] ?? 0);
      const argv = Array.isArray(raw[3]) ? (raw[3] as unknown[]).map((x) => String(x)) : [];
      const client = typeof raw[4] === 'string' ? raw[4] : null;
      const clientName = typeof raw[5] === 'string' ? raw[5] : null;
      out.push({ id, timestamp: ts, durationUs, argv, client, clientName });
    }
    return out;
  }

  async subscribe(channel: string, pattern: boolean): Promise<void> {
    if (!this.connectConfig) throw new Error('not connected');
    const sub = await this.ensureSubscriber();
    const tag = `${pattern ? 'p' : 's'}:${channel}`;
    if (this.subscriptions.has(tag)) return;
    if (pattern) {
      await sub.psubscribe(channel);
    } else {
      await sub.subscribe(channel);
    }
    this.subscriptions.add(tag);
  }

  async unsubscribe(channel: string, pattern: boolean): Promise<void> {
    const sub = this.subscriber;
    if (!sub) return;
    const tag = `${pattern ? 'p' : 's'}:${channel}`;
    if (!this.subscriptions.has(tag)) return;
    if (pattern) {
      await sub.punsubscribe(channel);
    } else {
      await sub.unsubscribe(channel);
    }
    this.subscriptions.delete(tag);
    // If no more subscriptions, drop the subscriber connection so a
    // future re-subscribe gets a fresh one (subscriber-mode redis won't
    // accept normal commands anyway, but holding an idle connection
    // open is wasteful).
    if (this.subscriptions.size === 0) {
      try {
        sub.disconnect();
      } catch {
        // best-effort
      }
      this.subscriber = null;
    }
  }

  private async ensureSubscriber(): Promise<RedisClient> {
    if (this.subscriber) return this.subscriber;
    if (!this.connectConfig) throw new Error('not connected');
    const sub = new Redis({
      ...buildClientOptions(this.connectConfig),
      // Subscriber mode tolerates re-subscribes through reconnects; keep
      // retries on (the primary connection is the strict one).
      maxRetriesPerRequest: null,
    });
    sub.on('error', () => {});
    sub.on('message', (channel: string, message: string) => {
      this.pubsubListener?.({
        channel,
        message,
        pattern: false,
        timestamp: Date.now(),
      });
    });
    sub.on(
      'pmessage',
      (_pattern: string, channel: string, message: string) => {
        this.pubsubListener?.({
          channel,
          message,
          pattern: true,
          timestamp: Date.now(),
        });
      },
    );
    await sub.connect();
    this.subscriber = sub;
    return sub;
  }

  async command(parts: string[]): Promise<RedisCommandResult> {
    if (!this.client) throw new Error('not connected');
    if (parts.length === 0) throw new Error('empty command');
    const start = Date.now();
    const [head, ...tail] = parts;
    const reply = await this.client.call(head, ...tail);
    return {
      command: head.toUpperCase(),
      args: tail,
      reply: serializeReply(reply),
      durationMs: Date.now() - start,
    };
  }
}

function normalizeType(raw: string): RedisValueType {
  const t = raw.toLowerCase();
  if (t === 'string') return 'string';
  if (t === 'list') return 'list';
  if (t === 'set') return 'set';
  if (t === 'zset') return 'zset';
  if (t === 'hash') return 'hash';
  if (t === 'stream') return 'stream';
  if (t === 'rejson-rl' || t === 'redisjson') return 'json';
  if (t === 'none') return 'none';
  return 'unknown';
}

function parseInfo(info: string): {
  serverFields: Record<string, string>;
  replicationFields: Record<string, string>;
  keyspaceLines: string[];
} {
  const sections = info.split(/\r?\n#\s*/g);
  const out = {
    serverFields: {} as Record<string, string>,
    replicationFields: {} as Record<string, string>,
    keyspaceLines: [] as string[],
  };
  for (const sec of sections) {
    const [headerLine, ...rest] = sec.split(/\r?\n/);
    const header = headerLine.trim().toLowerCase();
    const lines = rest.filter((l) => l && !l.startsWith('#'));
    if (header.startsWith('server')) {
      for (const ln of lines) {
        const [k, v] = ln.split(':');
        if (k && v !== undefined) out.serverFields[k.trim()] = v.trim();
      }
    } else if (header.startsWith('replication')) {
      for (const ln of lines) {
        const [k, v] = ln.split(':');
        if (k && v !== undefined) out.replicationFields[k.trim()] = v.trim();
      }
    } else if (header.startsWith('keyspace')) {
      out.keyspaceLines.push(...lines);
    }
  }
  return out;
}

function parseKeyspaceSection(lines: string[]): { db: number; keys: number; expires: number }[] {
  const out: { db: number; keys: number; expires: number }[] = [];
  for (const line of lines) {
    // line looks like: db0:keys=3,expires=0,avg_ttl=0
    const m = line.match(/^db(\d+):keys=(\d+),expires=(\d+)/);
    if (m) {
      out.push({
        db: Number(m[1]),
        keys: Number(m[2]),
        expires: Number(m[3]),
      });
    }
  }
  return out;
}

/**
 * Build the ioredis options object once, used by both the primary and
 * the (lazy) subscriber connection so they share auth + TLS config.
 */
function buildClientOptions(config: ConnectionConfig): RedisOptions {
  const tls = buildNodeTlsOptions(config);
  if (resolveTls(config)?.mode === 'insecure') {
    console.warn(insecureTlsWarning(config.host));
  }
  return {
    host: config.host,
    port: config.port,
    password: config.password || undefined,
    username: config.user || undefined,
    db: parseDbIndex(config.database),
    tls,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 10_000,
    enableReadyCheck: true,
  };
}

/**
 * Convert any Redis reply (Buffer / nested arrays / strings / numbers)
 * to a JSON-serializable shape. Buffers become utf-8 strings.
 */
function serializeReply(reply: unknown): unknown {
  if (reply === null || reply === undefined) return null;
  if (Buffer.isBuffer(reply)) return reply.toString('utf8');
  if (Array.isArray(reply)) return reply.map(serializeReply);
  if (typeof reply === 'object') {
    const obj = reply as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = serializeReply(v);
    }
    return out;
  }
  return reply;
}
