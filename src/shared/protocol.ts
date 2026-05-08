import { z } from 'zod';

/**
 * IPC protocol — the single source of truth for the shape of messages
 * flowing between renderer, main, and DB worker processes.
 *
 * Every IPC call is typed via Zod so the renderer cannot accidentally
 * send garbage to main and main cannot accidentally return the wrong
 * shape to the renderer.
 */

// ─── Platform + app meta ─────────────────────────────────────────────

export type Platform = 'darwin' | 'win32' | 'linux';

export const AppMeta = z.object({
  name: z.literal('plasma'),
  version: z.string(),
  platform: z.enum(['darwin', 'win32', 'linux']),
  electron: z.string(),
  node: z.string(),
});
export type AppMeta = z.infer<typeof AppMeta>;

// ─── Connection config ───────────────────────────────────────────────

/**
 * Storage engine. New rows default to 'postgres' (Plasma was Postgres-only
 * through v0.0.10). Adding redis/opensearch as discriminated variants
 * inside the same vault row keeps SQLite migrations small — only the
 * `engine` column is new.
 *
 * Field reuse across engines (kept this way for vault simplicity):
 *   - postgres   : host, port, database, user, password, ssl
 *   - redis      : host, port, password (user optional ACL),
 *                  database = numeric DB index as string ('0'),
 *                  ssl = TLS toggle, user = '' or ACL username
 *   - opensearch : host, port (9200/443), user, password (basic auth),
 *                  database = unused (kept ''), ssl = use HTTPS
 */
export const ConnectionEngine = z.enum(['postgres', 'redis', 'opensearch']);
export type ConnectionEngine = z.infer<typeof ConnectionEngine>;

export const ConnectionConfig = z.object({
  id: z.string(),
  name: z.string().min(1),
  engine: ConnectionEngine.default('postgres'),
  host: z.string().min(1),
  port: z.number().int().positive().max(65535),
  /** Postgres DB name; Redis db number ('0'); unused for OpenSearch. */
  database: z.string().default(''),
  /** Optional for Redis (no ACL username). */
  user: z.string().default(''),
  password: z.string(),
  /** Postgres SSL / Redis TLS / OpenSearch HTTPS. */
  ssl: z.boolean().default(false),
});
export type ConnectionConfig = z.infer<typeof ConnectionConfig>;

export const SavedConnection = ConnectionConfig.omit({ password: true });
export type SavedConnection = z.infer<typeof SavedConnection>;

export const ConnectionInfo = z.object({
  serverVersion: z.string(),
  engine: ConnectionEngine.default('postgres'),
});
export type ConnectionInfo = z.infer<typeof ConnectionInfo>;

export const ConnectionTestResult = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    serverVersion: z.string(),
    engine: ConnectionEngine.default('postgres'),
  }),
  z.object({ ok: z.literal(false), message: z.string() }),
]);
export type ConnectionTestResult = z.infer<typeof ConnectionTestResult>;

// ─── Redis types ─────────────────────────────────────────────────────

/**
 * Redis value types we know how to render. `unknown` covers stream /
 * geo / bitfield etc. — the renderer falls back to a JSON dump there.
 */
export const RedisValueType = z.enum([
  'string',
  'list',
  'set',
  'zset',
  'hash',
  'stream',
  'json',
  'none',
  'unknown',
]);
export type RedisValueType = z.infer<typeof RedisValueType>;

export const RedisKeyMeta = z.object({
  key: z.string(),
  type: RedisValueType,
  ttlMs: z.number().int().nullable(),
  sizeBytes: z.number().int().nullable(),
});
export type RedisKeyMeta = z.infer<typeof RedisKeyMeta>;

export const RedisScanResult = z.object({
  cursor: z.string(),
  keys: z.array(RedisKeyMeta),
  scanned: z.number().int(),
});
export type RedisScanResult = z.infer<typeof RedisScanResult>;

export const RedisKeyValue = z.object({
  key: z.string(),
  type: RedisValueType,
  ttlMs: z.number().int().nullable(),
  encoding: z.string().optional(),
  /**
   * Engine-shape payload, all serialized for IPC.
   *  - string  → string
   *  - list    → string[]
   *  - set     → string[]
   *  - zset    → [member, score][]
   *  - hash    → [field, value][]
   *  - stream  → { id, fields: [name, value][] }[]
   *  - json    → any (already parsed by RedisJSON.GET)
   *  - none    → null
   */
  value: z.unknown(),
});
export type RedisKeyValue = z.infer<typeof RedisKeyValue>;

export const RedisCommandResult = z.object({
  command: z.string(),
  args: z.array(z.string()),
  /** Pretty-printed reply — flattened so the renderer doesn't reimplement RESP. */
  reply: z.unknown(),
  durationMs: z.number(),
});
export type RedisCommandResult = z.infer<typeof RedisCommandResult>;

export const RedisOverview = z.object({
  redisVersion: z.string(),
  mode: z.string(),
  role: z.string(),
  dbCount: z.number().int(),
  /** Per-db key counts seeded from `INFO keyspace`. */
  keyspace: z.array(
    z.object({
      db: z.number().int(),
      keys: z.number().int(),
      expires: z.number().int(),
    }),
  ),
});
export type RedisOverview = z.infer<typeof RedisOverview>;

// ─── Redis advanced ──────────────────────────────────────────────────

/** Single sample row in a memory analyzer scan. */
export const RedisAnalyzeSample = z.object({
  key: z.string(),
  type: RedisValueType,
  bytes: z.number().int(),
  ttlMs: z.number().int().nullable(),
});
export type RedisAnalyzeSample = z.infer<typeof RedisAnalyzeSample>;

export const RedisAnalyzeResult = z.object({
  /** Total keys SCANned + sized. May be < cluster total when cap hit. */
  scanned: z.number().int(),
  /** Sum of MEMORY USAGE over the sample. */
  totalBytes: z.number().int(),
  /** All sampled keys with size + type, sorted descending by bytes. */
  samples: z.array(RedisAnalyzeSample),
  /** Aggregate: count + bytes per Redis value type. */
  byType: z.array(
    z.object({
      type: RedisValueType,
      count: z.number().int(),
      bytes: z.number().int(),
    }),
  ),
  /** Aggregate: count + bytes per top-level `:`-namespace prefix. */
  byPrefix: z.array(
    z.object({
      prefix: z.string(),
      count: z.number().int(),
      bytes: z.number().int(),
    }),
  ),
});
export type RedisAnalyzeResult = z.infer<typeof RedisAnalyzeResult>;

export const RedisSlowlogEntry = z.object({
  id: z.number().int(),
  /** Unix seconds when the command started. */
  timestamp: z.number().int(),
  /** Duration in microseconds (Redis returns µs natively). */
  durationUs: z.number().int(),
  argv: z.array(z.string()),
  client: z.string().nullable(),
  clientName: z.string().nullable(),
});
export type RedisSlowlogEntry = z.infer<typeof RedisSlowlogEntry>;

export const RedisPubsubMessage = z.object({
  channel: z.string(),
  message: z.string(),
  /** True for PSUBSCRIBE matches; false for direct SUBSCRIBE. */
  pattern: z.boolean(),
  timestamp: z.number(),
});
export type RedisPubsubMessage = z.infer<typeof RedisPubsubMessage>;

/**
 * Engine-shape-aware write payload for inline-edit forms. The renderer
 * always sends one of these; the worker dispatches by the `kind` field.
 *
 * No DEL here — that's `redisDeleteKey` (already shipped).
 */
export const RedisWriteOp = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('setString'),
    key: z.string(),
    value: z.string(),
    /** Optional TTL in seconds; 0 / undefined keeps existing TTL semantics. */
    ttlSeconds: z.number().int().optional(),
  }),
  z.object({ kind: z.literal('hashSet'), key: z.string(), field: z.string(), value: z.string() }),
  z.object({ kind: z.literal('hashDel'), key: z.string(), field: z.string() }),
  z.object({
    kind: z.literal('listPush'),
    key: z.string(),
    side: z.enum(['l', 'r']),
    values: z.array(z.string()).min(1),
  }),
  z.object({
    kind: z.literal('listSet'),
    key: z.string(),
    index: z.number().int(),
    value: z.string(),
  }),
  z.object({ kind: z.literal('setAdd'), key: z.string(), members: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal('setRem'), key: z.string(), member: z.string() }),
  z.object({
    kind: z.literal('zsetAdd'),
    key: z.string(),
    member: z.string(),
    score: z.number(),
  }),
  z.object({ kind: z.literal('zsetRem'), key: z.string(), member: z.string() }),
]);
export type RedisWriteOp = z.infer<typeof RedisWriteOp>;

// ─── OpenSearch types ────────────────────────────────────────────────

export const OsIndex = z.object({
  index: z.string(),
  health: z.string(),
  status: z.string(),
  uuid: z.string().nullable(),
  primaries: z.number().int(),
  replicas: z.number().int(),
  docsCount: z.number().int(),
  docsDeleted: z.number().int(),
  storeBytes: z.number().int(),
});
export type OsIndex = z.infer<typeof OsIndex>;

export const OsOverview = z.object({
  clusterName: z.string(),
  distribution: z.string(),
  version: z.string(),
  health: z.string(),
  nodes: z.number().int(),
  indices: z.array(OsIndex),
});
export type OsOverview = z.infer<typeof OsOverview>;

export const OsHit = z.object({
  index: z.string(),
  id: z.string(),
  score: z.number().nullable(),
  source: z.unknown(),
});
export type OsHit = z.infer<typeof OsHit>;

export const OsSearchResult = z.object({
  total: z.number().int(),
  took: z.number().int(),
  hits: z.array(OsHit),
  aggregations: z.unknown().nullable(),
  /** Raw `_source` field names found in this batch — drives the column picker. */
  fields: z.array(z.string()),
});
export type OsSearchResult = z.infer<typeof OsSearchResult>;

export type OsMappingNode = {
  name: string;
  type: string | null;
  children: OsMappingNode[];
};
export const OsMappingNode: z.ZodType<OsMappingNode> = z.lazy(() =>
  z.object({
    name: z.string(),
    type: z.string().nullable(),
    children: z.array(OsMappingNode),
  }),
);

// ─── OpenSearch advanced ─────────────────────────────────────────────

export const OsAlias = z.object({
  alias: z.string(),
  index: z.string(),
  filter: z.string().nullable(),
  isWriteIndex: z.boolean(),
});
export type OsAlias = z.infer<typeof OsAlias>;

export const OsIlmPolicy = z.object({
  name: z.string(),
  /** Raw policy JSON document. The renderer renders it as a tree; we
   *  don't parse phases here because every distribution shapes them
   *  slightly differently (ISM vs ILM vs hot/warm/cold). */
  policy: z.unknown(),
  lastUpdated: z.number().nullable(),
});
export type OsIlmPolicy = z.infer<typeof OsIlmPolicy>;

/**
 * Result of running a query through the OpenSearch SQL plugin
 * (`/_plugins/_sql` on OpenSearch 1.x+, `/_sql` on Elasticsearch 7.x+).
 * Shape mirrors a relational result set so the renderer can reuse the
 * existing grid components.
 */
export const OsSqlResult = z.object({
  columns: z.array(z.object({ name: z.string(), type: z.string() })),
  rows: z.array(z.array(z.unknown())),
  total: z.number().int(),
  /** Server-reported execution time when available; otherwise client-side. */
  durationMs: z.number(),
});
export type OsSqlResult = z.infer<typeof OsSqlResult>;

/**
 * Per-field statistics used by the Discover canvas to surface
 * cardinality, top values, and (for time fields) min/max bounds. The
 * renderer asks for these one field at a time so a wide mapping doesn't
 * trigger a fan-out of agg requests on connect.
 */
export const OsFieldStats = z.object({
  field: z.string(),
  type: z.string().nullable(),
  /** Distinct value count via cardinality agg (approximate). */
  cardinality: z.number().int().nullable(),
  /** Top values + counts via terms agg (capped at 10). */
  topValues: z.array(z.object({ value: z.string(), count: z.number().int() })),
  /** True when the field is a date / date_nanos type — drives time-picker UI. */
  isTime: z.boolean(),
});
export type OsFieldStats = z.infer<typeof OsFieldStats>;

// ─── Query + results ─────────────────────────────────────────────────

export const ColumnMeta = z.object({
  name: z.string(),
  dataTypeID: z.number().int(),
  dataTypeName: z.string(),
});
export type ColumnMeta = z.infer<typeof ColumnMeta>;

export const QueryResult = z.object({
  columns: z.array(ColumnMeta),
  rows: z.array(z.array(z.unknown())),
  rowCount: z.number().int(),
  durationMs: z.number(),
  command: z.string().optional(),
});
export type QueryResult = z.infer<typeof QueryResult>;

// ─── Schema introspection ────────────────────────────────────────────

export const SchemaInfo = z.object({
  schemas: z.array(z.object({ name: z.string() })),
  tables: z.array(
    z.object({
      schema: z.string(),
      name: z.string(),
      kind: z.enum(['table', 'view', 'matview', 'foreign', 'partitioned']),
      rowCountEstimate: z.number().nullable(),
    }),
  ),
  columns: z.array(
    z.object({
      schema: z.string(),
      table: z.string(),
      name: z.string(),
      dataType: z.string(),
      ordinal: z.number().int(),
      isPrimaryKey: z.boolean().default(false),
      isNullable: z.boolean().default(true),
      hasDefault: z.boolean().default(false),
    }),
  ),
  /**
   * Foreign keys declared on introspected tables. One row per FK column
   * (a composite FK with two columns yields two rows sharing a constraint
   * name). Populated best-effort — old drivers may omit this field.
   */
  foreignKeys: z
    .array(
      z.object({
        schema: z.string(),
        table: z.string(),
        column: z.string(),
        refSchema: z.string(),
        refTable: z.string(),
        refColumn: z.string(),
      }),
    )
    .default([]),
});
export type SchemaInfo = z.infer<typeof SchemaInfo>;

// ─── Query history ───────────────────────────────────────────────────

export const HistoryEntry = z.object({
  id: z.number().int(),
  connectionId: z.string().nullable(),
  sql: z.string(),
  rowCount: z.number().int().nullable(),
  durationMs: z.number().nullable(),
  error: z.string().nullable(),
  executedAt: z.number(),
});
export type HistoryEntry = z.infer<typeof HistoryEntry>;

// ─── Transaction state ───────────────────────────────────────────────

export const TxnState = z.enum(['none', 'active', 'error']);
export type TxnState = z.infer<typeof TxnState>;

// ─── Worker messages (main ↔ utilityProcess) ────────────────────────

export const WorkerRequest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ping'), id: z.string(), message: z.string() }),
  z.object({ kind: z.literal('connect'), id: z.string(), config: ConnectionConfig }),
  z.object({ kind: z.literal('disconnect'), id: z.string() }),
  z.object({
    kind: z.literal('query'),
    id: z.string(),
    sql: z.string(),
    params: z.array(z.unknown()).optional(),
  }),
  z.object({ kind: z.literal('cancel'), id: z.string() }),
  z.object({ kind: z.literal('introspect'), id: z.string() }),
  z.object({ kind: z.literal('beginTxn'), id: z.string() }),
  z.object({ kind: z.literal('commitTxn'), id: z.string() }),
  z.object({ kind: z.literal('rollbackTxn'), id: z.string() }),
  // Sideband query — runs on the second connection so it doesn't queue
  // behind a long-running query on `primary`. Used for live monitor +
  // pg_terminate_backend calls.
  z.object({
    kind: z.literal('sidebandQuery'),
    id: z.string(),
    sql: z.string(),
    params: z.array(z.unknown()).optional(),
  }),
  // ── Redis ops ──
  z.object({
    kind: z.literal('redisScan'),
    id: z.string(),
    cursor: z.string().default('0'),
    match: z.string().optional(),
    count: z.number().int().positive().max(10000).default(500),
    db: z.number().int().nonnegative().optional(),
  }),
  z.object({ kind: z.literal('redisGetKey'), id: z.string(), key: z.string() }),
  z.object({
    kind: z.literal('redisDeleteKey'),
    id: z.string(),
    key: z.string(),
  }),
  z.object({
    kind: z.literal('redisSetTtl'),
    id: z.string(),
    key: z.string(),
    /** TTL in seconds. Pass 0 or negative to PERSIST (clear TTL). */
    seconds: z.number().int(),
  }),
  z.object({
    kind: z.literal('redisCommand'),
    id: z.string(),
    /** Already-tokenized command; the renderer splits by whitespace. */
    parts: z.array(z.string()).min(1),
  }),
  z.object({ kind: z.literal('redisOverview'), id: z.string() }),
  z.object({
    kind: z.literal('redisAnalyze'),
    id: z.string(),
    /** SCAN cap. Default 5000 — enough to surface pareto winners without
     *  hammering production. */
    sampleCap: z.number().int().positive().max(50000).default(5000),
    match: z.string().optional(),
  }),
  z.object({
    kind: z.literal('redisSlowlog'),
    id: z.string(),
    limit: z.number().int().positive().max(500).default(64),
  }),
  z.object({
    kind: z.literal('redisBulkDelete'),
    id: z.string(),
    keys: z.array(z.string()).min(1).max(10000),
  }),
  z.object({ kind: z.literal('redisWrite'), id: z.string(), op: RedisWriteOp }),
  /**
   * Subscribe to one channel (or pattern). Worker keeps a separate
   * subscriber connection that emits `redisPubsubMessage` events
   * (one-way, no id correlation). A second `redisSubscribe` for the
   * same channel is a no-op; `redisUnsubscribe` of the same channel
   * tears the listener down.
   */
  z.object({
    kind: z.literal('redisSubscribe'),
    id: z.string(),
    channel: z.string().min(1),
    /** True for PSUBSCRIBE-style glob match (e.g. `news:*`). */
    pattern: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('redisUnsubscribe'),
    id: z.string(),
    channel: z.string().min(1),
    pattern: z.boolean().default(false),
  }),
  // ── OpenSearch ops ──
  z.object({ kind: z.literal('osOverview'), id: z.string() }),
  z.object({ kind: z.literal('osMapping'), id: z.string(), index: z.string() }),
  z.object({
    kind: z.literal('osSearch'),
    id: z.string(),
    index: z.string(),
    body: z.string(),
    /** Page size hint forwarded to the request body if not specified there. */
    size: z.number().int().positive().max(10000).default(100),
  }),
  z.object({
    kind: z.literal('osSql'),
    id: z.string(),
    query: z.string().min(1),
  }),
  z.object({ kind: z.literal('osAliases'), id: z.string() }),
  z.object({ kind: z.literal('osIlm'), id: z.string() }),
  z.object({
    kind: z.literal('osCreateIndex'),
    id: z.string(),
    name: z.string().min(1),
    /** Raw create-index body — `{ settings?, mappings?, aliases? }`. */
    body: z.record(z.unknown()).optional(),
  }),
  z.object({
    kind: z.literal('osDeleteIndex'),
    id: z.string(),
    name: z.string().min(1),
  }),
  z.object({
    kind: z.literal('osFieldStats'),
    id: z.string(),
    index: z.string(),
    fields: z.array(z.string()).min(1).max(64),
    /** Optional KQL/Lucene-style filter clause to scope the stats. */
    queryString: z.string().optional(),
  }),
]);
export type WorkerRequest = z.infer<typeof WorkerRequest>;

export const WorkerResponse = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ping'),
    id: z.string(),
    echo: z.string(),
    timestamp: z.number(),
  }),
  z.object({
    kind: z.literal('connected'),
    id: z.string(),
    serverVersion: z.string(),
    engine: ConnectionEngine.default('postgres'),
  }),
  z.object({ kind: z.literal('disconnected'), id: z.string() }),
  z.object({ kind: z.literal('queryResult'), id: z.string(), result: QueryResult }),
  z.object({ kind: z.literal('cancelled'), id: z.string() }),
  z.object({ kind: z.literal('schemaInfo'), id: z.string(), info: SchemaInfo }),
  z.object({ kind: z.literal('txnState'), id: z.string(), state: TxnState }),
  z.object({ kind: z.literal('error'), id: z.string(), message: z.string() }),
  z.object({ kind: z.literal('redisScan'), id: z.string(), result: RedisScanResult }),
  z.object({ kind: z.literal('redisKey'), id: z.string(), result: RedisKeyValue }),
  z.object({ kind: z.literal('redisOverview'), id: z.string(), info: RedisOverview }),
  z.object({ kind: z.literal('redisCommand'), id: z.string(), result: RedisCommandResult }),
  z.object({ kind: z.literal('redisAck'), id: z.string() }),
  z.object({ kind: z.literal('redisAnalyze'), id: z.string(), result: RedisAnalyzeResult }),
  z.object({ kind: z.literal('redisSlowlog'), id: z.string(), entries: z.array(RedisSlowlogEntry) }),
  /**
   * Pub/sub message broadcast — not request-correlated. The id is a
   * constant `'pubsub-event'` sentinel so the supervisor can route it
   * to a separate handler instead of trying to resolve a pending promise.
   */
  z.object({ kind: z.literal('redisPubsub'), id: z.string(), message: RedisPubsubMessage }),
  z.object({ kind: z.literal('osOverview'), id: z.string(), info: OsOverview }),
  z.object({ kind: z.literal('osMapping'), id: z.string(), root: OsMappingNode }),
  z.object({ kind: z.literal('osSearch'), id: z.string(), result: OsSearchResult }),
  z.object({ kind: z.literal('osSql'), id: z.string(), result: OsSqlResult }),
  z.object({ kind: z.literal('osAliases'), id: z.string(), aliases: z.array(OsAlias) }),
  z.object({ kind: z.literal('osIlm'), id: z.string(), policies: z.array(OsIlmPolicy) }),
  z.object({
    kind: z.literal('osCreateIndex'),
    id: z.string(),
    acknowledged: z.boolean(),
    index: z.string(),
  }),
  z.object({
    kind: z.literal('osDeleteIndex'),
    id: z.string(),
    acknowledged: z.boolean(),
  }),
  z.object({ kind: z.literal('osFieldStats'), id: z.string(), stats: z.array(OsFieldStats) }),
]);
export type WorkerResponse = z.infer<typeof WorkerResponse>;

// ─── Settings (keyed values in SQLite) ───────────────────────────────

export const SettingsShape = z.object({
  theme: z
    .preprocess(
      (v) => (v === 'paper' ? 'light' : v === 'midnight' ? 'dark' : v),
      z.enum(['light', 'dark']),
    )
    .default('light'),
  themeName: z
    .enum([
      'default',
      'catppuccin',
      'claude',
      'claymorphism',
      'neo-brutalism',
      'quantum-rose',
      'forest-canopy',
      'cyberpunk',
      'arctic',
    ])
    .catch('default')
    .default('default'),
  /**
   * UI font overrides. `'theme'` defers to the active palette's
   * `--font-sans`/`--font-mono`; any other value pins an inline override
   * on `<html>` so it wins over the theme. Monaco editor keeps its own
   * fixed JetBrains Mono — this only affects the surrounding UI.
   */
  fontSans: z
    .enum(['theme', 'geist', 'inter', 'outfit', 'plus-jakarta', 'ibm-plex', 'system'])
    .catch('theme')
    .default('theme'),
  fontMono: z
    .enum(['theme', 'jetbrains-mono', 'geist-mono', 'ibm-plex-mono', 'system'])
    .catch('theme')
    .default('theme'),
  sidebarCollapsed: z.boolean().default(false),
  sidebarWidth: z.number().int().min(200).max(520).default(264),
  editorExpanded: z.boolean().default(false),
  editorFontSize: z.number().int().min(10).max(24).default(14),
  /**
   * Pixel height of the inline SQL editor when the result grid is also
   * visible. Drives the draggable divider between editor and grid;
   * clamped at run-time to a sane window-relative range.
   */
  editorHeightPx: z.number().int().min(120).max(1200).default(280),
  defaultPageSize: z.number().int().positive().default(50),
  queryTimeoutMs: z.number().int().nonnegative().default(0), // 0 = no timeout
  telemetryEnabled: z.boolean().default(false),
  /**
   * AI provider config. Plasma uses OpenRouter as the unified gateway —
   * one key gives access to Claude, GPT, Gemini, Qwen, etc. Key stored
   * in plain SQLite (not safeStorage) to keep the AI stack portable;
   * OpenRouter keys are revocable + scoped, unlike a personal API key.
   */
  openrouterApiKey: z.string().default(''),
  openrouterModel: z.string().default('anthropic/claude-sonnet-4.5'),
  /** Legacy field kept for backwards compat with v0.0.10 settings rows. */
  claudeApiKey: z.string().default(''),
  transactionMode: z.boolean().default(false),
  /**
   * Per-connection environment tag. Drives the status-bar color (green
   * for local, amber for staging, red for prod) and gates destructive
   * SQL behind a confirm dialog when set to 'prod'. Stored as a
   * connection-id keyed map so this lives entirely in the local
   * settings table — no SQLite schema migration required.
   */
  connectionTags: z.record(z.string(), z.enum(['prod', 'staging', 'dev', 'local'])).default({}),
  /**
   * Per-connection SSH tunnel config. When set, main opens an ssh2
   * tunnel before the Postgres client connects and routes traffic
   * through localhost:<random>. Worker is unaware — it sees a normal
   * local connection. Keys are NOT encrypted at rest yet — TODO move
   * to safeStorage on next schema bump.
   */
  connectionSsh: z
    .record(
      z.string(),
      z.object({
        host: z.string().min(1),
        port: z.number().int().positive().max(65535).default(22),
        user: z.string().min(1),
        /** Either password OR privateKey must be supplied (privateKey wins). */
        password: z.string().default(''),
        privateKey: z.string().default(''),
        passphrase: z.string().default(''),
      }),
    )
    .default({}),
  /**
   * Schema snapshots used by the diff tool. Keyed by snapshot id; the
   * payload holds the connection it came from, a user label, the
   * captured `SchemaInfo`, and a wall-clock timestamp. We cap to the
   * 50 most-recent snapshots when persisting to keep settings.json
   * small — older snapshots get evicted.
   */
  schemaSnapshots: z
    .array(
      z.object({
        id: z.string(),
        connectionId: z.string().nullable(),
        connectionName: z.string(),
        name: z.string(),
        schema: SchemaInfo,
        createdAt: z.number(),
      }),
    )
    .default([]),
  /**
   * Favorite schemas, keyed by connection id. Each entry is the set of
   * schema names marked as favorites for that connection. Favorites sort
   * to the top of the schema list in the sidebar.
   */
  favoriteSchemas: z.record(z.string(), z.array(z.string())).default({}),
  /**
   * Favorite tables, keyed by connection id. Each entry is an array of
   * `"schema.table"` compound keys. Favorites sort to the top within
   * their schema in the sidebar.
   */
  favoriteTables: z.record(z.string(), z.array(z.string())).default({}),
  /**
   * Per-table column state (widths / hidden / pinned), keyed by
   * `"connectionId:schema.table"`. Widths are column-name keyed so they
   * survive schema changes that add/remove columns. Restored when the
   * user reopens a table tab for the same table.
   */
  tableColumnState: z
    .record(
      z.string(),
      z.object({
        widths: z.record(z.string(), z.number()).default({}),
        hidden: z.array(z.string()).default([]),
        sticky: z.array(z.string()).default([]),
      }),
    )
    .default({}),
  /**
   * User-saved tab snapshots, keyed by connection id. Each entry captures
   * everything needed to recreate a tab — for SQL tabs the editor text,
   * for table tabs the schema/name plus filters/sort/hidden/sticky/page
   * size. Re-opened from the right-rail "Saved" panel.
   */
  savedQueries: z
    .record(
      z.string(),
      z.array(
        z.discriminatedUnion('kind', [
          z.object({
            kind: z.literal('sql'),
            id: z.string(),
            name: z.string(),
            createdAt: z.number(),
            updatedAt: z.number(),
            sql: z.string(),
            pageSize: z.number().int().positive().default(50),
          }),
          z.object({
            kind: z.literal('table'),
            id: z.string(),
            name: z.string(),
            createdAt: z.number(),
            updatedAt: z.number(),
            tableSchema: z.string(),
            tableName: z.string(),
            filters: z
              .array(
                z.object({
                  id: z.string(),
                  column: z.string(),
                  op: z.enum([
                    '=',
                    '!=',
                    '>',
                    '<',
                    '>=',
                    '<=',
                    'LIKE',
                    'ILIKE',
                    'IS NULL',
                    'IS NOT NULL',
                  ]),
                  value: z.string(),
                }),
              )
              .default([]),
            sort: z
              .array(
                z.object({
                  column: z.string(),
                  direction: z.enum(['asc', 'desc']),
                }),
              )
              .default([]),
            hidden: z.array(z.string()).default([]),
            sticky: z.array(z.string()).default([]),
            pageSize: z.number().int().positive().default(50),
          }),
        ]),
      ),
    )
    .default({}),
  windowBounds: z
    .object({
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number(),
      height: z.number(),
    })
    .nullable()
    .default(null),
});
export type Settings = z.infer<typeof SettingsShape>;
export type SavedQuery = Settings['savedQueries'][string][number];

// ─── AI (OpenRouter) ─────────────────────────────────────────────────

/**
 * Single turn in an AI conversation. Tool messages are reserved for a
 * future tool-use protocol — for v0.1 we only emit user / assistant /
 * system content.
 */
export const AiMessage = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
});
export type AiMessage = z.infer<typeof AiMessage>;

export const AiChatRequest = z.object({
  /** Stable id per-chat so renderer can correlate streamed deltas + cancel. */
  requestId: z.string(),
  messages: z.array(AiMessage),
  /**
   * Optional schema context. When provided, main builds a compact DDL
   * snapshot and prepends it as a system prompt.
   */
  schema: SchemaInfo.nullable().optional(),
  /**
   * Active engine — drives tool registration + system prompt selection.
   * Defaults to 'postgres' for back-compat with v0.0.10 callers.
   */
  engine: ConnectionEngine.default('postgres'),
  /**
   * Engine-specific overview snapshot the renderer prepares for non-
   * relational engines. Plain string so the renderer keeps its formatting
   * choices (key counts, top indices, mappings) without main reaching
   * back into engine-specific shapes.
   */
  engineContext: z.string().optional(),
  /** Override the configured model on a per-request basis. */
  model: z.string().optional(),
  /** Hard cap on output tokens. Default = unset (use OpenRouter default). */
  maxTokens: z.number().int().positive().optional(),
});
export type AiChatRequest = z.infer<typeof AiChatRequest>;

export type AiChatEvent =
  | { kind: 'delta'; requestId: string; text: string }
  | { kind: 'done'; requestId: string }
  | { kind: 'error'; requestId: string; message: string };

// ─── EXPLAIN result ──────────────────────────────────────────────────

/**
 * Subset of the JSON node shape Postgres emits for
 * `EXPLAIN (ANALYZE, FORMAT JSON, BUFFERS)`. Postgres adds many more
 * fields than this — we keep it permissive on extras but enforce the
 * ones we render.
 */
export interface ExplainNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Total Cost'?: number;
  'Startup Cost'?: number;
  'Plan Rows'?: number;
  'Plan Width'?: number;
  'Actual Total Time'?: number;
  'Actual Startup Time'?: number;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: ExplainNode[];
  [key: string]: unknown;
}

// ─── Charts ──────────────────────────────────────────────────────────

export const ChartConfig = z.object({
  kind: z.enum(['bar', 'line', 'area']),
  /** Column name for the X axis (categorical or temporal). */
  xColumn: z.string(),
  /** Column names for the Y axes. Must be numeric in the result set. */
  yColumns: z.array(z.string()).min(1),
  /** Title shown above the chart. Defaults to the tab name. */
  title: z.string().optional(),
});
export type ChartConfig = z.infer<typeof ChartConfig>;

// ─── Live activity monitor ───────────────────────────────────────────

export const ActivityRow = z.object({
  pid: z.number().int(),
  state: z.string().nullable(),
  user: z.string().nullable(),
  database: z.string().nullable(),
  applicationName: z.string().nullable(),
  clientAddr: z.string().nullable(),
  backendStart: z.string().nullable(),
  queryStart: z.string().nullable(),
  stateChange: z.string().nullable(),
  waitEventType: z.string().nullable(),
  waitEvent: z.string().nullable(),
  query: z.string().nullable(),
  durationMs: z.number().nullable(),
  isCurrent: z.boolean().default(false),
});
export type ActivityRow = z.infer<typeof ActivityRow>;

// ─── IPC channel names ───────────────────────────────────────────────

export const IpcChannel = {
  AppMeta: 'plasma:app:meta',
  ConnectionConnect: 'plasma:conn:connect',
  ConnectionDisconnect: 'plasma:conn:disconnect',
  ConnectionTest: 'plasma:conn:test',
  ConnectionIntrospect: 'plasma:conn:introspect',
  QueryRun: 'plasma:query:run',
  QueryCancel: 'plasma:query:cancel',
  /**
   * Run a query on the worker's sideband connection. Used by the live
   * monitor + pg_terminate_backend so a long-running primary query
   * doesn't block the activity refresh.
   */
  QuerySideband: 'plasma:query:sideband',
  // Redis ops
  RedisScan: 'plasma:redis:scan',
  RedisGetKey: 'plasma:redis:getKey',
  RedisDeleteKey: 'plasma:redis:deleteKey',
  RedisSetTtl: 'plasma:redis:setTtl',
  RedisCommand: 'plasma:redis:command',
  RedisOverview: 'plasma:redis:overview',
  RedisAnalyze: 'plasma:redis:analyze',
  RedisSlowlog: 'plasma:redis:slowlog',
  RedisBulkDelete: 'plasma:redis:bulkDelete',
  RedisWrite: 'plasma:redis:write',
  RedisSubscribe: 'plasma:redis:subscribe',
  RedisUnsubscribe: 'plasma:redis:unsubscribe',
  /** Renderer-facing event channel for streamed pub/sub messages. */
  RedisPubsubEvent: 'plasma:redis:pubsub',
  // OpenSearch ops
  OsOverview: 'plasma:os:overview',
  OsMapping: 'plasma:os:mapping',
  OsSearch: 'plasma:os:search',
  OsSql: 'plasma:os:sql',
  OsAliases: 'plasma:os:aliases',
  OsIlm: 'plasma:os:ilm',
  OsCreateIndex: 'plasma:os:createIndex',
  OsDeleteIndex: 'plasma:os:deleteIndex',
  OsFieldStats: 'plasma:os:fieldStats',
  VaultList: 'plasma:vault:list',
  VaultDelete: 'plasma:vault:delete',
  VaultConnectById: 'plasma:vault:connectById',
  VaultGetConfig: 'plasma:vault:getConfig',
  HistoryList: 'plasma:history:list',
  HistoryClear: 'plasma:history:clear',
  SettingsGet: 'plasma:settings:get',
  SettingsSet: 'plasma:settings:set',
  TxnBegin: 'plasma:txn:begin',
  TxnCommit: 'plasma:txn:commit',
  TxnRollback: 'plasma:txn:rollback',
  // AI (OpenRouter)
  AiChat: 'plasma:ai:chat',
  AiCancel: 'plasma:ai:cancel',
  /** Renderer-facing event channel for streamed AI deltas. */
  AiEvent: 'plasma:ai:event',
  // SQL formatting (kept main-side so we can swap engines later without
  // re-bundling the renderer).
  FormatSql: 'plasma:sql:format',
  // Window controls (custom titlebar — Windows/Linux)
  WindowMinimize: 'plasma:window:minimize',
  WindowMaximizeToggle: 'plasma:window:maximizeToggle',
  WindowClose: 'plasma:window:close',
  WindowIsMaximized: 'plasma:window:isMaximized',
  // Auto-update (electron-updater)
  UpdateCheck: 'plasma:update:check',
  UpdateInstall: 'plasma:update:install',
  UpdateStatus: 'plasma:update:status',
  // Dev sanity checks
  PingMain: 'plasma:ping:main',
  PingWorker: 'plasma:ping:worker',
} as const;

// ─── Auto-update ─────────────────────────────────────────────────────

export type UpdateStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'not-available'; version: string }
  | { kind: 'available'; version: string; releaseNotes?: string | null }
  | {
      kind: 'downloading';
      percent: number;
      bytesPerSecond: number;
      transferred: number;
      total: number;
    }
  | { kind: 'downloaded'; version: string; releaseNotes?: string | null }
  | { kind: 'error'; message: string };

// ─── Ping (dev sanity check) ─────────────────────────────────────────

export const PingRequest = z.object({ message: z.string() });
export type PingRequest = z.infer<typeof PingRequest>;

export const PingResponse = z.object({
  echo: z.string(),
  via: z.enum(['main', 'worker']),
  timestamp: z.number(),
});
export type PingResponse = z.infer<typeof PingResponse>;

// ─── Renderer-facing API surface (what contextBridge exposes) ───────

export interface PlasmaAPI {
  platform: Platform;
  app: {
    meta(): Promise<AppMeta>;
  };
  conn: {
    connect(config: ConnectionConfig): Promise<ConnectionInfo>;
    disconnect(): Promise<void>;
    test(config: ConnectionConfig): Promise<ConnectionTestResult>;
    introspect(): Promise<SchemaInfo>;
  };
  vault: {
    list(): Promise<SavedConnection[]>;
    delete(id: string): Promise<void>;
    connectById(id: string): Promise<{ info: ConnectionInfo; config: SavedConnection }>;
    /**
     * Read a saved connection with its decrypted password. Used for the
     * Edit flow so the user doesn't have to re-type their password.
     * Returns null if no connection with that id exists.
     */
    getConfig(id: string): Promise<ConnectionConfig | null>;
  };
  query: {
    /**
     * Execute a SQL statement.
     * @param opts.internal — when true, the query is NOT recorded in
     *   history. Use for Plasma's own plumbing (introspection, RLS
     *   lookup, count queries, table-tab data, role list, SET ROLE,
     *   table definition). User-written queries should leave this off.
     */
    run(sql: string, params?: unknown[], opts?: { internal?: boolean }): Promise<QueryResult>;
    cancel(): Promise<void>;
    /**
     * Run a query on the worker's sideband connection — never recorded
     * in history. Used by the live monitor + pg_terminate_backend so a
     * long-running primary query doesn't block monitoring.
     */
    sideband(sql: string, params?: unknown[]): Promise<QueryResult>;
  };
  redis: {
    overview(): Promise<RedisOverview>;
    scan(opts: {
      cursor?: string;
      match?: string;
      count?: number;
      db?: number;
    }): Promise<RedisScanResult>;
    getKey(key: string): Promise<RedisKeyValue>;
    deleteKey(key: string): Promise<void>;
    /** seconds <= 0 → PERSIST (clear TTL). */
    setTtl(key: string, seconds: number): Promise<void>;
    command(parts: string[]): Promise<RedisCommandResult>;
    analyze(opts?: { sampleCap?: number; match?: string }): Promise<RedisAnalyzeResult>;
    slowlog(limit?: number): Promise<RedisSlowlogEntry[]>;
    bulkDelete(keys: string[]): Promise<void>;
    write(op: RedisWriteOp): Promise<void>;
    subscribe(channel: string, pattern?: boolean): Promise<void>;
    unsubscribe(channel: string, pattern?: boolean): Promise<void>;
  };
  os: {
    overview(): Promise<OsOverview>;
    mapping(index: string): Promise<OsMappingNode>;
    search(opts: { index: string; body: string; size?: number }): Promise<OsSearchResult>;
    sql(query: string): Promise<OsSqlResult>;
    aliases(): Promise<OsAlias[]>;
    ilm(): Promise<OsIlmPolicy[]>;
    createIndex(
      name: string,
      body?: Record<string, unknown>,
    ): Promise<{ acknowledged: boolean; index: string }>;
    deleteIndex(name: string): Promise<{ acknowledged: boolean }>;
    fieldStats(opts: {
      index: string;
      fields: string[];
      queryString?: string;
    }): Promise<OsFieldStats[]>;
  };
  ai: {
    /**
     * Start a streamed chat completion against OpenRouter. Deltas are
     * delivered via `plasmaEvents.on('plasma:ai:event', ...)`. Resolves
     * once the request is queued; completion is signalled by an event
     * with `kind: 'done'` or `kind: 'error'`.
     */
    chat(req: AiChatRequest): Promise<{ accepted: boolean }>;
    /** Abort an in-flight streamed chat completion. */
    cancel(requestId: string): Promise<void>;
  };
  sql: {
    /** Pretty-print a SQL string. Falls back to the input on parse errors. */
    format(sql: string): Promise<string>;
  };
  history: {
    list(opts?: { limit?: number; connectionId?: string }): Promise<HistoryEntry[]>;
    clear(): Promise<void>;
  };
  settings: {
    get(): Promise<Settings>;
    set(patch: Partial<Settings>): Promise<Settings>;
  };
  txn: {
    begin(): Promise<TxnState>;
    commit(): Promise<TxnState>;
    rollback(): Promise<TxnState>;
  };
  ping: {
    main(req: PingRequest): Promise<PingResponse>;
    worker(req: PingRequest): Promise<PingResponse>;
  };
  window: {
    minimize(): Promise<void>;
    maximizeToggle(): Promise<void>;
    close(): Promise<void>;
    isMaximized(): Promise<boolean>;
  };
  update: {
    /** Trigger an explicit check now. Returns the status post-check. */
    check(): Promise<UpdateStatus>;
    /** Install the downloaded update + restart. No-op unless status is `downloaded`. */
    install(): Promise<void>;
    /** Read the most recent status snapshot (no network). */
    status(): Promise<UpdateStatus>;
  };
}
