import { z } from 'zod';
import {
  AI_MAX_IMAGES_PER_MESSAGE,
  AI_MAX_IMAGES_PER_REQUEST,
  AI_MAX_IMAGE_DATA_URL,
  countImages,
  isAiImageDataUrl,
} from './ai-images';
import type { AiModel, AiModelsResult } from './ai-models';
import type {
  AuditEntry,
  AuditExportRequest,
  AuditExportResult,
  AuditListOpts,
  AuditVerifyResult,
} from './audit';
import { CONNECTION_LOST } from './connection-loss';
import type {
  AdminStartResult,
  BackupRequest,
  PickPathRequest,
  RestoreRequest,
  ToolInfo,
} from './pg-backup';
import { PgNotification } from './pg-listen';

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
 *   - sqlite     : database = absolute path of the database file (picked
 *                  through the native dialog and validated in main);
 *                  host/port are placeholders ('local', 1); readOnly opens
 *                  the file read-only
 *   - mysql      : like postgres (host, port, database, user, password,
 *                  ssl/tls); also serves MariaDB
 *   - clickhouse : HTTP(S) interface: host, port (8123 / 8443), database,
 *                  user, password, ssl/tls
 *   - duckdb     : database = absolute path of a .duckdb file, or ':memory:'
 *                  for a session over data files (`duckdb.files`); host/port
 *                  are placeholders ('local', 1)
 */
export const ConnectionEngine = z.enum([
  'postgres',
  'redis',
  'opensearch',
  'sqlite',
  'mysql',
  'clickhouse',
  'duckdb',
]);
export type ConnectionEngine = z.infer<typeof ConnectionEngine>;
/**
 * libpq-style TLS modes (C4/C9). `disable` is the same as `ssl: false`.
 * `insecure` is the pre-C9 spelling of `require` and is kept so old
 * rows still parse.
 */
export const TlsMode = z.enum([
  'disable',
  'prefer',
  'require',
  'verify-ca',
  'verify-full',
  'insecure',
]);
export type TlsMode = z.infer<typeof TlsMode>;
export const ConnectionTls = z.object({
  mode: TlsMode.default('verify-full'),
  /** PEM contents — filled in by main from the *File paths before connect. */
  ca: z.string().optional(),
  cert: z.string().optional(),
  key: z.string().optional(),
  /** Paths the user picked in the dialog; persisted in the vault. */
  caFile: z.string().optional(),
  certFile: z.string().optional(),
  keyFile: z.string().optional(),
  servername: z.string().optional(),
});
export type ConnectionTls = z.infer<typeof ConnectionTls>;

/**
 * OpenSearch endpoint + auth options (O12). Secret fields (`apiKey`,
 * `awsSecretAccessKey`, `awsSessionToken`) live in the vault; the renderer
 * gets them back blank with `has*` flags, and a blank value on save keeps
 * the stored one.
 */
export const OpenSearchOptions = z.object({
  /** Which credentials to send: HTTP basic (user/password), an API key, or AWS SigV4. */
  auth: z.enum(['basic', 'apiKey', 'sigv4']).optional(),
  /** `id:key` or the already base64-encoded key. */
  apiKey: z.string().optional(),
  awsRegion: z.string().optional(),
  /** `es` = managed domain, `aoss` = OpenSearch Serverless. */
  awsService: z.enum(['es', 'aoss']).optional(),
  awsAccessKeyId: z.string().optional(),
  awsSecretAccessKey: z.string().optional(),
  awsSessionToken: z.string().optional(),
  /** Path the cluster is served under behind a proxy, e.g. `/search`. */
  pathPrefix: z.string().optional(),
  /** Extra node URLs (round-robin) besides host:port. */
  nodes: z.array(z.string()).optional(),
  hasApiKey: z.boolean().optional(),
  hasAwsSecretAccessKey: z.boolean().optional(),
  hasAwsSessionToken: z.boolean().optional(),
});
export type OpenSearchOptions = z.infer<typeof OpenSearchOptions>;

/**
 * DuckDB session options. `files` are data files (CSV / Parquet / JSON) that
 * become views; main only lets through paths the user picked or dropped.
 * `attachConnectionIds` name saved Postgres connections to attach read-only;
 * main resolves them into `attach` (the renderer's own `attach` is discarded).
 */
export const DuckdbAttach = z.object({
  /** Catalog name the attachment gets in DuckDB. */
  alias: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().positive().max(65535),
  database: z.string(),
  user: z.string(),
  /** Only ever filled in by main; it goes into a DuckDB secret, never into SQL text. */
  password: z.string(),
  /** libpq sslmode. */
  sslmode: z.enum(['disable', 'prefer', 'require', 'verify-ca', 'verify-full']).optional(),
  /** CA file for verify-ca / verify-full. */
  sslrootcert: z.string().optional(),
});
export type DuckdbAttach = z.infer<typeof DuckdbAttach>;
export const DuckdbOptions = z.object({
  files: z.array(z.string().min(1)).max(64).default([]),
  attachConnectionIds: z.array(z.string().min(1)).max(8).optional(),
  attach: z.array(DuckdbAttach).max(8).optional(),
  /**
   * The user agreed to download DuckDB's official (signed) Postgres
   * extension from extensions.duckdb.org when it isn't installed yet.
   */
  installPostgresExtension: z.boolean().optional(),
  /** Same consent for DuckDB's official Excel extension (needed for .xlsx files). */
  installExcelExtension: z.boolean().optional(),
});
export type DuckdbOptions = z.infer<typeof DuckdbOptions>;

/** Data files main accepted (validated + allowlisted) and why it refused the rest. */
export interface DataFilePickResult {
  files: string[];
  problems: string[];
}

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
  tls: ConnectionTls.optional(),
  readOnly: z.boolean().default(false),
  /** Folder the connection is listed under (C28); empty/absent = top level. */
  group: z.string().optional(),
  /** Postgres: statements run right after connecting (SET search_path…). */
  bootstrapSql: z.string().optional(),
  /** OpenSearch auth + endpoints (O12). */
  opensearch: OpenSearchOptions.optional(),
  /** DuckDB data-file session options. */
  duckdb: DuckdbOptions.optional(),
});
export type ConnectionConfig = Omit<z.infer<typeof ConnectionConfig>, 'readOnly'> & {
  readOnly?: boolean;
};

export const SavedConnection = ConnectionConfig.omit({ password: true });
export type SavedConnection = Omit<z.infer<typeof SavedConnection>, 'readOnly'> & {
  readOnly?: boolean;
};

export const ConnectionInfo = z.object({
  serverVersion: z.string(),
  engine: ConnectionEngine.default('postgres'),
  connectionGen: z.number().int().nonnegative().optional(),
});
export type ConnectionInfo = z.infer<typeof ConnectionInfo>;

/** Codes an error carried (SQLSTATE, errno, HTTP status...), next to its message. See `error-info.ts`. */
export const ErrorInfoSchema = z.object({
  code: z.string().optional(),
  errno: z.number().optional(),
  sqlstate: z.string().optional(),
  status: z.number().optional(),
  name: z.string().optional(),
  type: z.string().optional(),
  syscall: z.string().optional(),
  level: z.string().optional(),
  hostKey: z.enum(['changed', 'unknown']).optional(),
  forwardError: z.string().optional(),
  source: z.enum(['ssh', 'driver']).optional(),
});

/** A connect failure in plain words. See `connect-diagnosis.ts`. */
export const ConnectDiagnosisSchema = z.object({
  cause: z.string(),
  title: z.string(),
  detail: z.string(),
  fixes: z.array(z.string()),
  field: z.enum(['host', 'port', 'user', 'password', 'database', 'ssl', 'ssh']).optional(),
  raw: z.string(),
});

/** One step of "Test connection". See `connect-stages.ts`. */
export const ConnectStageSchema = z.object({
  id: z.enum(['ssh', 'dns', 'tcp', 'tls', 'login', 'database']),
  label: z.string(),
  status: z.enum(['ok', 'failed', 'skipped']),
  ms: z.number().optional(),
  note: z.string().optional(),
});

export const ConnectionTestResult = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    serverVersion: z.string(),
    engine: ConnectionEngine.default('postgres'),
    stages: z.array(ConnectStageSchema).optional(),
    /** Connected, but worth a note (an OpenSearch cluster that is red). */
    warning: ConnectDiagnosisSchema.optional(),
  }),
  z.object({
    ok: z.literal(false),
    message: z.string(),
    diagnosis: ConnectDiagnosisSchema.optional(),
    stages: z.array(ConnectStageSchema).optional(),
  }),
]);
export type ConnectionTestResult = z.infer<typeof ConnectionTestResult>;

/**
 * Payload of `IpcChannel.ConnectionRecoveredEvent` — main re-established
 * the worker's DB session by itself after a transport loss (U27).
 */
export const ConnectionRecovered = z.object({
  serverVersion: z.string(),
  engine: ConnectionEngine.default('postgres'),
  connectionGen: z.number().int().nonnegative(),
  /** Attempts spent before the session came back (>= 1). */
  attempts: z.number().int().positive(),
  /** Saved connection the session belongs to — the renderer ignores mismatches (C11). */
  connectionId: z.string().optional(),
});
export type ConnectionRecovered = z.infer<typeof ConnectionRecovered>;
export const ConnectionSshConfig = z.object({
  host: z.string().min(1),
  port: z.number().int().positive().max(65535).default(22),
  user: z.string().min(1),
  password: z.string().default(''),
  privateKey: z.string().default(''),
  passphrase: z.string().default(''),
  privateKeyPath: z.string().default(''),
  useAgent: z.boolean().default(false),
});
export type ConnectionSshConfig = z.infer<typeof ConnectionSshConfig>;

/** Payload of `IpcChannel.SshHostKeyPromptEvent` (C8). */
export interface SshHostKeyPrompt {
  requestId: string;
  host: string;
  port: number;
  fingerprint: string;
  /** `changed` = the host presented a different key than the one remembered. */
  kind: 'unknown' | 'changed';
  expectedFingerprint?: string;
}

/** What would be lost if the window closed now (C32). */
export const AppUnsavedState = z.object({
  openTransaction: z.boolean(),
  pendingEdits: z.number().int().nonnegative(),
  /** A query is still executing in some tab. */
  runningQuery: z.boolean().optional(),
  /** A Safe Run holds a transaction open, waiting for Commit / Roll back. */
  safeRunPending: z.boolean().optional(),
  /** SQL tabs with unsaved text that the tab persistence cannot bring back after a restart. */
  unsavedSqlTabs: z.number().int().nonnegative().optional(),
});
export type AppUnsavedState = z.infer<typeof AppUnsavedState>;

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
  /** SCAN calls made for this page (a MATCH scan loops until it finds enough keys). */
  iterations: z.number().int().optional(),
  /** Database the page was read from. */
  db: z.number().int().optional(),
});
export type RedisScanResult = z.infer<typeof RedisScanResult>;

export const RedisKeyValue = z.object({
  key: z.string(),
  type: RedisValueType,
  ttlMs: z.number().int().nullable(),
  encoding: z.string().optional(),
  /**
   * Engine-shape payload, all serialized for IPC.
   *  - string  → string, or RedisBinaryValue / large-value stub
   *  - list    → { items: RedisCell[], total }
   *  - set     → { items: RedisCell[], total }
   *  - zset    → { items: [RedisCell, score][], total }
   *  - hash    → { items: [RedisCell, RedisCell][], total }
   *  - stream  → { items: { id, fields: [name, RedisCell][] }[], total, groups? }
   *  - json    → any (already parsed by RedisJSON.GET)
   *  - none    → null
   * A RedisCell is a string, or `{ $binary: base64 }` when the bytes are
   * not valid UTF-8 (R12) — never a lossy utf8 decode.
   */
  value: z.unknown(),
  /** Raw TYPE reply — set for module types rendered as `unknown` (R16). */
  typeName: z.string().optional(),
  /** MEMORY USAGE in bytes; null when unavailable (ACL / old server). */
  memoryBytes: z.number().int().nullable().optional(),
  /** OBJECT IDLETIME seconds / OBJECT FREQ (LFU only); null when unavailable. */
  idleSeconds: z.number().int().nullable().optional(),
  freq: z.number().int().nullable().optional(),
  /**
   * Continuation for collections read page by page (R24): list offset,
   * SCAN cursor, zset rank or stream id. null/absent = no more elements.
   */
  nextCursor: z.string().nullable().optional(),
  /** Page stopped early because the element bytes hit the fetch budget (R11). */
  byteCapped: z.boolean().optional(),
  /** Database the key was read from. */
  db: z.number().int().optional(),
});
export type RedisKeyValue = z.infer<typeof RedisKeyValue>;

/** Options for reading one page of a key (R24). */
export const RedisGetKeyOpts = z.object({
  db: z.number().int().nonnegative().optional(),
  /** Continuation from a previous page's `nextCursor`. */
  cursor: z.string().optional(),
  /** Elements per page (default 500, max 5000). */
  count: z.number().int().positive().max(5000).optional(),
  /** HSCAN/SSCAN/ZSCAN MATCH filter. */
  match: z.string().optional(),
  /** Newest-first for streams (XREVRANGE), highest score first for zsets. */
  reverse: z.boolean().optional(),
});
export type RedisGetKeyOpts = z.infer<typeof RedisGetKeyOpts>;

/** Result of a server-side delete-by-pattern (R26). */
export const RedisPatternDeleteResult = z.object({
  /** Keys matched by the SCAN (capped at `limit`). */
  matched: z.number().int(),
  /** Keys actually removed (0 on a dry run). */
  deleted: z.number().int(),
  /** First few matching keys, for the confirmation preview. */
  sample: z.array(z.string()),
  /** True when the scan stopped at the limit before the cursor finished. */
  capped: z.boolean(),
  failed: z.number().int(),
  dryRun: z.boolean(),
});
export type RedisPatternDeleteResult = z.infer<typeof RedisPatternDeleteResult>;

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
  /** From `INFO memory` / `clients` / `server`; absent on servers that hide them. */
  usedMemoryHuman: z.string().optional(),
  maxMemoryHuman: z.string().optional(),
  connectedClients: z.number().int().optional(),
  uptimeSeconds: z.number().int().optional(),
});
export type RedisOverview = z.infer<typeof RedisOverview>;

// ─── Redis advanced ──────────────────────────────────────────────────

/** Single sample row in a memory analyzer scan. */
export const RedisAnalyzeSample = z.object({
  key: z.string(),
  type: RedisValueType,
  /** MEMORY USAGE; null when unavailable (never a fake 0). */
  bytes: z.number().int().nullable(),
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
  /** True when the user cancelled — the aggregates cover what was scanned so far. */
  cancelled: z.boolean().optional(),
  /** Keys whose MEMORY USAGE was unavailable (excluded from byte totals). */
  unsized: z.number().int().optional(),
});
export type RedisAnalyzeResult = z.infer<typeof RedisAnalyzeResult>;
export const RedisBulkDeleteFailure = z.object({ key: z.string(), error: z.string() });
export type RedisBulkDeleteFailure = z.infer<typeof RedisBulkDeleteFailure>;
export const RedisBulkDeleteResult = z.object({
  deleted: z.array(z.string()),
  failed: z.array(RedisBulkDeleteFailure),
});
export type RedisBulkDeleteResult = z.infer<typeof RedisBulkDeleteResult>;

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
    /** SET … KEEPTTL — keep whatever expiry the key has *now* (R9). */
    keepTtl: z.boolean().optional(),
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
  // ── R21 / R23 ──
  /** RENAMENX, or RENAME when `overwrite` (destination replaced). */
  z.object({
    kind: z.literal('rename'),
    key: z.string(),
    newKey: z.string().min(1),
    overwrite: z.boolean().optional(),
  }),
  /** COPY (Redis ≥ 6.2), falling back to DUMP + RESTORE; keeps the TTL. */
  z.object({
    kind: z.literal('copy'),
    key: z.string(),
    newKey: z.string().min(1),
    overwrite: z.boolean().optional(),
  }),
  /** Create a new key with one initial element; fails if the key exists. */
  z.object({
    kind: z.literal('createKey'),
    key: z.string().min(1),
    keyType: z.enum(['string', 'hash', 'list', 'set', 'zset', 'stream', 'json']),
    /** string value / hash value / list element / set member / zset member / JSON document. */
    value: z.string(),
    /** hash field or stream field name. */
    field: z.string().optional(),
    score: z.number().optional(),
    ttlSeconds: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal('hashRename'),
    key: z.string(),
    field: z.string(),
    newField: z.string().min(1),
  }),
  z.object({
    kind: z.literal('listRem'),
    key: z.string(),
    value: z.string(),
    /** LREM count: 0 = all, >0 from head, <0 from tail. */
    count: z.number().int().optional(),
  }),
  z.object({
    kind: z.literal('streamAdd'),
    key: z.string(),
    /** Entry id; `*` = server-generated. */
    id: z.string().optional(),
    fields: z.array(z.tuple([z.string(), z.string()])).min(1),
  }),
  z.object({ kind: z.literal('streamDel'), key: z.string(), ids: z.array(z.string()).min(1) }),
  z.object({
    kind: z.literal('jsonSet'),
    key: z.string(),
    path: z.string().optional(),
    value: z.string(),
  }),
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
  /** Hit `sort` values — the `search_after` cursor for the next page (O3). */
  sort: z.array(z.unknown()).optional(),
});
export type OsHit = z.infer<typeof OsHit>;

export const OsSearchResult = z.object({
  total: z.number().int(),
  /** `gte` when the cluster stopped counting (track_total_hits cap) — render "≥ total" (O3). */
  totalRelation: z.enum(['eq', 'gte']).default('eq'),
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
  /** Multi-fields (`title.keyword`) declared under `fields` (O5). */
  multiFields?: Array<{ name: string; type: string | null }>;
  /** Distinct types seen for this path across the matched indices (O5). */
  conflicts?: string[];
};
export const OsMappingNode: z.ZodType<OsMappingNode> = z.lazy(() =>
  z.object({
    name: z.string(),
    type: z.string().nullable(),
    children: z.array(OsMappingNode),
    multiFields: z.array(z.object({ name: z.string(), type: z.string().nullable() })).optional(),
    conflicts: z.array(z.string()).optional(),
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
  /** SQL plugin cursor for the next page (fetch_size paging, O20). */
  cursor: z.string().nullable().optional(),
});
export type OsSqlResult = z.infer<typeof OsSqlResult>;

/** Raw REST response for the Dev Tools console / generic cluster calls (O14). */
export const OsRawResponse = z.object({
  status: z.number().int(),
  body: z.unknown(),
  /**
   * The response text, only when it holds an integer beyond 2^53 (`body` then shows it as text).
   * The document editor builds its text from this so the number is written back as a number.
   */
  rawBody: z.string().optional(),
  durationMs: z.number(),
});
export type OsRawResponse = z.infer<typeof OsRawResponse>;

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
  /** Aggregated path when it differs (`title` → `title.keyword`, O2). */
  aggField: z.string().nullable().optional(),
  /** Why this field has no stats (not aggregatable, agg failed) — per field, O2. */
  error: z.string().nullable().optional(),
});
export type OsFieldStats = z.infer<typeof OsFieldStats>;

// ─── Query + results ─────────────────────────────────────────────────

export const ColumnMeta = z.object({
  name: z.string(),
  dataTypeID: z.number().int(),
  dataTypeName: z.string(),
  /**
   * Postgres: the type (or its base / element type) has no usable `=` (composites,
   * json arrays, domains over them…), so a grid commit cannot compare it. Only set when true.
   */
  noEquality: z.literal(true).optional(),
});
export type ColumnMeta = z.infer<typeof ColumnMeta>;

/** Postgres NOTICE / RAISE NOTICE (and WARNING) payload from `pg`. */
export const PgNotice = z.object({
  message: z.string(),
  severity: z.string().optional(),
  code: z.string().optional(),
  detail: z.string().optional(),
  hint: z.string().optional(),
  where: z.string().optional(),
});
export type PgNotice = z.infer<typeof PgNotice>;

export const QueryResult = z.object({
  columns: z.array(ColumnMeta),
  rows: z.array(z.array(z.unknown())),
  rowCount: z.number().int(),
  durationMs: z.number(),
  command: z.string().optional(),
  /**
   * True when the worker stopped early due to row/byte caps (U15).
   * `rows` is then a prefix; `rowCount` is rows retained (not a server total).
   */
  truncated: z.boolean().optional(),
  notices: z.array(PgNotice).optional(),
  /**
   * Primary-connection transaction status after the statement, read from
   * the server's ReadyForQuery (I → none, T → active, E → error) (F4).
   */
  txnState: z.enum(['none', 'active', 'error']).optional(),
  /** Renderer-only: the statement text that produced this result. */
  sql: z.string().optional(),
});
export type QueryResult = z.infer<typeof QueryResult>;

/**
 * What `query.cancel` found: the cancel signal was `sent` to the server
 * (the run then fails with the engine's cancel error), nothing was in
 * flight (`nothing-running`: it already finished or never started), the
 * engine has no way to stop a statement (`unsupported`), or the server did
 * not confirm the cancel (`failed`: no answer, refused).
 */
export type CancelOutcome = 'sent' | 'nothing-running' | 'unsupported' | 'failed';

/**
 * Result Compare: run one read-only statement on a saved connection (null =
 * the active one). Same read-only path as the agent's run_query.
 */
export const CompareRunRequest = z.object({
  connectionId: z.string().nullable(),
  sql: z.string().min(1).max(200_000),
  maxRows: z.number().int().positive().max(200_000).optional(),
  /** Lets `compare.cancel(runId)` stop this run on another connection. */
  runId: z.string().min(1).max(100).optional(),
});
export type CompareRunRequest = z.infer<typeof CompareRunRequest>;

/** Result export formats (U16). */
export const ExportFormat = z.enum(['csv', 'json', 'sql']);
export type ExportFormat = z.infer<typeof ExportFormat>;

/** CSV dialect (Settings → Data → CSV export); mirrors `CsvOptions` in export-format. */
export const CsvExportOptions = z.object({
  delimiter: z.enum([',', ';', '\t', '|']).catch(',').default(','),
  header: z.boolean().catch(true).default(true),
  quote: z.enum(['"', "'"]).catch('"').default('"'),
  /** How SQL NULL is written: empty field or the literal `NULL`. */
  nullAs: z.enum(['empty', 'NULL']).catch('empty').default('empty'),
  lineEnding: z.enum(['lf', 'crlf']).catch('lf').default('lf'),
  /** Prefix `'` on cells starting with = + - @ TAB CR so spreadsheets don't run them (SC-15). Absent = on. */
  formulaGuard: z.boolean().catch(true).optional(),
});

export const ExportSaveRequest = z.object({
  format: ExportFormat,
  /** Suggested filename stem or full name for the save dialog. */
  defaultPath: z.string().min(1),
  columns: z.array(ColumnMeta),
  /**
   * In-memory rows (selection or capped result). Omit when `sql` is set
   * so the worker re-queries unboundedly for full-result export.
   */
  rows: z.array(z.array(z.unknown())).optional(),
  /** When set (and rows omitted), worker streams an unbounded query to file. */
  sql: z.string().optional(),
  params: z.array(z.unknown()).optional(),
  /** Qualified, quoted INSERT target for SQL export (e.g. `"public"."users"`). */
  targetTable: z.string().optional(),
  /** Correlates progress events and `export.cancel` with this export (C30). */
  jobId: z.string().optional(),
});
export type ExportSaveRequest = z.infer<typeof ExportSaveRequest>;

// ─── Structure editing + import (wave 2) ─────────────────────────────

/** Statements from the structure editor / create-table dialog (built by `pg-ddl`). */
export const DdlApplyRequest = z.object({
  connectionGen: z.number().int().nonnegative(),
  /** Run together in one transaction. */
  transactional: z.array(z.string().min(1)).max(2000),
  /** CREATE/DROP INDEX CONCURRENTLY — each runs alone, after the transaction. */
  concurrent: z.array(z.string().min(1)).max(200).default([]),
});
export type DdlApplyRequest = z.infer<typeof DdlApplyRequest>;

export const DdlApplyResult = z.object({
  /** Statements that ran (transactional ones count only if the batch committed). */
  executed: z.number().int().nonnegative(),
  error: z
    .object({ message: z.string(), statement: z.string(), index: z.number().int().nonnegative() })
    .optional(),
});
export type DdlApplyResult = z.infer<typeof DdlApplyResult>;

export const ImportFormat = z.enum(['csv', 'tsv', 'json', 'ndjson', 'sql']);
export type ImportFormat = z.infer<typeof ImportFormat>;

export const ImportCsvOptions = z.object({
  delimiter: z.string().length(1),
  quote: z.string().max(1),
  header: z.boolean(),
  nullString: z.string().nullable(),
});
export type ImportCsvOptions = z.infer<typeof ImportCsvOptions>;

export const ImportJobSpec = z.object({
  jobId: z.string().min(1),
  connectionGen: z.number().int().nonnegative(),
  filePath: z.string().min(1),
  format: ImportFormat,
  schema: z.string().min(1),
  table: z.string().min(1),
  csv: ImportCsvOptions.optional(),
  /** Target column <- CSV column index or JSON key. Empty for .sql files. */
  columns: z
    .array(
      z.object({
        target: z.string().min(1),
        source: z.union([z.number().int().nonnegative(), z.string()]),
      }),
    )
    .max(1600),
  /** DDL to run first, in the same transaction (create-a-new-table option). */
  preStatements: z.array(z.string().min(1)).max(200).default([]),
  batchRows: z.number().int().positive().max(10000).optional(),
});
export type ImportJobSpec = z.infer<typeof ImportJobSpec>;

export const ExportProgress = z.object({
  jobId: z.string(),
  rowCount: z.number().int().nonnegative(),
  bytesWritten: z.number().nonnegative(),
});
export type ExportProgress = z.infer<typeof ExportProgress>;

export const ImportProgress = z.object({
  jobId: z.string(),
  rowsRead: z.number().int().nonnegative(),
  rowsImported: z.number().int().nonnegative(),
  bytesRead: z.number().nonnegative(),
  totalBytes: z.number().nonnegative(),
});
export type ImportProgress = z.infer<typeof ImportProgress>;

export const ImportResult = z.object({
  jobId: z.string(),
  /** Rows committed. Always 0 unless `ok`. */
  rowsImported: z.number().int().nonnegative(),
  rowsRead: z.number().int().nonnegative(),
  /** SQL files: statements executed. */
  statements: z.number().int().nonnegative().optional(),
  ok: z.boolean(),
  cancelled: z.boolean().optional(),
  error: z
    .object({
      message: z.string(),
      /** 1-based data row (or statement) that failed first, when known. */
      row: z.number().int().positive().optional(),
      /** A short rendering of that row / statement. */
      sample: z.string().optional(),
    })
    .optional(),
});
export type ImportResult = z.infer<typeof ImportResult>;

export const ImportPreviewRequest = z.object({
  path: z.string().min(1),
  format: ImportFormat,
  csv: ImportCsvOptions.partial().optional(),
});
export type ImportPreviewRequest = z.infer<typeof ImportPreviewRequest>;

export const ImportPreview = z.object({
  path: z.string(),
  format: ImportFormat,
  size: z.number().nonnegative(),
  csv: ImportCsvOptions.optional(),
  /** Column labels: header cells, JSON keys, or "column 1…". */
  columns: z.array(z.string()),
  /** First rows, already null-aware. Cells are null or text. */
  rows: z.array(z.array(z.string().nullable())),
  /** Inferred pg type per column (for create-a-new-table). */
  types: z.array(z.string()),
  /** SQL files: the first statements. */
  statements: z.array(z.string()).optional(),
  /** True when the sample ended before the end of the file. */
  truncated: z.boolean(),
});
export type ImportPreview = z.infer<typeof ImportPreview>;

export const ImportPickedFile = z.object({
  path: z.string(),
  name: z.string(),
  size: z.number().nonnegative(),
  format: ImportFormat.nullable(),
});
export type ImportPickedFile = z.infer<typeof ImportPickedFile>;

export const ExportSaveResult = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    filePath: z.string(),
    rowCount: z.number().int().nonnegative(),
    bytesWritten: z.number().int().nonnegative(),
  }),
  z.object({ ok: z.literal(false), canceled: z.literal(true) }),
]);
export type ExportSaveResult = z.infer<typeof ExportSaveResult>;

/**
 * Lightweight chunk event for cursor streaming (U15 step 2).
 * `rows` is validated as an array only — no per-cell Zod walk.
 */
export const QueryChunk = z.object({
  kind: z.literal('queryChunk'),
  /** Correlates to the in-flight query request id. */
  id: z.string(),
  /** Monotonic revision from the requester; stale chunks are dropped. */
  revision: z.number().int().nonnegative(),
  /** Present on the first chunk of a result set. */
  columns: z.array(ColumnMeta).optional(),
  rows: z.custom<unknown[][]>(
    (v) => Array.isArray(v) && (v.length === 0 || Array.isArray((v as unknown[])[0])),
    { message: 'rows must be an array of arrays' },
  ),
  /** 0-based index of this chunk within the request. */
  chunkIndex: z.number().int().nonnegative(),
  done: z.boolean().default(false),
  truncated: z.boolean().optional(),
  notices: z.array(PgNotice).optional(),
});
export type QueryChunk = z.infer<typeof QueryChunk>;

// ─── Schema introspection ────────────────────────────────────────────

export const SchemaInfo = z.object({
  schemas: z.array(z.object({ name: z.string() })),
  tables: z.array(
    z.object({
      schema: z.string(),
      name: z.string(),
      kind: z.enum(['table', 'view', 'matview', 'foreign', 'partitioned']),
      rowCountEstimate: z.number().nullable(),
      /**
       * Set on partition children: the partitioned parent. The sidebar
       * nests these under their parent instead of listing them flat.
       */
      partitionOf: z.object({ schema: z.string(), name: z.string() }).nullable().optional(),
      /**
       * SQLite: a rowid table without a declared primary key. Holds the name
       * of the implicit row-id column (`rowid`, `_rowid_` or `oid`, whichever
       * is not shadowed by a real column); row edits and deletes address rows
       * through it.
       */
      implicitRowid: z.string().optional(),
      /**
       * Engine-specific facts shown in the structure view (ClickHouse engine,
       * sorting / partition key, TTL; DuckDB source file and format).
       */
      details: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
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
      /** DEFAULT expression text (pg_get_expr); omitted by older drivers / snapshots. */
      defaultExpr: z.string().nullable().optional(),
      /** GENERATED … AS IDENTITY flavour, when the column is an identity column. */
      identity: z.enum(['always', 'by default']).nullable().optional(),
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
        /** Constraint name — groups the rows of a composite FK. */
        constraint: z.string().optional(),
        onDelete: z
          .enum(['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'])
          .optional(),
        onUpdate: z
          .enum(['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'])
          .optional(),
      }),
    )
    .default([]),
  /** Indexes of introspected tables (R-10); older snapshots / drivers may omit this. */
  indexes: z
    .array(
      z.object({
        schema: z.string(),
        table: z.string(),
        name: z.string(),
        /** Full `CREATE [UNIQUE] INDEX …` text from pg_get_indexdef. */
        definition: z.string(),
        unique: z.boolean().default(false),
        primary: z.boolean().default(false),
      }),
    )
    .optional(),
  /** Triggers (SQLite / MySQL); Postgres keeps them in the DDL view. */
  triggers: z
    .array(
      z.object({
        schema: z.string(),
        table: z.string(),
        name: z.string(),
        /** `CREATE TRIGGER …` text when the engine stores it. */
        definition: z.string().optional(),
      }),
    )
    .optional(),
  /** Functions and procedures (extension-owned routines excluded). */
  routines: z
    .array(
      z.object({
        schema: z.string(),
        name: z.string(),
        kind: z.enum(['function', 'procedure']),
        /** Identity argument list, e.g. `a integer, b text` — needed to address overloads. */
        args: z.string(),
        returns: z.string().nullable(),
        oid: z.number().int(),
      }),
    )
    .default([]),
  sequences: z.array(z.object({ schema: z.string(), name: z.string() })).default([]),
  /** User-defined enum / composite / domain / range types. */
  types: z
    .array(
      z.object({
        schema: z.string(),
        name: z.string(),
        kind: z.enum(['enum', 'composite', 'domain', 'range']),
        /** Enum labels in sort order (enum types only). */
        values: z.array(z.string()).optional(),
      }),
    )
    .default([]),
  extensions: z
    .array(z.object({ name: z.string(), schema: z.string(), version: z.string() }))
    .default([]),
});
export type SchemaInfo = z.infer<typeof SchemaInfo>;

/** A saved schema snapshot without its schema payload (R-18). */
export const SchemaSnapshotMeta = z.object({
  id: z.string(),
  connectionId: z.string().nullable(),
  connectionName: z.string(),
  name: z.string(),
  createdAt: z.number(),
});
export type SchemaSnapshotMeta = z.infer<typeof SchemaSnapshotMeta>;

export const SchemaSnapshotSaveRequest = SchemaSnapshotMeta.omit({
  id: true,
  createdAt: true,
}).extend({
  schema: SchemaInfo,
});
export type SchemaSnapshotSaveRequest = z.infer<typeof SchemaSnapshotSaveRequest>;

/**
 * Scope of an introspection request (F16 / PC4). Omitted fields mean
 * "everything", so the bare `introspect()` stays a full snapshot.
 */
export const IntrospectOpts = z.object({
  /** Include schemas, tables, routines, sequences, types, extensions. Default true. */
  objects: z.boolean().optional(),
  /** Include columns + foreign keys. Default true. */
  columns: z.boolean().optional(),
  /** Restrict columns + foreign keys to these schemas. */
  columnSchemas: z.array(z.string()).optional(),
});
export type IntrospectOpts = z.infer<typeof IntrospectOpts>;

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

/** Server-side history list filters (U35). */
export const HistoryStatusFacet = z.enum(['all', 'ok', 'error']);
export type HistoryStatusFacet = z.infer<typeof HistoryStatusFacet>;

export const HistoryDurationFacet = z.enum(['all', 'fast', 'medium', 'slow']);
export type HistoryDurationFacet = z.infer<typeof HistoryDurationFacet>;

export const HistoryListOpts = z.object({
  limit: z.number().int().positive().max(5000).optional(),
  connectionId: z.string().optional(),
  search: z.string().optional(),
  status: HistoryStatusFacet.optional(),
  duration: HistoryDurationFacet.optional(),
});
export type HistoryListOpts = z.infer<typeof HistoryListOpts>;

// ─── Transaction state ───────────────────────────────────────────────

export const TxnState = z.enum(['none', 'active', 'error']);
export type TxnState = z.infer<typeof TxnState>;

/**
 * Renderer → main payload for `query.commitEditBatch` (C7). Contract with
 * the grid: one parameterised UPDATE per edit (or per row); params are the
 * Postgres text form of each value, or `null` for SQL NULL — never JS
 * Dates or objects. Each statement must affect exactly one row.
 */
export const EditStatementKind = z.enum(['update', 'delete', 'insert']);

/**
 * A statement of a grid edit batch that could not be applied because the data
 * moved under the user (B1): an UPDATE / DELETE matched no row (changed or gone
 * since the grid loaded it; the statements carry the original values in their
 * WHERE), or an INSERT collided with an existing key. When any exist the whole
 * batch was rolled back.
 */
export const EditConflict = z.object({
  index: z.number().int().nonnegative(),
  reason: z.enum(['no-match', 'duplicate']),
});
export type EditConflict = z.infer<typeof EditConflict>;

export const CommitEditBatchRequest = z.object({
  connectionGen: z.number().int().nonnegative(),
  updates: z
    .array(
      z.object({
        sql: z.string().min(1),
        params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
        label: z.string().max(500).optional(),
        kind: EditStatementKind.optional(),
      }),
    )
    .min(1),
});
export type CommitEditBatchRequest = z.infer<typeof CommitEditBatchRequest>;

/** Renderer → main payload for `query.explain` (F2). */
export const ExplainRequest = z.object({
  sql: z.string().min(1),
  analyze: z.boolean(),
  /** Bind parameters for `$n` placeholders (query variables). */
  params: z.array(z.unknown()).optional(),
});
export type ExplainRequest = z.infer<typeof ExplainRequest>;

// ─── Safe Run (dry run for writes) ───────────────────────────────────

/** Default review window before a pending Safe Run rolls itself back. */
export const SAFE_RUN_DEFAULT_TIMEOUT_SEC = 300;
/** Default row count above which Safe Run warns and Commit turns destructive. */
export const SAFE_RUN_DEFAULT_ROW_THRESHOLD = 1000;
/** Rows kept per side (before / after) in a Safe Run report. */
export const SAFE_RUN_ROW_CAP = 500;

/** Renderer → main payload for `query.safeRun`. */
export const SafeRunStartRequest = z.object({
  sql: z.string().min(1),
  connectionGen: z.number().int().nonnegative(),
  /** Seconds the transaction may stay open awaiting Commit / Roll back. */
  timeoutSec: z.number().int().min(5).max(3600).optional(),
  /** Ask the planner for a row estimate first (plain EXPLAIN, never ANALYZE). */
  explain: z.boolean().optional(),
});
export type SafeRunStartRequest = z.infer<typeof SafeRunStartRequest>;

export const SafeRunFinishRequest = z.object({
  runId: z.string().min(1),
  action: z.enum(['commit', 'rollback']),
});
export type SafeRunFinishRequest = z.infer<typeof SafeRunFinishRequest>;

/** How BEFORE rows are matched to AFTER rows. */
export const SafeRunKeyKind = z.enum(['pk', 'unique', 'ctid', 'none']);
export type SafeRunKeyKind = z.infer<typeof SafeRunKeyKind>;

/** What a Safe Run changed, held open in a transaction awaiting a decision. */
export const SafeRunReport = z.object({
  runId: z.string(),
  kind: z.enum(['insert', 'update', 'delete', 'merge', 'cte']),
  statement: z.string(),
  /** Savepoint inside the user's own transaction rather than a new BEGIN. */
  nested: z.boolean(),
  /** Rows the statement reported affecting. */
  affected: z.number().int().nonnegative(),
  /** False when the statement returned more rows than were counted. */
  affectedExact: z.boolean(),
  /** Planner row estimate for the statement, when asked for and available. */
  estimateRows: z.number().nullable(),
  /** `diff` pairs BEFORE with AFTER; `after-only` shows what the statement returned. */
  mode: z.enum(['diff', 'after-only']),
  /** Why only AFTER rows are shown, or other caveats worth surfacing. */
  note: z.string().nullable(),
  keyKind: SafeRunKeyKind,
  keyColumns: z.array(z.string()),
  /** Table columns of the BEFORE rows. */
  beforeColumns: z.array(ColumnMeta),
  before: z.array(z.array(z.unknown())).nullable(),
  /** Physical row ids aligned with `before` (only for `keyKind: 'ctid'`). */
  beforeCtids: z.array(z.string()).nullable(),
  beforeTotal: z.number().int().nonnegative(),
  afterColumns: z.array(ColumnMeta),
  after: z.array(z.array(z.unknown())),
  afterCtids: z.array(z.string()).nullable(),
  afterTotal: z.number().int().nonnegative(),
  durationMs: z.number(),
  /** Epoch ms at which the worker rolls the transaction back by itself. */
  expiresAt: z.number(),
  timeoutSec: z.number().int(),
  txnState: z.enum(['none', 'active', 'error']),
});
export type SafeRunReport = z.infer<typeof SafeRunReport>;

export const SafeRunOutcome = z.object({
  runId: z.string(),
  outcome: z.enum(['committed', 'rolledBack']),
  /** Why a roll back happened without the user asking (timeout, disconnect). */
  reason: z.enum(['user', 'timeout', 'disconnect']).optional(),
  txnState: z.enum(['none', 'active', 'error']),
});
export type SafeRunOutcome = z.infer<typeof SafeRunOutcome>;

// ─── Worker messages (main ↔ utilityProcess) ────────────────────────

export const WorkerRequest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ping'), id: z.string(), message: z.string() }),
  z.object({
    kind: z.literal('connect'),
    id: z.string(),
    config: ConnectionConfig,
    /** Applied as PG statement_timeout after connect (U20). */
    statementTimeoutMs: z.number().int().nonnegative().optional(),
  }),
  z.object({ kind: z.literal('testConnect'), id: z.string(), config: ConnectionConfig }),
  z.object({ kind: z.literal('disconnect'), id: z.string() }),
  z.object({
    kind: z.literal('query'),
    id: z.string(),
    sql: z.string(),
    params: z.array(z.unknown()).optional(),
    /** Request revision for chunk events (U15); stale chunks are ignored. */
    revision: z.number().int().nonnegative().optional(),
    /** Editor row limit — stop reading the cursor after this many rows. */
    maxRows: z.number().int().positive().optional(),
    /** Retained-bytes cap for this result; the worker clamps it to 256 MiB (P2-3). */
    maxBytes: z.number().int().positive().optional(),
    /** Transaction mode: BEGIN first when the session is idle (F9). */
    autoBegin: z.boolean().optional(),
  }),
  z.object({ kind: z.literal('cancel'), id: z.string() }),
  /**
   * EXPLAIN one statement on the primary. With `analyze`, the statement
   * runs inside BEGIN … ROLLBACK (or SAVEPOINT … ROLLBACK TO when a user
   * transaction is open), so nothing it changes is kept (F2).
   */
  z.object({
    kind: z.literal('explain'),
    id: z.string(),
    sql: z.string().min(1),
    analyze: z.boolean(),
    params: z.array(z.unknown()).optional(),
  }),
  z.object({ kind: z.literal('introspect'), id: z.string(), opts: IntrospectOpts.optional() }),
  z.object({ kind: z.literal('beginTxn'), id: z.string() }),
  z.object({ kind: z.literal('commitTxn'), id: z.string() }),
  z.object({ kind: z.literal('rollbackTxn'), id: z.string() }),
  /**
   * Safe Run: run one INSERT / UPDATE / DELETE / MERGE inside a held-open
   * transaction (or savepoint) and report what it changed. A write kind;
   * never replayed after a reconnect.
   */
  z.object({
    kind: z.literal('safeRunStart'),
    id: z.string(),
    sql: z.string().min(1),
    connectionGen: z.number().int().nonnegative(),
    timeoutSec: z.number().int().min(5).max(3600).optional(),
    explain: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('safeRunFinish'),
    id: z.string(),
    runId: z.string().min(1),
    action: z.enum(['commit', 'rollback']),
  }),
  /**
   * Grid edit batch (C7). Each update must affect exactly one row; any
   * other rowCount (or a Postgres error) rolls the whole batch back.
   * Params are text or null — Postgres casts them to the column type.
   * `label` names the edit in error messages (e.g. `public.users id=5 → email`).
   */
  z.object({
    kind: z.literal('commitEditBatch'),
    id: z.string(),
    connectionGen: z.number().int().nonnegative(),
    updates: z
      .array(
        z.object({
          sql: z.string().min(1),
          params: z.array(z.unknown()).optional(),
          label: z.string().optional(),
          kind: EditStatementKind.optional(),
        }),
      )
      .min(1),
  }),
  // Aux query — runs on the dedicated aux connection (AI/monitor) so it
  // never shares a session with cancel. Cancel uses a separate control
  // client (U19).
  z.object({
    kind: z.literal('sidebandQuery'),
    id: z.string(),
    sql: z.string(),
    params: z.array(z.unknown()).optional(),
    revision: z.number().int().nonnegative().optional(),
    /** Per-statement timeout for Plasma's own metadata/lookup queries (F12). */
    timeoutMs: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal('aiQuery'),
    id: z.string(),
    sql: z.string(),
    params: z.array(z.unknown()).optional(),
    /** Result Compare: keep more than the agent's default cap. */
    maxRows: z.number().int().positive().max(200_000).optional(),
  }),
  // Result Compare on another saved connection: a throwaway read-only driver,
  // one read-only statement, then gone. Never touches the live session.
  z.object({
    kind: z.literal('compareQuery'),
    id: z.string(),
    config: ConnectionConfig,
    sql: z.string(),
    maxRows: z.number().int().positive().max(200_000),
    /** Names this run so `compareCancel` (and a deadline) can stop it. */
    runId: z.string(),
  }),
  z.object({ kind: z.literal('compareCancel'), id: z.string(), runId: z.string() }),
  // LISTEN/NOTIFY tail: a dedicated listener connection, never the primary.
  z.object({ kind: z.literal('pgListen'), id: z.string(), channel: z.string().min(1) }),
  z.object({ kind: z.literal('pgUnlisten'), id: z.string(), channel: z.string().min(1) }),
  z.object({
    kind: z.literal('pgNotify'),
    id: z.string(),
    channel: z.string().min(1),
    payload: z.string().default(''),
  }),
  // Apply PG statement_timeout on primary + aux (U20). 0 disables.
  z.object({
    kind: z.literal('setStatementTimeout'),
    id: z.string(),
    timeoutMs: z.number().int().nonnegative(),
  }),
  // ── Redis ops ──
  z.object({
    kind: z.literal('redisScan'),
    id: z.string(),
    cursor: z.string().default('0'),
    match: z.string().optional(),
    count: z.number().int().positive().max(10000).default(500),
    db: z.number().int().nonnegative().optional(),
    /**
     * Keep calling SCAN until this many keys matched or the cursor ends
     * (R8/F10) — a MATCH page is otherwise often empty mid-keyspace.
     */
    minResults: z.number().int().positive().max(10000).optional(),
    /** Time budget for the SCAN loop in ms (default 1500). */
    budgetMs: z.number().int().positive().max(30000).optional(),
    /** SCAN … TYPE filter (Redis ≥ 6). */
    type: z.string().optional(),
  }),
  z.object({
    kind: z.literal('redisGetKey'),
    id: z.string(),
    key: z.string(),
    opts: RedisGetKeyOpts.optional(),
  }),
  z.object({
    kind: z.literal('redisDeleteKey'),
    id: z.string(),
    key: z.string(),
    db: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal('redisSetTtl'),
    id: z.string(),
    key: z.string(),
    /** TTL in seconds. Pass 0 or negative to PERSIST (clear TTL). */
    seconds: z.number().int(),
    db: z.number().int().nonnegative().optional(),
    /**
     * `expire` (seconds, default), `pexpire` (ms in `seconds`), `expireat`
     * (unix seconds in `seconds`) or `persist` (R22).
     */
    mode: z.enum(['expire', 'pexpire', 'expireat', 'persist']).optional(),
  }),
  z.object({
    kind: z.literal('redisCommand'),
    id: z.string(),
    /** Already-tokenized command; the renderer splits by whitespace. */
    parts: z.array(z.string()).min(1),
    /** Database the CLI prompt is on (R5). */
    db: z.number().int().nonnegative().optional(),
  }),
  /** Delete every key matching a pattern via SCAN + UNLINK (R26). */
  z.object({
    kind: z.literal('redisDeleteByPattern'),
    id: z.string(),
    match: z.string().min(1),
    db: z.number().int().nonnegative().optional(),
    /** Count + sample only; nothing is deleted. */
    dryRun: z.boolean().default(true),
    /** Stop after this many matches. */
    limit: z.number().int().positive().max(1_000_000).default(100_000),
  }),
  /** Abort the running analyzer / pattern delete / blocking CLI command. */
  z.object({ kind: z.literal('redisCancel'), id: z.string() }),
  z.object({ kind: z.literal('redisOverview'), id: z.string() }),
  z.object({
    kind: z.literal('redisAnalyze'),
    id: z.string(),
    /** SCAN cap. Default 5000 — enough to surface pareto winners without
     *  hammering production. */
    sampleCap: z.number().int().positive().max(50000).default(5000),
    match: z.string().optional(),
    db: z.number().int().nonnegative().optional(),
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
    db: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal('redisWrite'),
    id: z.string(),
    op: RedisWriteOp,
    db: z.number().int().nonnegative().optional(),
  }),
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
    /** Per-request timeout; 0/absent = the connection default (O6). */
    timeoutMs: z.number().int().nonnegative().optional(),
    /** Renderer-chosen id so `osCancel` can abort this request (O6). */
    requestId: z.string().optional(),
  }),
  z.object({
    kind: z.literal('osSql'),
    id: z.string(),
    /** Empty only when `cursor` fetches the next page. */
    query: z.string(),
    fetchSize: z.number().int().positive().max(10000).optional(),
    cursor: z.string().optional(),
    timeoutMs: z.number().int().nonnegative().optional(),
    requestId: z.string().optional(),
  }),
  /** Arbitrary REST call (Dev Tools console, doc CRUD, index/cluster ops — O13–O17). */
  z.object({
    kind: z.literal('osRequest'),
    id: z.string(),
    method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH']),
    path: z.string().min(1),
    body: z.string().optional(),
    timeoutMs: z.number().int().nonnegative().optional(),
    requestId: z.string().optional(),
  }),
  z.object({ kind: z.literal('osCancel'), id: z.string(), requestId: z.string() }),
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
    /** Optional DSL `query` object (JSON) — wins over queryString (O2). */
    query: z.string().optional(),
    /** Lets `osCancel` abort the stats (P2-14). */
    requestId: z.string().optional(),
    timeoutMs: z.number().int().nonnegative().optional(),
  }),
  // ── Export (U16) ──
  z.object({
    kind: z.literal('exportRows'),
    id: z.string(),
    jobId: z.string().optional(),
    csv: CsvExportOptions.optional(),
    format: ExportFormat,
    filePath: z.string().min(1),
    columns: z.array(ColumnMeta),
    rows: z.array(z.array(z.unknown())),
    targetTable: z.string().optional(),
  }),
  /** Stop a running export (C30); the partial file is removed. */
  z.object({ kind: z.literal('exportCancel'), id: z.string(), jobId: z.string() }),
  /** Stop whatever is running on the aux connection (AI tool query, monitor lookup). */
  z.object({ kind: z.literal('cancelAux'), id: z.string() }),
  /** SQLite: copy the open database to `filePath` with the online backup API. */
  z.object({ kind: z.literal('sqliteBackup'), id: z.string(), filePath: z.string().min(1) }),
  z.object({
    kind: z.literal('exportQuery'),
    id: z.string(),
    jobId: z.string().optional(),
    csv: CsvExportOptions.optional(),
    format: ExportFormat,
    filePath: z.string().min(1),
    sql: z.string().min(1),
    params: z.array(z.unknown()).optional(),
    targetTable: z.string().optional(),
  }),
  // ── Structure editing + import ──
  z.object({ kind: z.literal('applyDdl'), id: z.string(), request: DdlApplyRequest }),
  z.object({ kind: z.literal('importRun'), id: z.string(), job: ImportJobSpec }),
  z.object({ kind: z.literal('importCancel'), id: z.string(), jobId: z.string() }),
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
    connectionGen: z.number().int().nonnegative().optional(),
    /** OpenSearch test connect: green / yellow / red, when the cluster said. */
    clusterStatus: z.string().nullable().optional(),
  }),
  z.object({ kind: z.literal('disconnected'), id: z.string() }),
  z.object({ kind: z.literal('queryResult'), id: z.string(), result: QueryResult }),
  z.object({
    kind: z.literal('cancelled'),
    id: z.string(),
    /** False when nothing was in flight. */
    delivered: z.boolean().optional(),
    /** The cancel was attempted and the server did not confirm it. */
    failed: z.boolean().optional(),
  }),
  /** Worker process finished bootstrapping and can accept requests (U20). */
  z.object({ kind: z.literal('ready'), id: z.string() }),
  z.object({ kind: z.literal('statementTimeoutSet'), id: z.string() }),
  z.object({ kind: z.literal('schemaInfo'), id: z.string(), info: SchemaInfo }),
  z.object({ kind: z.literal('txnState'), id: z.string(), state: TxnState }),
  z.object({ kind: z.literal('safeRunReport'), id: z.string(), report: SafeRunReport }),
  z.object({ kind: z.literal('safeRunDone'), id: z.string(), outcome: SafeRunOutcome }),
  z.object({
    kind: z.literal('editBatchResult'),
    id: z.string(),
    state: TxnState,
    applied: z.number().int().nonnegative(),
    /** Present when rows changed under the edit: the batch was rolled back, `applied` is 0. */
    conflicts: z.array(EditConflict).optional(),
  }),
  /**
   * `fatal: 'connection-lost'` means the driver's transport is gone (VPN
   * drop, sleep, network switch), not that the statement was bad. Main
   * reconnects once and retries the request (U27).
   */
  z.object({
    kind: z.literal('error'),
    id: z.string(),
    message: z.string(),
    /** The codes the error carried (SQLSTATE, errno, status...): what the diagnosis classifies by. */
    info: ErrorInfoSchema.optional(),
    fatal: z.literal(CONNECTION_LOST).optional(),
    /** The transport died while a transaction was open — its work is gone (C5). */
    txnLost: z.boolean().optional(),
    /** Notices a failed statement raised before it errored (P2-6). */
    notices: z.array(PgNotice).optional(),
  }),
  z.object({ kind: z.literal('redisScan'), id: z.string(), result: RedisScanResult }),
  z.object({ kind: z.literal('redisKey'), id: z.string(), result: RedisKeyValue }),
  z.object({ kind: z.literal('redisOverview'), id: z.string(), info: RedisOverview }),
  z.object({ kind: z.literal('redisCommand'), id: z.string(), result: RedisCommandResult }),
  z.object({ kind: z.literal('redisAck'), id: z.string() }),
  z.object({ kind: z.literal('redisBulkDelete'), id: z.string(), result: RedisBulkDeleteResult }),
  z.object({
    kind: z.literal('redisPatternDelete'),
    id: z.string(),
    result: RedisPatternDeleteResult,
  }),
  z.object({ kind: z.literal('redisAnalyze'), id: z.string(), result: RedisAnalyzeResult }),
  z.object({
    kind: z.literal('redisSlowlog'),
    id: z.string(),
    entries: z.array(RedisSlowlogEntry),
  }),
  /**
   * Pub/sub message broadcast — not request-correlated. The id is a
   * constant `'pubsub-event'` sentinel so the supervisor can route it
   * to a separate handler instead of trying to resolve a pending promise.
   */
  z.object({ kind: z.literal('redisPubsub'), id: z.string(), message: RedisPubsubMessage }),
  /**
   * Cursor-stream chunk broadcast — not the final queryResult.
   * Supervisor routes by kind to the broadcast handler (like redisPubsub).
   * `id` is the originating request id so the renderer can apply revision checks.
   */
  QueryChunk,
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
  z.object({ kind: z.literal('osResponse'), id: z.string(), response: OsRawResponse }),
  z.object({ kind: z.literal('pgNotice'), id: z.string(), notice: PgNotice }),
  /** LISTEN/NOTIFY broadcast — not request-correlated (sentinel id). */
  z.object({ kind: z.literal('pgNotification'), id: z.string(), notification: PgNotification }),
  z.object({ kind: z.literal('pgListenAck'), id: z.string() }),
  z.object({
    kind: z.literal('exportDone'),
    id: z.string(),
    filePath: z.string(),
    rowCount: z.number().int().nonnegative(),
    bytesWritten: z.number().int().nonnegative(),
  }),
  z.object({ kind: z.literal('ddlResult'), id: z.string(), result: DdlApplyResult }),
  z.object({
    kind: z.literal('sqliteBackupDone'),
    id: z.string(),
    filePath: z.string(),
    bytes: z.number().int().nonnegative(),
  }),
  z.object({ kind: z.literal('importResult'), id: z.string(), result: ImportResult }),
  /** Export progress broadcast (C30) — not request-correlated. */
  z.object({ kind: z.literal('exportProgress'), id: z.string(), progress: ExportProgress }),
  /** Import progress broadcast — not request-correlated (like pgNotice). */
  z.object({ kind: z.literal('importProgress'), id: z.string(), progress: ImportProgress }),
]);
export type WorkerResponse = z.infer<typeof WorkerResponse>;

// ─── Settings (keyed values in SQLite) ───────────────────────────────

/** A typed query-variable value (see `@shared/sql-variables`). */
export const SavedVariableValue = z.object({
  mode: z.enum(['text', 'number', 'date', 'boolean', 'null', 'raw']),
  value: z.string().max(10_000),
});
export type SavedVariableValue = z.infer<typeof SavedVariableValue>;

/** A user-written editor snippet. `body` uses Monaco snippet syntax (`$1`, `${2:name}`). */
export const UserSnippetShape = z.object({
  id: z.string(),
  name: z.string().min(1).max(120),
  /** Typed in the editor to trigger the completion. */
  prefix: z.string().min(1).max(40),
  description: z.string().max(300).default(''),
  body: z.string().max(50_000),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type UserSnippet = z.infer<typeof UserSnippetShape>;

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
      'github',
      'nord',
      'solarized',
      'gruvbox',
      'tokyo-night',
      'rose-pine',
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
  /** Right sidebar (Details / Assistant) width in px. */
  rightSidebarWidth: z.number().int().min(240).max(720).default(300),
  editorExpanded: z.boolean().default(false),
  editorFontSize: z.number().int().min(10).max(24).default(13),
  /**
   * Pixel height of the inline SQL editor when the result grid is also
   * visible. Drives the draggable divider between editor and grid;
   * clamped at run-time to a sane window-relative range.
   */
  editorHeightPx: z.number().int().min(120).max(1200).default(280),
  defaultPageSize: z.number().int().positive().default(50),
  queryTimeoutMs: z.number().int().nonnegative().default(0), // 0 = no timeout
  // ── Settings added by the Settings reorganisation (SS3) ──
  /** Reopen the last session's SQL tabs (per connection) on launch. */
  restoreWorkspace: z.boolean().catch(true).default(true),
  /**
   * Default safe-mode level for connections without their own choice:
   * `off` (no prompts), `confirm-dangerous` (DROP / TRUNCATE / unqualified
   * DELETE / UPDATE ask first), `confirm-writes` (every write asks),
   * `confirm-all` (every statement asks), `read-only` (writes refused). A PROD tag always confirms.
   */
  safeModeDefault: z
    .enum(['off', 'confirm-dangerous', 'confirm-writes', 'confirm-all', 'read-only'])
    .catch('confirm-dangerous')
    .default('confirm-dangerous'),
  /** Per-connection safe-mode override, keyed by connection id. */
  connectionSafeMode: z
    .record(
      z.string(),
      z.enum(['off', 'confirm-dangerous', 'confirm-writes', 'confirm-all', 'read-only']),
    )
    .catch({})
    .default({}),
  /**
   * Per-connection "Always Safe Run writes": a normal Run of INSERT /
   * UPDATE / DELETE / MERGE goes through Safe Run. Absent = on for
   * connections tagged Prod, off otherwise.
   */
  connectionAlwaysSafeRun: z.record(z.string(), z.boolean()).catch({}).default({}),
  /** Safe Run warns, and Commit turns destructive, above this many rows. */
  safeRunRowThreshold: z.number().int().positive().catch(1000).default(1000),
  /** Seconds a Safe Run may wait for Commit / Roll back before it rolls itself back. */
  safeRunTimeoutSec: z.number().int().min(5).max(3600).catch(300).default(300),
  /** Migration linter on DDL (Preview SQL panels, SQL editor squiggles, Check migration). */
  migrationLintEnabled: z.boolean().catch(true).default(true),
  /** Hide findings below this severity. */
  migrationLintMinSeverity: z.enum(['info', 'warn', 'error']).catch('info').default('info'),
  /** Migration-lint rule ids the user muted. */
  migrationLintMuted: z.array(z.string()).catch([]).default([]),
  /** Defaults for CSV export (the export dialog starts from these). */
  csvExport: CsvExportOptions.catch({
    delimiter: ',',
    header: true,
    quote: '"',
    nullAs: 'empty',
    lineEnding: 'lf',
  }).default({}),
  /** Zebra-stripe result grid rows. */
  gridAlternatingRows: z.boolean().catch(true).default(true),
  /**
   * Table tabs show `pg_class.reltuples` instead of running `count(*)`
   * when the estimate is above this many rows. 0 = always count exactly.
   */
  estimatedCountThreshold: z.number().int().nonnegative().catch(100_000).default(100_000),
  /**
   * Cap on the data one query result keeps in memory, in MB (default 32,
   * at most 256). A result past it is cut and shown as truncated (P2-3).
   */
  resultMaxMegabytes: z.number().int().min(1).max(256).catch(32).optional(),
  telemetryEnabled: z.boolean().optional(),
  /**
   * AI provider config. Plasma uses OpenRouter as the unified gateway —
   * one key gives access to Claude, GPT, Gemini, Qwen, etc. Key stored
   * in plain SQLite (not safeStorage) to keep the AI stack portable;
   * OpenRouter keys are revocable + scoped, unlike a personal API key.
   */
  openrouterApiKey: z.string().default(''),
  hasOpenrouterApiKey: z.boolean().optional(),
  openrouterModel: z.string().default('anthropic/claude-sonnet-5.5'),
  /** Model ids starred in the picker. */
  aiFavoriteModels: z.array(z.string()).catch([]).default([]),
  /** The last 5 models used, newest first. */
  aiRecentModels: z.array(z.string()).catch([]).default([]),
  /** Where AI requests go: OpenRouter (key) or a model server on this machine (Ollama, LM Studio). */
  aiProvider: z.enum(['openrouter', 'local']).catch('openrouter').default('openrouter'),
  /** Base URL of a local OpenAI-compatible server; main only talks to loopback addresses. */
  aiLocalUrl: z.string().default('http://127.0.0.1:11434/v1'),
  aiLocalModel: z.string().default(''),
  /** Agent: apply "show table" view changes without asking (writes and queries still ask). */
  aiAutoApplyViews: z.boolean().catch(false).default(false),
  /** Legacy field kept for backwards compat with v0.0.10 settings rows. */
  claudeApiKey: z.string().default(''),
  hasClaudeApiKey: z.boolean().optional(),
  transactionMode: z.boolean().default(false),
  /** Folder holding pg_dump / pg_restore / psql; empty = look on PATH. */
  pgBinDir: z.string().default(''),
  /** Connect to `lastConnectionId` when Plasma starts. */
  autoConnectOnLaunch: z.boolean().default(true),
  /** Retry with backoff when a live connection drops and can't be recovered. */
  autoReconnect: z.boolean().default(true),
  /**
   * Saved connection used most recently. Cleared by an explicit
   * Disconnect so a deliberate disconnect is never undone on relaunch.
   */
  lastConnectionId: z.string().nullable().default(null),
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
  connectionAiRowData: z.record(z.string(), z.boolean()).optional(),
  /** SC-20: send schema names / sample keys to the AI provider (default on; prod needs the per-connection opt-in). */
  aiSendSchema: z.boolean().optional(),
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
        /** Private key file on disk (not a secret; read at connect time). */
        privateKeyPath: z.string().default(''),
        /** Authenticate through the running ssh-agent (SSH_AUTH_SOCK / Pageant). */
        useAgent: z.boolean().default(false),
        hasPassword: z.boolean().optional(),
        hasPrivateKey: z.boolean().optional(),
        hasPassphrase: z.boolean().optional(),
      }),
    )
    .default({}),
  sshKnownHosts: z
    .record(
      z.string(),
      z.object({
        host: z.string(),
        port: z.number().int().positive().max(65535),
        key: z.string().min(1),
        type: z.string().optional(),
        addedAt: z.number().int().nonnegative(),
      }),
    )
    .optional(),
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
   * Saved Result Compare definitions (queries, connections, keys, ignore
   * rules). Validated on read by `parseSavedComparison`; a bad entry is dropped.
   */
  savedComparisons: z.array(z.unknown()).optional(),
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
            /** Sidebar folder (PC6). Omitted = ungrouped. */
            folder: z.string().optional(),
            favorite: z.boolean().optional(),
            createdAt: z.number(),
            updatedAt: z.number(),
            sql: z.string(),
            /** Last-used query variable values (`:name`, `$name`), restored on open. */
            variables: z.record(z.string(), SavedVariableValue).optional(),
            pageSize: z.number().int().positive().default(50),
          }),
          z.object({
            kind: z.literal('table'),
            id: z.string(),
            name: z.string(),
            folder: z.string().optional(),
            favorite: z.boolean().optional(),
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
  /** User snippets (Monaco snippet syntax); shown in completions by prefix. */
  snippets: z.array(UserSnippetShape).default([]),
  /** Per-variable recent values for the Variables bar, newest first. */
  variableHistory: z.record(z.string(), z.array(z.string())).default({}),
  /** Presentation mode: mask sensitive columns on screen, in the clipboard and in AI context. */
  presentationMode: z.boolean().catch(false).default(false),
  maskStyle: z.enum(['initial', 'last4', 'full']).catch('initial').default('initial'),
  /** Per-connection column overrides for the masking detectors (lower-case names). */
  maskRules: z
    .record(
      z.string(),
      z.object({
        sensitive: z.array(z.string().max(200)).max(500).default([]),
        plain: z.array(z.string().max(200)).max(500).default([]),
      }),
    )
    .catch({})
    .default({}),
  /** Audit every statement on every connection, not only Prod-tagged ones. */
  auditAllConnections: z.boolean().catch(false).default(false),
  /** Days the local audit log keeps rows. */
  auditRetentionDays: z.number().int().min(1).max(3650).catch(90).default(90),
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
export const AiContentPart = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('image_url'),
    // Data URLs only: nothing in Plasma fetches a remote image for the model.
    image_url: z.object({
      url: z
        .string()
        .max(AI_MAX_IMAGE_DATA_URL)
        .refine(isAiImageDataUrl, 'Only png, jpeg, webp or gif data URLs are allowed'),
    }),
  }),
]);
export type AiContentPart = z.infer<typeof AiContentPart>;

export const AiMessage = z
  .object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.union([z.string(), z.array(AiContentPart)]),
  })
  .superRefine((m, ctx) => {
    const n = countImages(m.content);
    if (n > 0 && m.role !== 'user') {
      ctx.addIssue({ code: 'custom', message: 'Only user messages can carry images' });
    }
    if (n > AI_MAX_IMAGES_PER_MESSAGE) {
      ctx.addIssue({
        code: 'custom',
        message: `At most ${AI_MAX_IMAGES_PER_MESSAGE} images per message`,
      });
    }
  });
export type AiMessage = z.infer<typeof AiMessage>;

export const AiChatRequest = z.object({
  /** Stable id per-chat so renderer can correlate streamed deltas + cancel. */
  requestId: z.string(),
  messages: z
    .array(AiMessage)
    .refine(
      (ms) => ms.reduce((n, m) => n + countImages(m.content), 0) <= AI_MAX_IMAGES_PER_REQUEST,
      `At most ${AI_MAX_IMAGES_PER_REQUEST} images per request`,
    ),
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
  /**
   * One-shot assistant task (Fix with AI, Explain plan, NL filter). Main
   * swaps in the task's system prompt (see `@shared/ai-tasks`) and never
   * offers row-data tools; the schema is still gated by `aiSendSchema`.
   */
  task: z.enum(['fix-sql', 'explain-plan', 'nl-filter', 'nl-view']).optional(),
  /**
   * Agent turn (AI panel): on a SQL engine the model may propose actions on
   * the workbench. Each one waits for the user's click in the renderer.
   */
  agent: z.boolean().optional(),
  /** What the user is looking at (built by the renderer); sent only when schema sharing is allowed. */
  context: z.string().max(8000).optional(),
});
export type AiChatRequest = z.infer<typeof AiChatRequest>;

export const AiListModelsRequest = z.object({ refresh: z.boolean().optional() });
export type AiListModelsRequest = z.infer<typeof AiListModelsRequest>;
export type { AiModel, AiModelsResult };

/** What the agent can ask the workbench to do (each needs the user's approval). */
export const AgentActionName = z.enum([
  'show_table',
  'run_query',
  'propose_change',
  'open_in_editor',
]);
export type AgentActionName = z.infer<typeof AgentActionName>;

export type AiChatEvent =
  | { kind: 'delta'; requestId: string; text: string }
  | { kind: 'done'; requestId: string }
  | { kind: 'error'; requestId: string; message: string }
  | {
      kind: 'action';
      requestId: string;
      callId: string;
      name: AgentActionName;
      args: Record<string, unknown>;
    };

/** The renderer's answer to an `action` event; main feeds it back to the model. */
export const AiActionResult = z.object({
  requestId: z.string(),
  callId: z.string(),
  outcome: z.enum(['applied', 'rejected', 'failed', 'cancelled']),
  note: z.string().max(2000).optional(),
  /**
   * The database's own error text, when the failure came from the database.
   * It can quote row values, so main never forwards it without the row-data
   * opt-in (the model gets a value-free category instead).
   */
  dbError: z.string().max(4000).optional(),
  data: z
    .object({
      columns: z.array(z.string()),
      rows: z.array(z.array(z.unknown())).max(200),
      rowCount: z.number(),
    })
    .optional(),
});
export type AiActionResult = z.infer<typeof AiActionResult>;

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
  /** Native open-file picker for TLS CA / cert / key files (C9). */
  ConnectionPickFile: 'plasma:conn:pickFile',
  /** Native picker for a SQLite database file (open or create); main allowlists the path. */
  ConnectionPickSqlite: 'plasma:conn:pickSqlite',
  /** Copy the open SQLite database to a file through the backup API. */
  SqliteBackupCopy: 'plasma:sqlite:backupCopy',
  /** Native picker for DuckDB data files / a .duckdb database; main validates + allowlists. */
  DataFilePick: 'plasma:datafile:pick',
  /** Preload → main: paths of files dropped on the window (main validates and allowlists). */
  DataFileDrop: 'plasma:datafile:drop',
  /** Push: validated data-file paths from a window drop. Payload `DataFilePickResult`. */
  DataFilesDroppedEvent: 'plasma:datafile:dropped',
  /**
   * Push: an SSH bastion presented a host key that is unknown or changed.
   * Payload is `SshHostKeyPrompt`; answer with `SshHostKeyRespond` (C8).
   */
  SshHostKeyPromptEvent: 'plasma:ssh:hostKeyPrompt',
  SshHostKeyRespond: 'plasma:ssh:hostKeyRespond',
  /** Renderer → main: open transaction / unsaved edits, for the quit guard (C32). */
  AppSetUnsavedState: 'plasma:app:setUnsavedState',
  /**
   * Push: the worker process died and was respawned, so the DB session
   * is gone and could not be restored (U20).
   */
  WorkerResetEvent: 'plasma:worker:reset',
  /**
   * Push: main transparently re-established the DB session after a
   * transport loss (VPN/sleep/network switch). Payload is
   * `ConnectionRecovered` — the renderer adopts the new connection
   * generation so pending-edit and in-flight-result guards stay honest (U27).
   */
  ConnectionRecoveredEvent: 'plasma:conn:recovered',
  QueryRun: 'plasma:query:run',
  QueryCancel: 'plasma:query:cancel',
  /**
   * Run a query on the worker's aux connection (AI/monitor). Used by the live
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
  RedisDeleteByPattern: 'plasma:redis:deleteByPattern',
  RedisCancel: 'plasma:redis:cancel',
  /** Renderer-facing event channel for streamed pub/sub messages. */
  RedisPubsubEvent: 'plasma:redis:pubsub',
  /** Cursor-stream query chunks (U15). Payload is QueryChunk. */
  QueryChunkEvent: 'plasma:query:chunk',
  QueryCommitEditBatch: 'plasma:query:commitEditBatch',
  QueryExplain: 'plasma:query:explain',
  QuerySafeRun: 'plasma:query:safeRun',
  QuerySafeRunFinish: 'plasma:query:safeRunFinish',
  PgNoticeEvent: 'plasma:pg:notice',
  StructureApply: 'plasma:structure:apply',
  ImportPickFile: 'plasma:import:pickFile',
  ImportPreview: 'plasma:import:preview',
  ImportRun: 'plasma:import:run',
  ImportCancel: 'plasma:import:cancel',
  ImportProgressEvent: 'plasma:import:progress',
  ExportCancel: 'plasma:export:cancel',
  ExportProgressEvent: 'plasma:export:progress',
  QueryCancelAux: 'plasma:query:cancelAux',
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
  OsRequest: 'plasma:os:request',
  OsCancel: 'plasma:os:cancel',
  VaultList: 'plasma:vault:list',
  VaultDelete: 'plasma:vault:delete',
  VaultConnectById: 'plasma:vault:connectById',
  VaultGetConfig: 'plasma:vault:getConfig',
  /** Save a connection without connecting (C28). */
  VaultSave: 'plasma:vault:save',
  /** Copy a saved connection, secrets included, under a new id (C28). */
  VaultDuplicate: 'plasma:vault:duplicate',
  HistoryList: 'plasma:history:list',
  HistoryLatest: 'plasma:history:latest',
  HistoryClear: 'plasma:history:clear',
  HistoryDelete: 'plasma:history:delete',
  AuditList: 'plasma:audit:list',
  AuditVerify: 'plasma:audit:verify',
  AuditExport: 'plasma:audit:export',
  PgListen: 'plasma:pg:listen',
  PgUnlisten: 'plasma:pg:unlisten',
  PgNotify: 'plasma:pg:notify',
  /** Schema-diff snapshots live in their own table, not in settings (R-18). */
  SchemaSnapshotList: 'plasma:schemaSnapshot:list',
  SchemaSnapshotGet: 'plasma:schemaSnapshot:get',
  SchemaSnapshotSave: 'plasma:schemaSnapshot:save',
  SchemaSnapshotDelete: 'plasma:schemaSnapshot:delete',
  SettingsGet: 'plasma:settings:get',
  SettingsSet: 'plasma:settings:set',
  /** Remove the saved AI API key(s) from the vault. */
  SettingsClearApiKey: 'plasma:settings:clearApiKey',
  TxnBegin: 'plasma:txn:begin',
  TxnCommit: 'plasma:txn:commit',
  TxnRollback: 'plasma:txn:rollback',
  // AI (OpenRouter)
  AiChat: 'plasma:ai:chat',
  AiCancel: 'plasma:ai:cancel',
  /** The model list for the picker: OpenRouter's live catalogue (cached) or a local server's. */
  AiListModels: 'plasma:ai:list-models',
  /** The renderer's answer to an agent action card (applied / rejected / …). */
  AiActionResult: 'plasma:ai:action-result',
  /** The agent's read-only query: runs in a read-only session (`aiQuery`), result shown in a tab. */
  AiRunReadOnly: 'plasma:ai:run-readonly',
  CompareRun: 'plasma:compare:run',
  CompareCancel: 'plasma:compare:cancel',
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
  /** Main → renderer: flush what must survive a restart (tabs, focused field). */
  UpdatePrepareEvent: 'plasma:update:prepare',
  /** Renderer → main: the flush is done; carries the live connection id. */
  UpdatePrepared: 'plasma:update:prepared',
  /** Renderer → main, once per launch: how the previous update restart ended. */
  UpdateLaunchInfo: 'plasma:update:launchInfo',
  // Crash recovery (B2)
  /** Renderer → main (fire and forget): the live workspace snapshot, or null to clear it. */
  RecoverySave: 'plasma:recovery:save',
  /** Same, but answers once the snapshot is on disk. */
  RecoveryFlush: 'plasma:recovery:flush',
  /** Once per window load: did the last run end badly, and what is waiting to be restored. */
  RecoveryLaunchInfo: 'plasma:recovery:launchInfo',
  /** A connection's pending snapshot was restored or discarded (all when no id). */
  RecoveryResolve: 'plasma:recovery:resolve',
  /** Show the main log file in the file manager. */
  RecoveryShowLog: 'plasma:recovery:showLog',
  // Dev sanity checks
  PingMain: 'plasma:ping:main',
  PingWorker: 'plasma:ping:worker',
  /** Worker/main-backed incremental result export (U16). */
  ExportSave: 'plasma:export:save',
  /** Backup / restore (pg_dump, pg_restore, psql) — see `pg-backup.ts`. */
  AdminTools: 'plasma:admin:tools',
  AdminBackup: 'plasma:admin:backup',
  AdminRestore: 'plasma:admin:restore',
  AdminCancel: 'plasma:admin:cancel',
  AdminPickPath: 'plasma:admin:pickPath',
  /** Push: log line / completion of a backup or restore job. */
  AdminJobEvent: 'plasma:admin:jobEvent',
} as const;

// ─── Auto-update ─────────────────────────────────────────────────────

export type UpdateStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'not-available'; version: string; checkedAt?: number }
  | { kind: 'available'; version: string; releaseNotes?: string | null }
  | {
      kind: 'downloading';
      percent: number;
      bytesPerSecond: number;
      transferred: number;
      total: number;
    }
  | { kind: 'downloaded'; version: string; releaseNotes?: string | null }
  /** The user confirmed; main is shutting down and handing over to the installer. */
  | { kind: 'restarting'; version: string }
  /**
   * This build cannot install the update itself (portable EXE, .deb, a macOS
   * app that was never moved to Applications, no signed manifest). The button
   * opens `downloadUrl`; `reason` says why. See docs/mac-auto-update.md.
   */
  | { kind: 'available-manual'; version: string; downloadUrl: string; reason?: string }
  | { kind: 'error'; message: string };

/** How the previous update restart ended, handed to the renderer once per launch. */
export interface UpdateLaunchInfo {
  /** The restart was started by an update: reconnect and restore tabs even if those settings are off. */
  resume: boolean;
  /** Saved connection that was live when the update restarted the app. */
  connectionId: string | null;
  outcome: 'none' | 'updated' | 'failed';
  /** The running version (for `updated`) or the version that was expected (for `failed`). */
  version: string | null;
  /** `failed` only: where the installer wrote its log, when it has one. */
  logPath: string | null;
  /** `failed` only: where to download the build by hand. */
  downloadUrl: string | null;
}

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
    /** Tell main what would be lost on quit so it can confirm first (C32). */
    setUnsavedState(state: AppUnsavedState): Promise<void>;
  };
  conn: {
    connect(config: ConnectionConfig): Promise<ConnectionInfo>;
    disconnect(): Promise<void>;
    test(config: ConnectionConfig, ssh?: ConnectionSshConfig | null): Promise<ConnectionTestResult>;
    introspect(opts?: IntrospectOpts): Promise<SchemaInfo>;
    /** Native file picker (TLS CA / cert / key). Resolves null when cancelled. */
    pickFile(title?: string): Promise<string | null>;
    /** SQLite file picker: open an existing file or create a new one. Null when cancelled. */
    pickSqliteFile(mode: 'open' | 'create'): Promise<string | null>;
    /** "Export database file copy": SQLite backup API to a chosen file. Null when cancelled. */
    sqliteBackupCopy(): Promise<{ filePath: string; bytes: number } | null>;
    /**
     * Native picker for DuckDB: `files` = CSV / TSV / Parquet / JSON data files
     * (a .duckdb file is accepted too), `database` = one .duckdb file. Main
     * validates and allowlists what comes back. Null when cancelled.
     */
    pickDataFiles(target: 'files' | 'database'): Promise<DataFilePickResult | null>;
    /** Answer a `plasma:ssh:hostKeyPrompt` push (C8). */
    respondHostKey(requestId: string, accept: boolean): Promise<void>;
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
    /** Save without connecting. A blank password / secret keeps the stored one. */
    save(config: ConnectionConfig): Promise<SavedConnection>;
    /** Copy a saved connection (with its secrets, tag, SSH and safe-mode settings). */
    duplicate(id: string): Promise<SavedConnection>;
  };
  query: {
    /**
     * Execute a SQL statement.
     * @param opts.internal — when true, the query is NOT recorded in
     *   history. Use for Plasma's own plumbing (introspection, RLS
     *   lookup, count queries, table-tab data, role list, SET ROLE,
     *   table definition). User-written queries should leave this off.
     */
    run(
      sql: string,
      params?: unknown[],
      opts?: { internal?: boolean; maxRows?: number; auditSource?: 'ai' },
    ): Promise<QueryResult>;
    /**
     * Commit grid edits in one transaction (SAVEPOINT inside an open user
     * transaction, which stays open). Params are text or null. Rejects with
     * `Edit N of M (<label>) …` naming the failing edit; nothing is kept.
     */
    commitEditBatch(req: {
      connectionGen: number;
      updates: Array<{
        sql: string;
        params?: unknown[];
        label?: string;
        kind?: 'update' | 'delete' | 'insert';
      }>;
    }): Promise<{ state: TxnState; applied: number; conflicts?: EditConflict[] }>;
    /** EXPLAIN (FORMAT JSON) one statement; ANALYZE runs it inside a rolled-back transaction. */
    explain(req: { sql: string; analyze: boolean; params?: unknown[] }): Promise<QueryResult>;
    /**
     * Safe Run: execute one write inside a held-open transaction (a
     * savepoint if the user has one) and return what it changed. Nothing
     * else runs on the primary until `safeRunFinish` (or the timeout).
     */
    safeRun(req: SafeRunStartRequest): Promise<SafeRunReport>;
    /** Commit or roll back the pending Safe Run. Idempotent after a timeout. */
    safeRunFinish(req: SafeRunFinishRequest): Promise<SafeRunOutcome>;
    cancel(): Promise<CancelOutcome>;
    /** Cancel whatever runs on the aux connection (AI tool query, lookups). */
    cancelAux(): Promise<void>;
    /**
     * Run a query on the worker's sideband connection — never recorded
     * in history. Used by the live monitor + pg_terminate_backend so a
     * long-running primary query doesn't block monitoring.
     */
    sideband(sql: string, params?: unknown[], opts?: { timeoutMs?: number }): Promise<QueryResult>;
  };
  redis: {
    overview(): Promise<RedisOverview>;
    scan(opts: {
      cursor?: string;
      match?: string;
      count?: number;
      db?: number;
      minResults?: number;
      budgetMs?: number;
      type?: string;
    }): Promise<RedisScanResult>;
    getKey(key: string, opts?: RedisGetKeyOpts): Promise<RedisKeyValue>;
    deleteKey(key: string, opts?: { db?: number }): Promise<void>;
    /** seconds <= 0 → PERSIST (clear TTL). */
    setTtl(
      key: string,
      seconds: number,
      opts?: { db?: number; mode?: 'expire' | 'pexpire' | 'expireat' | 'persist' },
    ): Promise<void>;
    command(parts: string[], opts?: { db?: number }): Promise<RedisCommandResult>;
    analyze(opts?: {
      sampleCap?: number;
      match?: string;
      db?: number;
    }): Promise<RedisAnalyzeResult>;
    slowlog(limit?: number): Promise<RedisSlowlogEntry[]>;
    bulkDelete(keys: string[], opts?: { db?: number }): Promise<RedisBulkDeleteResult>;
    write(op: RedisWriteOp, opts?: { db?: number }): Promise<void>;
    deleteByPattern(opts: {
      match: string;
      db?: number;
      dryRun: boolean;
      limit?: number;
    }): Promise<RedisPatternDeleteResult>;
    /** Abort the running analyzer / pattern delete / blocking command. */
    cancel(): Promise<void>;
    subscribe(channel: string, pattern?: boolean): Promise<void>;
    unsubscribe(channel: string, pattern?: boolean): Promise<void>;
  };
  os: {
    overview(): Promise<OsOverview>;
    mapping(index: string): Promise<OsMappingNode>;
    search(opts: {
      index: string;
      body: string;
      size?: number;
      timeoutMs?: number;
      requestId?: string;
    }): Promise<OsSearchResult>;
    sql(
      query: string,
      opts?: { fetchSize?: number; cursor?: string; timeoutMs?: number; requestId?: string },
    ): Promise<OsSqlResult>;
    /** Raw REST call; non-read methods are refused on read-only connections. */
    request(opts: {
      method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
      path: string;
      body?: string;
      timeoutMs?: number;
      requestId?: string;
    }): Promise<OsRawResponse>;
    /** Abort an in-flight search / SQL / request by its renderer-chosen id. */
    cancel(requestId: string): Promise<void>;
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
      query?: string;
    }): Promise<OsFieldStats[]>;
  };
  compare: {
    /** One read-only statement on a saved connection, for Result Compare. */
    run(req: CompareRunRequest): Promise<QueryResult>;
    /** Stop a compare run on another connection (its isolated session is closed). */
    cancel(runId: string): Promise<void>;
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
    /** Models for the picker: OpenRouter's catalogue (6 h cache) or the local server's list. */
    listModels(opts?: AiListModelsRequest): Promise<AiModelsResult>;
    /** Answer an agent `action` event (the user approved, rejected, … the card). */
    actionResult(res: AiActionResult): Promise<void>;
    /** Run ONE read-only statement in a read-only session (never the primary's autocommit). */
    runReadOnly(sql: string): Promise<QueryResult>;
  };
  sql: {
    /** Pretty-print a SQL string. Falls back to the input on parse errors. */
    format(sql: string): Promise<string>;
  };
  audit: {
    list(opts?: AuditListOpts): Promise<AuditEntry[]>;
    /** Replay the hash chain and report the first row that does not match. */
    verify(): Promise<AuditVerifyResult>;
    /** Save the filtered log to a file chosen in a native dialog. */
    export(req: AuditExportRequest): Promise<AuditExportResult>;
  };
  pgListen: {
    /** Subscribe on the dedicated listener connection; messages arrive on `plasma:pg:notification`. */
    start(channel: string): Promise<void>;
    stop(channel: string): Promise<void>;
    /** SELECT pg_notify(channel, payload) — a write, so safe mode applies. */
    notify(channel: string, payload: string): Promise<void>;
  };
  history: {
    list(opts?: HistoryListOpts): Promise<HistoryEntry[]>;
    /** Most recent entry for ⌘↑ recall (empty editor). */
    latest(opts?: { connectionId?: string }): Promise<HistoryEntry | null>;
    clear(): Promise<void>;
    /** Remove a single entry by id. */
    delete(id: number): Promise<void>;
  };
  schemaSnapshots: {
    /** Metadata only: the (large) schema is fetched per snapshot with `get`. */
    list(): Promise<SchemaSnapshotMeta[]>;
    get(id: string): Promise<SchemaInfo | null>;
    save(req: SchemaSnapshotSaveRequest): Promise<SchemaSnapshotMeta>;
    delete(id: string): Promise<void>;
  };
  settings: {
    get(): Promise<Settings>;
    set(patch: Partial<Settings>): Promise<Settings>;
    /** Delete the stored AI API key (OpenRouter + legacy slot); returns fresh settings. */
    clearApiKey(): Promise<Settings>;
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
  admin: {
    /** Locate pg_dump / pg_restore / psql (optionally in `binDir`) and read their versions. */
    tools(binDir?: string): Promise<ToolInfo[]>;
    backup(req: BackupRequest): Promise<AdminStartResult>;
    restore(req: RestoreRequest): Promise<AdminStartResult>;
    cancel(jobId: string): Promise<void>;
    /** Native file / folder picker. Resolves null when cancelled. */
    pickPath(req: PickPathRequest): Promise<string | null>;
  };
  export: {
    /**
     * Show a save dialog and stream CSV/JSON/SQL to disk via worker/main (U16).
     * Prefer `sql` (omit rows) when the on-screen result is truncated.
     */
    save(req: ExportSaveRequest): Promise<ExportSaveResult>;
    /** Stop the export started with this `jobId` (C30). */
    cancel(jobId: string): Promise<void>;
  };
  structure: {
    /**
     * Run DDL built by `pg-ddl`: `transactional` in one transaction (all or
     * nothing), then each `concurrent` statement on its own. Rejects on
     * read-only connections. Resolves with `error` instead of throwing so
     * the UI can show which statement failed.
     */
    apply(req: DdlApplyRequest): Promise<DdlApplyResult>;
  };
  dataImport: {
    /** Native open dialog; resolves null when cancelled. */
    pickFile(): Promise<ImportPickedFile | null>;
    /** Read the head of a file: detected options, first rows, inferred types. */
    preview(req: ImportPreviewRequest): Promise<ImportPreview>;
    /** Stream the file into Postgres in one transaction (rolled back on error / cancel). */
    run(job: ImportJobSpec): Promise<ImportResult>;
    cancel(jobId: string): Promise<void>;
  };
  update: {
    /** Trigger an explicit check now. Returns the status post-check. */
    check(): Promise<UpdateStatus>;
    /**
     * Restart to install the downloaded update. Main lists what would be lost
     * and asks first when something is at stake; with nothing at stake it
     * restarts at once. On `available-manual` it opens the download instead;
     * no-op for every other status.
     */
    install(): Promise<void>;
    /** Read the most recent status snapshot (no network). */
    status(): Promise<UpdateStatus>;
    /** Answer to `plasma:update:prepare`: tabs are flushed; carries the live connection. */
    prepared(info: { connectionId: string | null }): Promise<void>;
    /** Once per launch: whether an update restart just happened, and how it ended. */
    launchInfo(): Promise<UpdateLaunchInfo>;
  };
  /** B2: crash recovery. */
  recovery: {
    /** Debounced snapshots; `null` clears (deliberate disconnect). Not awaited. */
    save(journal: import('./recovery').RecoveryJournal | null, durable?: boolean): void;
    /** Resolves once the snapshot is durably on disk; false when main refused it. */
    flush(journal: import('./recovery').RecoveryJournal | null): Promise<boolean>;
    launchInfo(): Promise<import('./recovery').RecoveryLaunchInfo>;
    /** `keepAsRestored`: the restored state could not be written down; set the snapshot aside instead of deleting it. */
    resolve(connectionId?: string, keepAsRestored?: boolean): Promise<void>;
    showLog(): Promise<void>;
  };
  /** D1: team workspaces (`.plasma/` folders). */
  workspace: import('./workspace').WorkspaceApi;
  /** D2: plasma:// links and launcher requests that arrived from outside. */
  deepLink: import('./deep-link').DeepLinkApi;
  /** CLI companion: the `plasma` launcher. */
  cli: import('./deep-link').CliApi;
  /** "Create support bundle…": review every file, then save a zip. Nothing is uploaded. */
  support: import('./support-bundle').SupportApi;
}
