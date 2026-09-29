/**
 * Redis command safety policy — shared by the redis-cli view (confirmation
 * + edit-mode gating), the worker driver (read-only guard, routing of
 * blocking / subscriber-mode commands) and main (retry policy).
 *
 * The classification is deliberately conservative: anything not known
 * to be read-only is treated as a write, and anything that changes the
 * state of the *connection* (SUBSCRIBE, MONITOR, MULTI, HELLO, AUTH …)
 * is refused because the CLI shares its connection with the rest of the
 * Redis views.
 */

export type RedisCommandAccess = 'read' | 'write';
export type RedisCommandRisk = 'normal' | 'expensive' | 'destructive';
/**
 * How the command must be executed:
 *  - `shared`   — normal request on the shared per-db client
 *  - `blocking` — can block the connection; runs on a dedicated,
 *                 short-lived connection with a deadline
 *  - `select`   — `SELECT n`; handled as a database switch by the caller
 *  - `refuse`   — never sent (subscriber / monitor / connection state)
 */
export type RedisCommandMode = 'shared' | 'blocking' | 'select' | 'refuse';

export interface RedisCommandVerdict {
  /** Upper-cased verb, including the sub-command for container verbs ("CONFIG SET"). */
  verb: string;
  access: RedisCommandAccess;
  risk: RedisCommandRisk;
  mode: RedisCommandMode;
  /** Why the command is refused / needs confirmation — shown to the user. */
  reason?: string;
}

const READ_COMMANDS = new Set([
  // strings / generic
  'GET',
  'MGET',
  'GETRANGE',
  'SUBSTR',
  'STRLEN',
  'EXISTS',
  'TYPE',
  'TTL',
  'PTTL',
  'EXPIRETIME',
  'PEXPIRETIME',
  'DUMP',
  'RANDOMKEY',
  'KEYS',
  'SCAN',
  'DBSIZE',
  'LCS',
  'TOUCH',
  'SORT_RO',
  // bitmaps / hll
  'BITCOUNT',
  'BITPOS',
  'GETBIT',
  'BITFIELD_RO',
  'PFCOUNT',
  // hashes
  'HGET',
  'HMGET',
  'HGETALL',
  'HKEYS',
  'HVALS',
  'HLEN',
  'HEXISTS',
  'HSTRLEN',
  'HSCAN',
  'HRANDFIELD',
  'HTTL',
  'HPTTL',
  'HEXPIRETIME',
  'HPEXPIRETIME',
  // lists
  'LRANGE',
  'LLEN',
  'LINDEX',
  'LPOS',
  // sets
  'SMEMBERS',
  'SCARD',
  'SISMEMBER',
  'SMISMEMBER',
  'SRANDMEMBER',
  'SSCAN',
  'SINTER',
  'SUNION',
  'SDIFF',
  'SINTERCARD',
  // sorted sets
  'ZRANGE',
  'ZRANGEBYSCORE',
  'ZRANGEBYLEX',
  'ZREVRANGE',
  'ZREVRANGEBYSCORE',
  'ZREVRANGEBYLEX',
  'ZSCORE',
  'ZMSCORE',
  'ZCARD',
  'ZCOUNT',
  'ZLEXCOUNT',
  'ZRANK',
  'ZREVRANK',
  'ZSCAN',
  'ZRANDMEMBER',
  'ZINTER',
  'ZUNION',
  'ZDIFF',
  'ZINTERCARD',
  // streams
  'XLEN',
  'XRANGE',
  'XREVRANGE',
  'XREAD',
  'XPENDING',
  // geo
  'GEOPOS',
  'GEODIST',
  'GEOHASH',
  'GEORADIUS_RO',
  'GEORADIUSBYMEMBER_RO',
  'GEOSEARCH',
  // server / introspection
  'INFO',
  'PING',
  'ECHO',
  'TIME',
  'LASTSAVE',
  'ROLE',
  'READONLY',
  'READWRITE',
  'EVAL_RO',
  'EVALSHA_RO',
  'FCALL_RO',
  // modules (read verbs)
  'JSON.GET',
  'JSON.MGET',
  'JSON.TYPE',
  'JSON.STRLEN',
  'JSON.ARRLEN',
  'JSON.ARRINDEX',
  'JSON.OBJKEYS',
  'JSON.OBJLEN',
  'JSON.RESP',
  'JSON.DEBUG',
  'FT.SEARCH',
  'FT.INFO',
  'FT._LIST',
  'FT.AGGREGATE',
  'FT.EXPLAIN',
  'FT.PROFILE',
  'TS.GET',
  'TS.RANGE',
  'TS.REVRANGE',
  'TS.MGET',
  'TS.MRANGE',
  'TS.MREVRANGE',
  'TS.INFO',
  'TS.QUERYINDEX',
  'BF.EXISTS',
  'BF.MEXISTS',
  'BF.INFO',
  'BF.CARD',
  'CF.EXISTS',
  'CF.MEXISTS',
  'CF.INFO',
  'CF.COUNT',
  'CMS.QUERY',
  'CMS.INFO',
  'TOPK.QUERY',
  'TOPK.LIST',
  'TOPK.INFO',
]);

/**
 * Container verbs whose read-ness depends on the sub-command. A sub-command
 * missing from the set is a write.
 */
const READ_SUBCOMMANDS = new Map<string, Set<string>>([
  ['OBJECT', new Set(['ENCODING', 'IDLETIME', 'FREQ', 'REFCOUNT', 'HELP'])],
  ['MEMORY', new Set(['USAGE', 'STATS', 'DOCTOR', 'MALLOC-STATS', 'HELP'])],
  ['CONFIG', new Set(['GET', 'HELP'])],
  ['CLIENT', new Set(['LIST', 'INFO', 'GETNAME', 'ID', 'HELP', 'GETREDIR', 'TRACKINGINFO'])],
  ['SLOWLOG', new Set(['GET', 'LEN', 'HELP'])],
  ['LATENCY', new Set(['LATEST', 'HISTORY', 'DOCTOR', 'GRAPH', 'HISTOGRAM', 'HELP'])],
  ['PUBSUB', new Set(['CHANNELS', 'NUMSUB', 'NUMPAT', 'SHARDCHANNELS', 'SHARDNUMSUB', 'HELP'])],
  [
    'CLUSTER',
    new Set([
      'INFO',
      'NODES',
      'SLOTS',
      'SHARDS',
      'KEYSLOT',
      'COUNTKEYSINSLOT',
      'GETKEYSINSLOT',
      'MYID',
      'MYSHARDID',
      'LINKS',
      'REPLICAS',
      'SLAVES',
      'COUNT-FAILURE-REPORTS',
      'HELP',
    ]),
  ],
  ['ACL', new Set(['WHOAMI', 'LIST', 'USERS', 'CAT', 'GETUSER', 'LOG', 'DRYRUN', 'HELP'])],
  ['SCRIPT', new Set(['EXISTS', 'HELP'])],
  ['FUNCTION', new Set(['LIST', 'STATS', 'DUMP', 'HELP'])],
  ['MODULE', new Set(['LIST', 'HELP'])],
  ['XINFO', new Set(['STREAM', 'GROUPS', 'CONSUMERS', 'HELP'])],
  ['COMMAND', new Set(['', 'COUNT', 'DOCS', 'GETKEYS', 'GETKEYSANDFLAGS', 'INFO', 'LIST', 'HELP'])],
]);

/** Commands that put the connection into a mode where normal commands fail. */
const SUBSCRIBER_VERBS = new Set(['SUBSCRIBE', 'PSUBSCRIBE', 'SSUBSCRIBE', 'MONITOR']);

/** Commands that change connection state shared with every other view. */
const CONNECTION_STATE_VERBS: Record<string, string> = {
  MULTI:
    "Transactions would queue every other view's commands on the shared connection — use EVAL for atomic scripts.",
  EXEC: 'Transactions are not supported in the CLI.',
  DISCARD: 'Transactions are not supported in the CLI.',
  WATCH: 'WATCH is not supported on the shared connection.',
  UNWATCH: 'WATCH is not supported on the shared connection.',
  HELLO: 'HELLO switches the protocol of the shared connection; Plasma speaks RESP2.',
  AUTH: 'AUTH would change the user of the shared connection — edit the connection instead.',
  RESET: 'RESET would reset the shared connection.',
  QUIT: 'QUIT would close the shared connection — use Disconnect instead.',
  UNSUBSCRIBE: 'The CLI never subscribes — use the Pub/sub view.',
  PUNSUBSCRIBE: 'The CLI never subscribes — use the Pub/sub view.',
  SUNSUBSCRIBE: 'The CLI never subscribes — use the Pub/sub view.',
};

const BLOCKING_VERBS = new Set([
  'BLPOP',
  'BRPOP',
  'BRPOPLPUSH',
  'BLMOVE',
  'BLMPOP',
  'BZPOPMIN',
  'BZPOPMAX',
  'BZMPOP',
  'WAIT',
  'WAITAOF',
]);

/** Always confirm, whatever the connection tag. */
const DESTRUCTIVE: Record<string, string> = {
  FLUSHALL: 'Deletes every key in every database.',
  FLUSHDB: 'Deletes every key in the current database.',
  SHUTDOWN: 'Stops the Redis server.',
  DEBUG: 'DEBUG can crash, block or corrupt the server.',
  'CONFIG SET': 'Changes the live server configuration.',
  'CONFIG RESETSTAT': 'Resets server statistics.',
  'CONFIG REWRITE': 'Rewrites redis.conf on the server.',
  'SCRIPT FLUSH': 'Removes every cached Lua script.',
  'SCRIPT KILL': 'Kills the running Lua script.',
  'FUNCTION FLUSH': 'Deletes every function library.',
  'FUNCTION DELETE': 'Deletes a function library.',
  'FUNCTION RESTORE': 'Replaces function libraries.',
  'FUNCTION KILL': 'Kills the running function.',
  'CLIENT KILL': 'Disconnects clients.',
  'CLIENT PAUSE': 'Pauses all clients.',
  'CLIENT NO-EVICT': 'Changes client eviction.',
  SLAVEOF: 'Changes replication — the server may drop its data.',
  REPLICAOF: 'Changes replication — the server may drop its data.',
  FAILOVER: 'Starts a failover.',
  'CLUSTER RESET': 'Resets the cluster node.',
  'CLUSTER FAILOVER': 'Starts a cluster failover.',
  'CLUSTER FORGET': 'Removes a node from the cluster.',
  'CLUSTER FLUSHSLOTS': 'Drops slot ownership.',
  'CLUSTER DELSLOTS': 'Drops slot ownership.',
  'CLUSTER DELSLOTSRANGE': 'Drops slot ownership.',
  'CLUSTER SETSLOT': 'Changes slot ownership.',
  'ACL SETUSER': 'Changes users and permissions.',
  'ACL DELUSER': 'Deletes users.',
  'ACL LOAD': 'Reloads users from the ACL file.',
  'ACL SAVE': 'Rewrites the ACL file.',
  'ACL LOG': 'Resets the ACL log.',
  MIGRATE: 'Moves keys to another server.',
  SWAPDB: 'Swaps two whole databases.',
  'SLOWLOG RESET': 'Clears the slow log.',
  'LATENCY RESET': 'Clears latency samples.',
  'MEMORY PURGE': 'Asks the allocator to release memory.',
  SAVE: 'SAVE blocks the whole server while it writes the RDB file.',
  BGSAVE: 'Forks the server to write an RDB file.',
  BGREWRITEAOF: 'Forks the server to rewrite the AOF.',
  'MODULE LOAD': 'Loads a server module.',
  'MODULE LOADEX': 'Loads a server module.',
  'MODULE UNLOAD': 'Unloads a server module.',
};

/** Glob metacharacters: DEL/UNLINK do NOT expand patterns — a common mistake. */
const GLOB_RE = /[*?[\]]/;

/**
 * Classify one tokenized redis-cli command.
 */
export function classifyRedisCommand(parts: readonly string[]): RedisCommandVerdict {
  const head = (parts[0] ?? '').toUpperCase();
  const sub = (parts[1] ?? '').toUpperCase();
  const container = READ_SUBCOMMANDS.get(head);
  const verb = container || DESTRUCTIVE[`${head} ${sub}`] ? `${head} ${sub}`.trim() : head;

  if (!head) {
    return { verb: '', access: 'read', risk: 'normal', mode: 'refuse', reason: 'Empty command.' };
  }
  if (SUBSCRIBER_VERBS.has(head)) {
    return {
      verb,
      access: 'read',
      risk: 'normal',
      mode: 'refuse',
      reason:
        head === 'MONITOR'
          ? 'MONITOR would take over the shared connection. Use Slowlog, or run redis-cli MONITOR in a terminal.'
          : `${head} would turn the shared connection into a subscriber. Open the Pub/sub view instead (sidebar tools → Pub/sub subscribe…).`,
    };
  }
  if (
    head === 'CLIENT' &&
    (sub === 'REPLY' || sub === 'TRACKING' || sub === 'SETNAME' || sub === 'SETINFO')
  ) {
    return {
      verb,
      access: 'write',
      risk: 'normal',
      mode: 'refuse',
      reason: `CLIENT ${sub} changes the shared connection used by every Redis view.`,
    };
  }
  const stateReason = CONNECTION_STATE_VERBS[head];
  if (stateReason) {
    return { verb, access: 'write', risk: 'normal', mode: 'refuse', reason: stateReason };
  }
  if (head === 'SELECT') {
    return { verb, access: 'read', risk: 'normal', mode: 'select' };
  }

  // Access.
  let access: RedisCommandAccess;
  if (container) {
    access = container.has(sub) ? 'read' : 'write';
  } else {
    access = READ_COMMANDS.has(head) ? 'read' : 'write';
  }

  // Mode.
  let mode: RedisCommandMode = 'shared';
  if (BLOCKING_VERBS.has(head)) mode = 'blocking';
  if (
    (head === 'XREAD' || head === 'XREADGROUP') &&
    parts.some((p) => p.toUpperCase() === 'BLOCK')
  ) {
    mode = 'blocking';
  }

  // Risk.
  const destructive = DESTRUCTIVE[verb] ?? DESTRUCTIVE[head];
  if (destructive) {
    // ACL LOG is only destructive with RESET.
    if (verb === 'ACL LOG' && (parts[2] ?? '').toUpperCase() !== 'RESET') {
      return { verb, access: 'read', risk: 'normal', mode };
    }
    return { verb, access: 'write', risk: 'destructive', mode, reason: destructive };
  }
  if (head === 'DEL' || head === 'UNLINK') {
    const keys = parts.slice(1);
    if (keys.some((k) => GLOB_RE.test(k))) {
      return {
        verb,
        access,
        risk: 'destructive',
        mode,
        reason: `${head} does not expand patterns — it deletes keys literally named ${keys
          .filter((k) => GLOB_RE.test(k))
          .join(', ')}. Use "Delete keys matching…" in the sidebar to delete by pattern.`,
      };
    }
    if (keys.length > 1) {
      return { verb, access, risk: 'destructive', mode, reason: `Deletes ${keys.length} keys.` };
    }
  }
  if (head === 'RESTORE' && parts.some((p) => p.toUpperCase() === 'REPLACE')) {
    return {
      verb,
      access,
      risk: 'destructive',
      mode,
      reason: 'RESTORE … REPLACE overwrites the key.',
    };
  }
  if (head === 'KEYS') {
    return {
      verb,
      access,
      risk: 'expensive',
      mode,
      reason:
        'KEYS walks the whole keyspace in one call and blocks the server on large databases. Prefer SCAN.',
    };
  }
  return { verb, access, risk: 'normal', mode };
}

/** True when the command never mutates data (safe to auto-retry, allowed on read-only connections). */
export function isRedisReadCommand(parts: readonly string[]): boolean {
  const v = classifyRedisCommand(parts);
  return v.access === 'read' && v.mode !== 'refuse';
}

/**
 * Whether the CLI must ask before sending. Destructive and expensive
 * commands always ask; on prod-tagged connections every write asks.
 */
export function redisCommandNeedsConfirm(v: RedisCommandVerdict, prod: boolean): boolean {
  if (v.mode === 'refuse' || v.mode === 'select') return false;
  if (v.risk === 'destructive' || v.risk === 'expensive') return true;
  return prod && v.access === 'write';
}

/**
 * redis-cli compatible tokenizer: whitespace separated, double quotes with
 * backslash escapes (\n \r \t \b \a \" \\ \xHH), single quotes with only
 * \' escaped, and "" / '' produce an empty argument. Returns null on an
 * unbalanced quote.
 */
export function tokenizeRedisCommand(input: string): string[] | null {
  const out: string[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    while (i < n && /\s/.test(input[i]!)) i++;
    if (i >= n) break;
    let buf = '';
    let started = false;
    while (i < n && !/\s/.test(input[i]!)) {
      const ch = input[i]!;
      if (ch === '"') {
        started = true;
        i++;
        let closed = false;
        while (i < n) {
          const c = input[i]!;
          if (c === '\\' && i + 1 < n) {
            const e = input[i + 1]!;
            if (e === 'x' && /^[0-9a-fA-F]{2}$/.test(input.slice(i + 2, i + 4))) {
              buf += String.fromCharCode(Number.parseInt(input.slice(i + 2, i + 4), 16));
              i += 4;
              continue;
            }
            const map: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', a: '\x07' };
            buf += map[e] ?? e;
            i += 2;
            continue;
          }
          if (c === '"') {
            closed = true;
            i++;
            break;
          }
          buf += c;
          i++;
        }
        if (!closed) return null;
        continue;
      }
      if (ch === "'") {
        started = true;
        i++;
        let closed = false;
        while (i < n) {
          const c = input[i]!;
          if (c === '\\' && input[i + 1] === "'") {
            buf += "'";
            i += 2;
            continue;
          }
          if (c === "'") {
            closed = true;
            i++;
            break;
          }
          buf += c;
          i++;
        }
        if (!closed) return null;
        continue;
      }
      buf += ch;
      started = true;
      i++;
    }
    if (started) out.push(buf);
  }
  return out;
}
