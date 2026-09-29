import type {
  ConnectionConfig,
  RedisAnalyzeResult,
  RedisAnalyzeSample,
  RedisBulkDeleteResult,
  RedisCommandResult,
  RedisGetKeyOpts,
  RedisKeyMeta,
  RedisKeyValue,
  RedisOverview,
  RedisPatternDeleteResult,
  RedisPubsubMessage,
  RedisScanResult,
  RedisSlowlogEntry,
  RedisValueType,
  RedisWriteOp,
} from '@shared/protocol';
import type { RedisCell } from '@shared/redis-cell';
import { classifyRedisCommand } from '@shared/redis-command-policy';
import { buildNodeTlsOptions, insecureTlsWarning, resolveTls } from '@shared/tls';
import Redis, { Cluster, type ClusterOptions, type RedisOptions } from 'ioredis';
import { type RedisEndpoint, parseRedisEndpoint } from './redis-endpoint';
import { classifyBulkDelete, readAnalyzeMeta, readScanMeta } from './redis-pipeline';
import {
  LARGE_PREVIEW_BYTES,
  MAX_PAGE_BYTES,
  MAX_STRING_BYTES,
  cellCost,
  encodeCell,
  exceedsFetchBudget,
  largeValueStub,
  serializeCliReply,
} from './redis-value';

type RedisClient = InstanceType<typeof Redis>;

/** Callback fired by the driver whenever a pub/sub message arrives. */
export type RedisPubsubListener = (msg: RedisPubsubMessage) => void;

/**
 * Redis driver.
 *
 * Connections:
 *   - one client per logical database, created lazily (R5/R20). Every key
 *     operation names its db, so a CLI `SELECT`, the db switcher and open
 *     key tabs can never silently retarget each other.
 *   - a Cluster client instead when the endpoint is a cluster (R19); the
 *     per-master node clients are used for SCAN-style walks.
 *   - a separate subscriber connection for pub/sub (reference counted per
 *     channel so two tabs on the same channel don't cancel each other, R13).
 *   - a short-lived dedicated connection for blocking CLI commands (R3).
 *
 * `database` on the ConnectionConfig is the default Redis db index.
 * `readOnly` on the ConnectionConfig is enforced here too (S1): every
 * mutating method throws before touching the server.
 */

/** Default elements per key page. */
const PAGE_ELEMENTS = 500;
/** Hard cap for the analyzer sample (R14). */
export const MAX_ANALYZE_SAMPLE = 100_000;
/** A blocking CLI command is abandoned after this long (R3). */
export const BLOCKING_DEADLINE_MS = 30_000;
const DEFAULT_SCAN_BUDGET_MS = 1_500;

function parseDbIndex(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export class ReadOnlyError extends Error {
  constructor(what: string) {
    super(`read-only connection: ${what} is not allowed`);
    this.name = 'ReadOnlyError';
  }
}

export class RedisDriver {
  /** Standalone / sentinel / socket: one client per db index. */
  private clients = new Map<number, RedisClient>();
  private pendingClients = new Map<number, Promise<RedisClient>>();
  private cluster: Cluster | null = null;
  private baseDb = 0;
  private readOnly = false;
  private endpoint: RedisEndpoint | null = null;
  /**
   * Separate connection used exclusively for SUBSCRIBE / PSUBSCRIBE.
   * Redis blocks the primary connection from running normal commands
   * once it enters subscriber mode, so we keep this one isolated.
   */
  private subscriber: RedisClient | Cluster | null = null;
  /** Active subscriptions: `${pattern ? 'p' : 's'}:${channel}` → reference count. */
  private subscriptions = new Map<string, number>();
  private pubsubListener: RedisPubsubListener | null = null;
  private overview: RedisOverview | null = null;
  /** Captured connect config — needed to spin up extra connections lazily. */
  private connectConfig: ConnectionConfig | null = null;
  /** Bumped by cancel(); long walks stop when it changes. */
  private cancelGen = 0;
  private blockingClient: RedisClient | null = null;

  async connect(config: ConnectionConfig): Promise<string> {
    await this.disconnect();
    const endpoint = parseRedisEndpoint(config.host, config.port);
    this.endpoint = endpoint;
    this.baseDb = parseDbIndex(config.database);
    this.readOnly = config.readOnly === true;
    this.connectConfig = config;

    if (endpoint.kind === 'cluster') {
      this.cluster = await openCluster(config, endpoint.nodes);
    } else {
      const client = await openClient(config, endpoint, this.baseDb);
      // A plain host that is a cluster node: upgrade to a cluster client so
      // keys route by slot and SCAN walks every master (R19).
      if (endpoint.kind === 'tcp' && (await isClusterNode(client))) {
        try {
          this.cluster = await openCluster(config, [{ host: endpoint.host, port: endpoint.port }]);
          client.disconnect();
        } catch {
          // Unreachable announced node addresses (NAT / tunnel): stay on
          // the single node; commands for other slots will report MOVED.
          this.clients.set(this.baseDb, client);
        }
      } else {
        this.clients.set(this.baseDb, client);
      }
    }
    this.overview = await this.readOverview();
    return this.overview.redisVersion;
  }

  /** Register a sink for pub/sub messages. Replaces any prior listener. */
  setPubsubListener(listener: RedisPubsubListener | null): void {
    this.pubsubListener = listener;
  }

  get isCluster(): boolean {
    return this.cluster !== null;
  }

  async disconnect(): Promise<void> {
    const handles: Array<{ disconnect(): void } | null> = [
      ...this.clients.values(),
      this.cluster,
      this.subscriber,
      this.blockingClient,
    ];
    this.clients.clear();
    this.pendingClients.clear();
    this.cluster = null;
    this.subscriber = null;
    this.blockingClient = null;
    this.subscriptions.clear();
    this.overview = null;
    this.connectConfig = null;
    this.endpoint = null;
    this.cancelGen++;
    for (const handle of handles) {
      if (!handle) continue;
      try {
        handle.disconnect();
      } catch {
        // best-effort
      }
    }
  }

  /** Stop the running analyzer / pattern delete / blocking command. */
  cancel(): void {
    this.cancelGen++;
    const b = this.blockingClient;
    this.blockingClient = null;
    if (b) {
      try {
        b.disconnect();
      } catch {
        // best-effort
      }
    }
  }

  private assertWritable(what: string): void {
    if (this.readOnly) throw new ReadOnlyError(what);
  }

  /**
   * Client for one db. Cluster mode only has db 0. Lazily opens a new
   * connection the first time a db is used; the server's "DB index is out
   * of range" error surfaces to the caller.
   */
  private async client(db?: number): Promise<RedisClient> {
    if (!this.connectConfig || !this.endpoint) throw new Error('not connected');
    const target = db ?? this.baseDb;
    if (this.cluster) {
      if (target !== 0) throw new Error('Redis Cluster has a single database (db0)');
      return this.cluster as unknown as RedisClient;
    }
    const existing = this.clients.get(target);
    if (existing) return existing;
    const pending = this.pendingClients.get(target);
    if (pending) return pending;
    const config = this.connectConfig;
    const endpoint = this.endpoint;
    const p = openClient(config, endpoint, target)
      .then((c) => {
        if (this.connectConfig !== config) {
          c.disconnect();
          throw new Error('not connected');
        }
        this.clients.set(target, c);
        return c;
      })
      .finally(() => this.pendingClients.delete(target));
    this.pendingClients.set(target, p);
    return p;
  }

  /** Clients to walk for keyspace-wide scans: every master in cluster mode. */
  private async scanNodes(db?: number): Promise<RedisClient[]> {
    if (this.cluster) {
      const masters = this.cluster.nodes('master');
      return [...masters].sort((a, b) => nodeId(a).localeCompare(nodeId(b)));
    }
    return [await this.client(db)];
  }

  async refreshOverview(): Promise<RedisOverview> {
    this.overview = await this.readOverview();
    return this.overview;
  }

  private async readOverview(): Promise<RedisOverview> {
    const c = await this.client(this.cluster ? 0 : undefined);
    const info = await c.info();
    const parsed = parseInfo(info);
    let keyspace = parseKeyspaceSection(parsed.keyspaceLines);
    let dbCount = 16;
    if (this.cluster) {
      dbCount = 1;
      // Sum db0 across masters — INFO on the cluster client hits one node.
      let keys = 0;
      let expires = 0;
      for (const node of this.cluster.nodes('master')) {
        try {
          const ks = parseKeyspaceSection(parseInfo(await node.info('keyspace')).keyspaceLines);
          keys += ks.find((k) => k.db === 0)?.keys ?? 0;
          expires += ks.find((k) => k.db === 0)?.expires ?? 0;
        } catch {
          // node unreachable — partial counts are still useful
        }
      }
      keyspace = [{ db: 0, keys, expires }];
    } else {
      dbCount = await readDatabaseCount(c);
    }
    return {
      redisVersion: parsed.serverFields.redis_version ?? 'unknown',
      mode: this.cluster
        ? 'cluster'
        : this.endpoint?.kind === 'sentinel'
          ? 'sentinel'
          : (parsed.serverFields.redis_mode ?? 'standalone'),
      role: parsed.replicationFields.role ?? 'unknown',
      dbCount,
      keyspace,
      usedMemoryHuman: parsed.memoryFields.used_memory_human,
      // maxmemory 0 = no limit; report nothing rather than "0B".
      maxMemoryHuman:
        parsed.memoryFields.maxmemory && parsed.memoryFields.maxmemory !== '0'
          ? parsed.memoryFields.maxmemory_human
          : undefined,
      connectedClients: toInt(parsed.clientFields.connected_clients),
      uptimeSeconds: toInt(parsed.serverFields.uptime_in_seconds),
    };
  }

  /**
   * One sidebar page of keys. With `minResults`, keeps calling SCAN until
   * that many keys matched, the cursor finished, or the time budget ran
   * out (R8/F10) — MATCH pages are otherwise often empty mid-keyspace.
   * In cluster mode the cursor is `nodeIndex:cursor` across masters.
   */
  async scan(opts: {
    cursor: string;
    match?: string;
    count: number;
    db?: number;
    minResults?: number;
    budgetMs?: number;
    type?: string;
  }): Promise<RedisScanResult> {
    const nodes = await this.scanNodes(opts.db);
    const deadline = Date.now() + (opts.budgetMs ?? DEFAULT_SCAN_BUDGET_MS);
    const want = opts.minResults ?? 1;
    let { node, cursor } = parseCompositeCursor(opts.cursor, nodes.length);
    const found = new Map<string, RedisClient>();
    let iterations = 0;
    let done = false;
    do {
      const c = nodes[node]!;
      const args: (string | number)[] = [cursor];
      if (opts.match) args.push('MATCH', opts.match);
      args.push('COUNT', opts.count);
      if (opts.type) args.push('TYPE', opts.type);
      const [next, keys] = (await c.call('SCAN', ...args)) as [string, string[]];
      iterations++;
      for (const k of keys) if (!found.has(k)) found.set(k, c);
      cursor = next;
      if (cursor === '0') {
        if (node + 1 < nodes.length) {
          node++;
        } else {
          done = true;
        }
      }
    } while (!done && found.size < want && Date.now() < deadline);

    const nextCursor = done ? '0' : formatCompositeCursor(node, cursor, nodes.length);
    const keys = [...found.keys()];
    if (keys.length === 0) {
      return { cursor: nextCursor, keys: [], scanned: 0, iterations, db: opts.db };
    }

    // Pipeline TYPE + PTTL per owning node — single round-trip per node.
    const byNode = new Map<RedisClient, string[]>();
    for (const [k, c] of found) {
      const list = byNode.get(c) ?? [];
      list.push(k);
      byNode.set(c, list);
    }
    const metaByKey = new Map<string, RedisKeyMeta>();
    for (const [c, list] of byNode) {
      const pipe = c.pipeline();
      for (const k of list) {
        pipe.type(k);
        pipe.pttl(k);
      }
      const results = (await pipe.exec()) ?? [];
      list.forEach((k, i) => {
        const meta = readScanMeta(results[i * 2], results[i * 2 + 1]);
        const pttl = meta.pttl;
        metaByKey.set(k, {
          key: k,
          type: normalizeType(meta.typeRaw),
          // null = no expiry OR ttl command error (unavailable), never invent a TTL.
          ttlMs: pttl != null && pttl >= 0 ? pttl : null,
          sizeBytes: null,
        });
      });
    }
    const out = keys.map((k) => metaByKey.get(k)!).filter((m) => m.type !== 'none');
    return { cursor: nextCursor, keys: out, scanned: out.length, iterations, db: opts.db };
  }

  async getKey(key: string, opts: RedisGetKeyOpts = {}): Promise<RedisKeyValue> {
    const c = await this.client(opts.db);
    const count = opts.count ?? PAGE_ELEMENTS;
    const firstPage = opts.cursor === undefined;
    const [typeRaw, pttl] = await Promise.all([c.type(key), c.pttl(key)]);
    const type = normalizeType(typeRaw);
    const ttlMs = pttl >= 0 ? pttl : null;

    let encoding: string | undefined;
    let memoryBytes: number | null = null;
    let idleSeconds: number | null = null;
    let freq: number | null = null;
    if (firstPage && type !== 'none') {
      // OBJECT / MEMORY may be ACL-blocked on hosted Redis — all optional (R27).
      const pipe = c.pipeline();
      pipe.call('OBJECT', 'ENCODING', key);
      pipe.call('MEMORY', 'USAGE', key);
      pipe.call('OBJECT', 'IDLETIME', key);
      pipe.call('OBJECT', 'FREQ', key);
      const r = (await pipe.exec().catch(() => null)) ?? [];
      const ok = (i: number) => (r[i] && !r[i]![0] ? r[i]![1] : null);
      encoding = typeof ok(0) === 'string' ? (ok(0) as string) : undefined;
      memoryBytes = toNum(ok(1));
      idleSeconds = toNum(ok(2));
      freq = toNum(ok(3));
    }

    let value: unknown = null;
    let nextCursor: string | null = null;
    let byteCapped = false;

    switch (type) {
      case 'string': {
        // STRLEN is O(1); refuse multi-megabyte payloads before GET (R11).
        let strlen: number | null = null;
        try {
          strlen = await c.strlen(key);
        } catch {
          // STRLEN may be ACL-blocked — fall through to GET.
        }
        if (exceedsFetchBudget(strlen)) {
          let preview: RedisCell | null = null;
          try {
            const head = await c.getrangeBuffer(key, 0, LARGE_PREVIEW_BYTES - 1);
            preview = encodeCell(head, LARGE_PREVIEW_BYTES, strlen!);
          } catch {
            // GETRANGE blocked — no preview.
          }
          value = { ...largeValueStub(strlen!), preview };
        } else {
          value = encodeCell(await c.getBuffer(key), MAX_STRING_BYTES);
        }
        break;
      }
      case 'list': {
        const total = await c.llen(key);
        const start = Math.max(0, Number.parseInt(opts.cursor ?? '0', 10) || 0);
        const raw = await c.lrangeBuffer(key, start, start + count - 1);
        const items: (RedisCell | null)[] = [];
        let bytes = 0;
        for (const b of raw) {
          const cell = encodeCell(b);
          items.push(cell);
          bytes += cellCost(cell);
          if (bytes > MAX_PAGE_BYTES) {
            byteCapped = true;
            break;
          }
        }
        const nextStart = start + items.length;
        nextCursor = nextStart < total ? String(nextStart) : null;
        value = { items, total, offset: start };
        break;
      }
      case 'set': {
        const total = await c.scard(key);
        const items: (RedisCell | null)[] = [];
        let cur = opts.cursor ?? '0';
        let bytes = 0;
        do {
          const args: (string | number)[] = [cur];
          if (opts.match) args.push('MATCH', opts.match);
          args.push('COUNT', 200);
          const [next, members] = (await c.callBuffer('SSCAN', key, ...args)) as [Buffer, Buffer[]];
          for (const m of members) {
            const cell = encodeCell(m);
            items.push(cell);
            bytes += cellCost(cell);
          }
          cur = next.toString();
          if (bytes > MAX_PAGE_BYTES) byteCapped = true;
        } while (cur !== '0' && items.length < count && !byteCapped);
        nextCursor = cur === '0' ? null : cur;
        value = { items, total };
        break;
      }
      case 'zset': {
        const total = await c.zcard(key);
        const items: [RedisCell | null, string][] = [];
        if (opts.match) {
          let cur = opts.cursor ?? '0';
          let bytes = 0;
          do {
            const [next, flat] = (await c.callBuffer(
              'ZSCAN',
              key,
              cur,
              'MATCH',
              opts.match,
              'COUNT',
              200,
            )) as [Buffer, Buffer[]];
            for (let i = 0; i + 1 < flat.length; i += 2) {
              const cell = encodeCell(flat[i]!);
              items.push([cell, flat[i + 1]!.toString()]);
              bytes += cellCost(cell);
            }
            cur = next.toString();
            if (bytes > MAX_PAGE_BYTES) byteCapped = true;
          } while (cur !== '0' && items.length < count && !byteCapped);
          nextCursor = cur === '0' ? null : cur;
        } else {
          const start = Math.max(0, Number.parseInt(opts.cursor ?? '0', 10) || 0);
          const flat = (await c.callBuffer(
            opts.reverse ? 'ZREVRANGE' : 'ZRANGE',
            key,
            start,
            start + count - 1,
            'WITHSCORES',
          )) as Buffer[];
          let bytes = 0;
          for (let i = 0; i + 1 < flat.length; i += 2) {
            const cell = encodeCell(flat[i]!);
            items.push([cell, flat[i + 1]!.toString()]);
            bytes += cellCost(cell);
            if (bytes > MAX_PAGE_BYTES) {
              byteCapped = true;
              break;
            }
          }
          const nextStart = start + items.length;
          nextCursor = nextStart < total ? String(nextStart) : null;
        }
        value = { items, total };
        break;
      }
      case 'hash': {
        // HSCAN + HLEN — never HGETALL, which can blow the heap on wide hashes.
        const total = await c.hlen(key);
        const items: [RedisCell | null, RedisCell | null][] = [];
        let cur = opts.cursor ?? '0';
        let bytes = 0;
        do {
          const args: (string | number)[] = [cur];
          if (opts.match) args.push('MATCH', opts.match);
          args.push('COUNT', 200);
          const [next, flat] = (await c.callBuffer('HSCAN', key, ...args)) as [Buffer, Buffer[]];
          for (let i = 0; i + 1 < flat.length; i += 2) {
            const f = encodeCell(flat[i]!);
            const v = encodeCell(flat[i + 1]!);
            items.push([f, v]);
            bytes += cellCost(f) + cellCost(v);
          }
          cur = next.toString();
          if (bytes > MAX_PAGE_BYTES) byteCapped = true;
        } while (cur !== '0' && items.length < count && !byteCapped);
        nextCursor = cur === '0' ? null : cur;
        value = { items, total };
        break;
      }
      case 'stream': {
        try {
          const total = Number(await c.call('XLEN', key));
          const from = opts.cursor ?? (opts.reverse ? '+' : '-');
          const to = opts.reverse ? '-' : '+';
          // Fetch one extra entry: its id is the (inclusive) next cursor.
          const raw = (await c.callBuffer(
            opts.reverse ? 'XREVRANGE' : 'XRANGE',
            key,
            from,
            to,
            'COUNT',
            count + 1,
          )) as Array<[Buffer, Buffer[]]>;
          const page = raw.slice(0, count);
          if (raw.length > count) nextCursor = raw[count]![0].toString();
          const items = page.map(([id, flat]) => {
            const fields: [string, RedisCell | null][] = [];
            for (let i = 0; i + 1 < flat.length; i += 2) {
              fields.push([flat[i]!.toString(), encodeCell(flat[i + 1]!)]);
            }
            return { id: id.toString(), fields };
          });
          let groups: StreamGroup[] | undefined;
          if (firstPage) groups = await readStreamGroups(c, key);
          value = { items, total, groups };
        } catch (err) {
          value = { error: err instanceof Error ? err.message : String(err) };
        }
        break;
      }
      case 'json': {
        try {
          // MEMORY USAGE gates RedisJSON the same way STRLEN gates strings.
          if (exceedsFetchBudget(memoryBytes)) {
            value = largeValueStub(memoryBytes!);
          } else {
            const raw = (await c.call('JSON.GET', key)) as string | null;
            value = raw ? JSON.parse(raw) : null;
          }
        } catch (err) {
          value = { error: err instanceof Error ? err.message : String(err) };
        }
        break;
      }
      case 'none':
        value = null;
        break;
      default:
        // Module types (TimeSeries, Bloom, …): no generic read — the view
        // shows "unsupported type" and offers the CLI (R16).
        value = null;
    }

    return {
      key,
      type,
      ttlMs,
      encoding,
      value,
      typeName: type === 'unknown' ? typeRaw : undefined,
      memoryBytes: firstPage ? memoryBytes : undefined,
      idleSeconds: firstPage ? idleSeconds : undefined,
      freq: firstPage ? freq : undefined,
      nextCursor,
      byteCapped: byteCapped || undefined,
      db: opts.db,
    };
  }

  async deleteKey(key: string, db?: number): Promise<void> {
    this.assertWritable('delete');
    const c = await this.client(db);
    await unlinkOrDel(c, [key]);
  }

  async setTtl(
    key: string,
    value: number,
    db?: number,
    mode: 'expire' | 'pexpire' | 'expireat' | 'persist' = 'expire',
  ): Promise<void> {
    this.assertWritable('set TTL');
    const c = await this.client(db);
    let res: number;
    if (mode === 'persist' || (mode === 'expire' && value <= 0)) {
      res = await c.persist(key);
      if (res === 0 && (await c.exists(key)) === 0) throw new Error(`key "${key}" does not exist`);
      return;
    }
    if (value <= 0) throw new Error('TTL must be positive — use Persist to remove the expiry');
    if (mode === 'pexpire') res = await c.pexpire(key, value);
    else if (mode === 'expireat') res = await c.expireat(key, value);
    else res = await c.expire(key, value);
    if (res === 0) throw new Error(`key "${key}" does not exist`);
  }

  async bulkDelete(keys: string[], db?: number): Promise<RedisBulkDeleteResult> {
    this.assertWritable('delete');
    if (keys.length === 0) return { deleted: [], failed: [] };
    const c = await this.client(db);
    if (this.cluster) {
      // Cross-slot pipelines are rejected in cluster mode: one call per key.
      const results = await Promise.all(
        keys.map((k) =>
          c.unlink(k).then(
            (r): [Error | null, unknown] => [null, r],
            (e: Error): [Error | null, unknown] => [e, null],
          ),
        ),
      );
      return classifyBulkDelete(keys, results);
    }
    // Inspect per-command [err, res] tuples so ACL / OOM failures are not
    // reported as successful deletes. UNLINK frees memory off-thread (R26).
    const useUnlink = await supportsUnlink(c);
    const pipe = c.pipeline();
    for (const k of keys) {
      if (useUnlink) pipe.unlink(k);
      else pipe.del(k);
    }
    const results = (await pipe.exec()) ?? [];
    return classifyBulkDelete(keys, results);
  }

  /**
   * Delete every key matching `match` (SCAN + UNLINK, R26). `dryRun`
   * counts and samples without deleting. Stops at `limit` or on cancel().
   */
  async deleteByPattern(opts: {
    match: string;
    db?: number;
    dryRun: boolean;
    limit: number;
  }): Promise<RedisPatternDeleteResult> {
    if (!opts.dryRun) this.assertWritable('delete');
    const gen = this.cancelGen;
    const nodes = await this.scanNodes(opts.db);
    let matched = 0;
    let deleted = 0;
    let failed = 0;
    let capped = false;
    const sample: string[] = [];
    const seen = new Set<string>();
    outer: for (const node of nodes) {
      const useUnlink = opts.dryRun ? false : await supportsUnlink(node);
      let cursor = '0';
      do {
        if (this.cancelGen !== gen) break outer;
        const [next, keys] = (await node.call(
          'SCAN',
          cursor,
          'MATCH',
          opts.match,
          'COUNT',
          1000,
        )) as [string, string[]];
        cursor = next;
        const fresh = keys.filter((k) => !seen.has(k));
        for (const k of fresh) seen.add(k);
        const room = opts.limit - matched;
        const batch = fresh.slice(0, room);
        matched += batch.length;
        for (const k of batch) if (sample.length < 20) sample.push(k);
        if (!opts.dryRun && batch.length > 0) {
          const pipe = node.pipeline();
          for (const k of batch) {
            if (useUnlink) pipe.unlink(k);
            else pipe.del(k);
          }
          const res = classifyBulkDelete(batch, (await pipe.exec()) ?? []);
          deleted += res.deleted.length;
          failed += res.failed.length;
        }
        if (matched >= opts.limit) {
          capped = cursor !== '0' || fresh.length > batch.length;
          break outer;
        }
      } while (cursor !== '0');
    }
    return { matched, deleted, sample, capped, failed, dryRun: opts.dryRun };
  }

  async write(op: RedisWriteOp, db?: number): Promise<void> {
    this.assertWritable(op.kind);
    const c = await this.client(db);
    switch (op.kind) {
      case 'setString':
        if (op.ttlSeconds && op.ttlSeconds > 0) {
          await c.set(op.key, op.value, 'EX', op.ttlSeconds);
        } else if (op.keepTtl) {
          await setKeepTtl(c, op.key, op.value);
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
      case 'hashRename': {
        if (op.field === op.newField) return;
        if ((await c.hexists(op.key, op.newField)) === 1) {
          throw new Error(`field "${op.newField}" already exists`);
        }
        const v = await c.hgetBuffer(op.key, op.field);
        if (v === null) throw new Error(`field "${op.field}" no longer exists`);
        await execOrThrow(c.multi().hset(op.key, op.newField, v).hdel(op.key, op.field));
        return;
      }
      case 'listPush':
        if (op.side === 'l') await c.lpush(op.key, ...op.values);
        else await c.rpush(op.key, ...op.values);
        return;
      case 'listSet':
        await c.lset(op.key, op.index, op.value);
        return;
      case 'listRem': {
        const n = await c.lrem(op.key, op.count ?? 1, op.value);
        if (n === 0) throw new Error('element not found (the list changed?) — refresh and retry');
        return;
      }
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
      case 'streamAdd':
        await c.call('XADD', op.key, op.id || '*', ...op.fields.flat());
        return;
      case 'streamDel':
        await c.call('XDEL', op.key, ...op.ids);
        return;
      case 'jsonSet':
        await c.call('JSON.SET', op.key, op.path || '$', op.value);
        return;
      case 'rename': {
        if (op.key === op.newKey) return;
        if (op.overwrite) {
          await c.rename(op.key, op.newKey);
        } else if ((await c.renamenx(op.key, op.newKey)) === 0) {
          throw new Error(`key "${op.newKey}" already exists`);
        }
        return;
      }
      case 'copy':
        await copyKey(c, op.key, op.newKey, op.overwrite === true);
        return;
      case 'createKey':
        await createKey(c, op);
        return;
    }
  }

  /**
   * Walk a SCAN sample and pull MEMORY USAGE for each key. Aggregates
   * by Redis value type and `:`-namespace prefix. Capped at `sampleCap`
   * (≤ MAX_ANALYZE_SAMPLE) and stoppable with cancel() (R14).
   */
  async analyze(opts: {
    sampleCap: number;
    match?: string;
    db?: number;
  }): Promise<RedisAnalyzeResult> {
    const gen = this.cancelGen;
    const cap = Math.max(1, Math.min(opts.sampleCap, MAX_ANALYZE_SAMPLE));
    const nodes = await this.scanNodes(opts.db);
    const samples: RedisAnalyzeSample[] = [];
    let scanned = 0;
    let cancelled = false;
    outer: for (const c of nodes) {
      let cursor = '0';
      do {
        if (this.cancelGen !== gen) {
          cancelled = true;
          break outer;
        }
        const args: (string | number)[] = [cursor];
        if (opts.match) args.push('MATCH', opts.match);
        args.push('COUNT', 500);
        const [next, keys] = (await c.call('SCAN', ...args)) as [string, string[]];
        cursor = next;
        if (keys.length === 0) continue;
        const pipe = c.pipeline();
        for (const k of keys) {
          pipe.type(k);
          pipe.pttl(k);
          pipe.call('MEMORY', 'USAGE', k);
        }
        const results = (await pipe.exec()) ?? [];
        for (let i = 0; i < keys.length; i++) {
          const meta = readAnalyzeMeta(results[i * 3], results[i * 3 + 1], results[i * 3 + 2]);
          const pttl = meta.pttl;
          samples.push({
            key: keys[i]!,
            type: normalizeType(meta.typeRaw),
            // null distinguishes unavailable MEMORY USAGE from a true 0-byte key.
            bytes: meta.bytes,
            ttlMs: pttl != null && pttl >= 0 ? pttl : null,
          });
        }
        scanned += keys.length;
        if (scanned >= cap) break outer;
      } while (cursor !== '0');
    }
    return aggregateAnalyze(samples, scanned, cancelled);
  }

  async slowlog(limit: number): Promise<RedisSlowlogEntry[]> {
    const c = await this.client();
    const reply = (await c.call('SLOWLOG', 'GET', String(limit))) as Array<unknown>;
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

  /** Reference-counted: a second tab on the same channel shares the subscription (R13). */
  async subscribe(channel: string, pattern: boolean): Promise<void> {
    if (!this.connectConfig) throw new Error('not connected');
    const tag = `${pattern ? 'p' : 's'}:${channel}`;
    const refs = this.subscriptions.get(tag) ?? 0;
    if (refs > 0) {
      this.subscriptions.set(tag, refs + 1);
      return;
    }
    const sub = await this.ensureSubscriber();
    if (pattern) await sub.psubscribe(channel);
    else await sub.subscribe(channel);
    this.subscriptions.set(tag, (this.subscriptions.get(tag) ?? 0) + 1);
  }

  async unsubscribe(channel: string, pattern: boolean): Promise<void> {
    const sub = this.subscriber;
    if (!sub) return;
    const tag = `${pattern ? 'p' : 's'}:${channel}`;
    const refs = this.subscriptions.get(tag) ?? 0;
    if (refs === 0) return;
    if (refs > 1) {
      this.subscriptions.set(tag, refs - 1);
      return;
    }
    this.subscriptions.delete(tag);
    if (pattern) await sub.punsubscribe(channel);
    else await sub.unsubscribe(channel);
    // No more subscriptions: drop the subscriber connection so a future
    // subscribe gets a fresh one.
    if (this.subscriptions.size === 0) {
      try {
        sub.disconnect();
      } catch {
        // best-effort
      }
      this.subscriber = null;
    }
  }

  private async ensureSubscriber(): Promise<RedisClient | Cluster> {
    if (this.subscriber) return this.subscriber;
    const config = this.connectConfig;
    const endpoint = this.endpoint;
    if (!config || !endpoint) throw new Error('not connected');
    // Subscriber mode tolerates re-subscribes through reconnects; keep
    // retries on (the primary connection is the strict one).
    const sub: RedisClient | Cluster = this.cluster
      ? new Cluster(clusterSeeds(endpoint), {
          ...clusterOptions(config),
          redisOptions: { ...clusterOptions(config).redisOptions, maxRetriesPerRequest: null },
        })
      : new Redis({
          ...buildClientOptions(config, endpoint, this.baseDb),
          maxRetriesPerRequest: null,
        });
    sub.on('error', () => {});
    sub.on('message', (channel: string, message: string) => {
      this.pubsubListener?.({ channel, message, pattern: false, timestamp: Date.now() });
    });
    sub.on('pmessage', (_pattern: string, channel: string, message: string) => {
      this.pubsubListener?.({ channel, message, pattern: true, timestamp: Date.now() });
    });
    await sub.connect();
    this.subscriber = sub;
    return sub;
  }

  /**
   * redis-cli. Refuses subscriber/connection-state commands, handles
   * SELECT as a db switch, enforces read-only, and runs blocking commands
   * on a dedicated connection with a deadline (R3).
   */
  async command(parts: string[], db?: number): Promise<RedisCommandResult> {
    if (parts.length === 0) throw new Error('empty command');
    const verdict = classifyRedisCommand(parts);
    const [head, ...tail] = parts as [string, ...string[]];
    const start = Date.now();
    if (verdict.mode === 'refuse')
      throw new Error(verdict.reason ?? `${verdict.verb} is not supported here`);
    if (verdict.access === 'write' && this.readOnly) {
      throw new ReadOnlyError(`${verdict.verb} (a write command)`);
    }
    if (verdict.mode === 'select') {
      const n = Number(tail[0]);
      if (tail.length !== 1 || !Number.isInteger(n) || n < 0) {
        throw new Error("ERR wrong number of arguments for 'select' command");
      }
      const c = await this.client(n);
      await c.ping();
      return { command: 'SELECT', args: tail, reply: 'OK', durationMs: Date.now() - start };
    }
    if (verdict.mode === 'blocking') {
      const reply = await this.runBlocking(parts, db);
      return {
        command: head.toUpperCase(),
        args: tail,
        reply: serializeCliReply(reply),
        durationMs: Date.now() - start,
      };
    }
    const c = await this.client(db);
    const reply = await c.callBuffer(head, ...tail);
    return {
      command: head.toUpperCase(),
      args: tail,
      reply: serializeCliReply(reply),
      durationMs: Date.now() - start,
    };
  }

  private async runBlocking(parts: string[], db?: number): Promise<unknown> {
    const config = this.connectConfig;
    const endpoint = this.endpoint;
    if (!config || !endpoint) throw new Error('not connected');
    if (this.cluster) {
      throw new Error('Blocking commands are not supported on cluster connections from the CLI');
    }
    if (this.blockingClient) throw new Error('another blocking command is still running');
    const c = await openClient(config, endpoint, db ?? this.baseDb, { maxRetriesPerRequest: 0 });
    this.blockingClient = c;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const [head, ...tail] = parts as [string, ...string[]];
      return await Promise.race([
        c.callBuffer(head, ...tail),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `${head.toUpperCase()} gave up after ${BLOCKING_DEADLINE_MS / 1000}s (Plasma caps blocking commands; use a shorter timeout)`,
                ),
              ),
            BLOCKING_DEADLINE_MS,
          );
        }),
      ]);
    } catch (err) {
      if (this.blockingClient !== c) throw new Error('cancelled');
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      if (this.blockingClient === c) this.blockingClient = null;
      try {
        c.disconnect();
      } catch {
        // best-effort
      }
    }
  }
}

// ───────────────────────── helpers ─────────────────────────

interface StreamGroup {
  name: string;
  consumers: number;
  pending: number;
  lastDeliveredId: string;
  lag: number | null;
}

async function readStreamGroups(c: RedisClient, key: string): Promise<StreamGroup[] | undefined> {
  try {
    const raw = (await c.call('XINFO', 'GROUPS', key)) as unknown[][];
    return raw.map((flat) => {
      const m = new Map<string, unknown>();
      for (let i = 0; i + 1 < flat.length; i += 2) m.set(String(flat[i]), flat[i + 1]);
      return {
        name: String(m.get('name') ?? ''),
        consumers: Number(m.get('consumers') ?? 0),
        pending: Number(m.get('pending') ?? 0),
        lastDeliveredId: String(m.get('last-delivered-id') ?? ''),
        lag: m.get('lag') == null ? null : Number(m.get('lag')),
      };
    });
  } catch {
    return undefined;
  }
}

export function aggregateAnalyze(
  samples: RedisAnalyzeSample[],
  scanned: number,
  cancelled: boolean,
): RedisAnalyzeResult {
  samples.sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));
  let totalBytes = 0;
  let unsized = 0;
  const byTypeMap = new Map<RedisValueType, { count: number; bytes: number }>();
  const byPrefixMap = new Map<string, { count: number; bytes: number }>();
  for (const s of samples) {
    if (s.bytes === null) unsized++;
    const known = s.bytes ?? 0;
    totalBytes += known;
    const t = byTypeMap.get(s.type) ?? { count: 0, bytes: 0 };
    t.count += 1;
    t.bytes += known;
    byTypeMap.set(s.type, t);
    const prefix = s.key.split(':')[0] ?? s.key;
    const p = byPrefixMap.get(prefix) ?? { count: 0, bytes: 0 };
    p.count += 1;
    p.bytes += known;
    byPrefixMap.set(prefix, p);
  }
  return {
    scanned,
    totalBytes,
    // Top 1000 only — serializing 50k keys across IPC is wasteful.
    samples: samples.slice(0, 1000),
    byType: [...byTypeMap.entries()]
      .map(([type, v]) => ({ type, ...v }))
      .sort((a, b) => b.bytes - a.bytes),
    byPrefix: [...byPrefixMap.entries()]
      .map(([prefix, v]) => ({ prefix, ...v }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 50),
    cancelled: cancelled || undefined,
    unsized: unsized || undefined,
  };
}

/** `SCAN` cursor across cluster masters: "node:cursor". Plain cursor for one node. */
export function parseCompositeCursor(
  raw: string,
  nodeCount: number,
): { node: number; cursor: string } {
  if (nodeCount <= 1) return { node: 0, cursor: raw || '0' };
  const i = raw.indexOf(':');
  if (i < 0) return { node: 0, cursor: raw || '0' };
  const node = Number(raw.slice(0, i));
  return {
    node: Number.isInteger(node) && node >= 0 && node < nodeCount ? node : 0,
    cursor: raw.slice(i + 1) || '0',
  };
}

export function formatCompositeCursor(node: number, cursor: string, nodeCount: number): string {
  if (nodeCount <= 1) return cursor;
  return `${node}:${cursor}`;
}

function nodeId(c: RedisClient): string {
  return `${c.options.host ?? ''}:${c.options.port ?? ''}`;
}

async function isClusterNode(c: RedisClient): Promise<boolean> {
  try {
    const info = await c.info('server');
    return /redis_mode:cluster/.test(info);
  } catch {
    return false;
  }
}

async function readDatabaseCount(c: RedisClient): Promise<number> {
  try {
    const r = (await c.call('CONFIG', 'GET', 'databases')) as string[];
    const n = Number(r?.[1]);
    return Number.isInteger(n) && n > 0 ? n : 16;
  } catch {
    // CONFIG is commonly ACL-blocked on hosted Redis.
    return 16;
  }
}

const unlinkSupport = new WeakMap<RedisClient, boolean>();
async function supportsUnlink(c: RedisClient): Promise<boolean> {
  const known = unlinkSupport.get(c);
  if (known !== undefined) return known;
  let ok = true;
  try {
    await c.unlink('__plasma_unlink_probe__');
  } catch (err) {
    ok = !/unknown command/i.test(err instanceof Error ? err.message : String(err));
  }
  unlinkSupport.set(c, ok);
  return ok;
}

async function unlinkOrDel(c: RedisClient, keys: string[]): Promise<number> {
  try {
    return await c.unlink(...keys);
  } catch (err) {
    if (/unknown command/i.test(err instanceof Error ? err.message : String(err))) {
      return c.del(...keys);
    }
    throw err;
  }
}

async function execOrThrow(multi: ReturnType<RedisClient['multi']>): Promise<void> {
  const res = await multi.exec();
  if (!res) throw new Error('transaction aborted');
  for (const [err] of res) if (err) throw err;
}

/** SET … KEEPTTL (Redis ≥ 6); older servers: re-apply the *current* PTTL (R9). */
async function setKeepTtl(c: RedisClient, key: string, value: string): Promise<void> {
  try {
    await c.call('SET', key, value, 'KEEPTTL');
  } catch (err) {
    if (!/syntax error/i.test(err instanceof Error ? err.message : String(err))) throw err;
    const pttl = await c.pttl(key);
    if (pttl > 0) await c.set(key, value, 'PX', pttl);
    else await c.set(key, value);
  }
}

async function copyKey(
  c: RedisClient,
  from: string,
  to: string,
  overwrite: boolean,
): Promise<void> {
  if (from === to) throw new Error('source and destination are the same key');
  try {
    const args = overwrite ? [from, to, 'REPLACE'] : [from, to];
    const n = Number(await c.call('COPY', ...args));
    if (n === 0) {
      if ((await c.exists(from)) === 0) throw new Error(`key "${from}" does not exist`);
      throw new Error(`key "${to}" already exists`);
    }
    return;
  } catch (err) {
    if (!/unknown command/i.test(err instanceof Error ? err.message : String(err))) throw err;
  }
  // Redis < 6.2: DUMP + RESTORE (same server, binary safe), keeping the TTL.
  const dump = await c.dumpBuffer(from);
  if (!dump) throw new Error(`key "${from}" does not exist`);
  const pttl = await c.pttl(from);
  const args: (string | number | Buffer)[] = [to, pttl > 0 ? pttl : 0, dump];
  if (overwrite) args.push('REPLACE');
  try {
    await c.call('RESTORE', ...args);
  } catch (err) {
    if (/BUSYKEY/i.test(err instanceof Error ? err.message : String(err))) {
      throw new Error(`key "${to}" already exists`);
    }
    throw err;
  }
}

async function createKey(
  c: RedisClient,
  op: Extract<RedisWriteOp, { kind: 'createKey' }>,
): Promise<void> {
  if ((await c.exists(op.key)) === 1) throw new Error(`key "${op.key}" already exists`);
  const m = c.multi();
  switch (op.keyType) {
    case 'string':
      m.set(op.key, op.value);
      break;
    case 'hash':
      if (!op.field) throw new Error('a hash needs a first field');
      m.hset(op.key, op.field, op.value);
      break;
    case 'list':
      m.rpush(op.key, op.value);
      break;
    case 'set':
      m.sadd(op.key, op.value);
      break;
    case 'zset':
      if (op.score === undefined || !Number.isFinite(op.score))
        throw new Error('a sorted set needs a score');
      m.zadd(op.key, op.score, op.value);
      break;
    case 'stream':
      if (!op.field) throw new Error('a stream entry needs a field name');
      m.call('XADD', op.key, '*', op.field, op.value);
      break;
    case 'json':
      JSON.parse(op.value); // validate before sending
      m.call('JSON.SET', op.key, '$', op.value, 'NX');
      break;
  }
  if (op.ttlSeconds) m.expire(op.key, op.ttlSeconds);
  await execOrThrow(m);
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

/** Split `INFO` output into the sections Plasma reads. Exported for tests. */
export function parseInfo(info: string): {
  serverFields: Record<string, string>;
  replicationFields: Record<string, string>;
  memoryFields: Record<string, string>;
  clientFields: Record<string, string>;
  keyspaceLines: string[];
} {
  const sections = info.split(/\r?\n#\s*/g);
  const out = {
    serverFields: {} as Record<string, string>,
    replicationFields: {} as Record<string, string>,
    memoryFields: {} as Record<string, string>,
    clientFields: {} as Record<string, string>,
    keyspaceLines: [] as string[],
  };
  const readFields = (lines: string[], into: Record<string, string>) => {
    for (const ln of lines) {
      // Split on the first ':' only — values can contain colons.
      const i = ln.indexOf(':');
      if (i > 0) into[ln.slice(0, i).trim()] = ln.slice(i + 1).trim();
    }
  };
  for (const sec of sections) {
    const [headerLine, ...rest] = sec.split(/\r?\n/);
    // INFO starts with "# Server" — the first section keeps its "#"
    // because the split only consumes "#" after a newline.
    const header = (headerLine ?? '').replace(/^#\s*/, '').trim().toLowerCase();
    const lines = rest.filter((l) => l && !l.startsWith('#'));
    if (header.startsWith('server')) readFields(lines, out.serverFields);
    else if (header.startsWith('replication')) readFields(lines, out.replicationFields);
    else if (header.startsWith('memory')) readFields(lines, out.memoryFields);
    else if (header.startsWith('clients')) readFields(lines, out.clientFields);
    else if (header.startsWith('keyspace')) out.keyspaceLines.push(...lines);
  }
  return out;
}

export function parseKeyspaceSection(
  lines: string[],
): { db: number; keys: number; expires: number }[] {
  const out: { db: number; keys: number; expires: number }[] = [];
  for (const line of lines) {
    // line looks like: db0:keys=3,expires=0,avg_ttl=0
    const m = line.match(/^db(\d+):keys=(\d+),expires=(\d+)/);
    if (m) out.push({ db: Number(m[1]), keys: Number(m[2]), expires: Number(m[3]) });
  }
  return out;
}

function tlsFor(config: ConnectionConfig) {
  const tls = buildNodeTlsOptions(config);
  if (resolveTls(config)?.mode === 'insecure') console.warn(insecureTlsWarning(config.host));
  return tls;
}

/**
 * ioredis options for one connection. Shared by the per-db clients, the
 * subscriber and the blocking connection so they share auth + TLS.
 */
export function buildClientOptions(
  config: ConnectionConfig,
  endpoint: RedisEndpoint,
  db: number,
): RedisOptions {
  const base: RedisOptions = {
    password: config.password || undefined,
    username: config.user || undefined,
    db,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 10_000,
    enableReadyCheck: true,
  };
  const tls = tlsFor(config);
  switch (endpoint.kind) {
    case 'socket':
      return { ...base, path: endpoint.path };
    case 'sentinel':
      return {
        ...base,
        sentinels: endpoint.sentinels,
        name: endpoint.name,
        sentinelUsername: endpoint.sentinelUsername,
        sentinelPassword: endpoint.sentinelPassword,
        tls,
        enableTLSForSentinelMode: Boolean(tls),
        sentinelTLS: tls,
      };
    case 'cluster':
    case 'tcp':
      return {
        ...base,
        host: endpoint.kind === 'tcp' ? endpoint.host : endpoint.nodes[0]!.host,
        port: endpoint.kind === 'tcp' ? endpoint.port : endpoint.nodes[0]!.port,
        tls,
      };
  }
}

async function openClient(
  config: ConnectionConfig,
  endpoint: RedisEndpoint,
  db: number,
  extra: Partial<RedisOptions> = {},
): Promise<RedisClient> {
  const client = new Redis({ ...buildClientOptions(config, endpoint, db), ...extra });
  // ioredis emits 'error' before .connect() rejects; swallow them so we
  // don't crash the worker. The reject from .connect() is enough.
  client.on('error', () => {});
  try {
    await client.connect();
  } catch (err) {
    client.disconnect();
    throw err;
  }
  return client;
}

function clusterSeeds(endpoint: RedisEndpoint): { host: string; port: number }[] {
  if (endpoint.kind === 'cluster') return endpoint.nodes;
  if (endpoint.kind === 'tcp') return [{ host: endpoint.host, port: endpoint.port }];
  throw new Error('not a cluster endpoint');
}

function clusterOptions(config: ConnectionConfig): ClusterOptions {
  const tls = tlsFor(config);
  return {
    lazyConnect: true,
    enableReadyCheck: true,
    slotsRefreshTimeout: 5_000,
    clusterRetryStrategy: (times) => (times > 2 ? null : 200),
    redisOptions: {
      password: config.password || undefined,
      username: config.user || undefined,
      tls,
      maxRetriesPerRequest: 1,
      connectTimeout: 10_000,
    },
    ...(tls ? { dnsLookup: (address, callback) => callback(null, address) } : {}),
  };
}

async function openCluster(
  config: ConnectionConfig,
  nodes: { host: string; port: number }[],
): Promise<Cluster> {
  const cluster = new Cluster(nodes, clusterOptions(config));
  cluster.on('error', () => {});
  try {
    await cluster.connect();
  } catch (err) {
    cluster.disconnect();
    throw err;
  }
  return cluster;
}

function toInt(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}
