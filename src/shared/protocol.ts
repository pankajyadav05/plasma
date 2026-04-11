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

export const ConnectionConfig = z.object({
  id: z.string(),
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().positive().max(65535),
  database: z.string().min(1),
  user: z.string().min(1),
  password: z.string(),
  ssl: z.boolean().default(false),
});
export type ConnectionConfig = z.infer<typeof ConnectionConfig>;

export const SavedConnection = ConnectionConfig.omit({ password: true });
export type SavedConnection = z.infer<typeof SavedConnection>;

export const ConnectionInfo = z.object({
  serverVersion: z.string(),
});
export type ConnectionInfo = z.infer<typeof ConnectionInfo>;

export const ConnectionTestResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), serverVersion: z.string() }),
  z.object({ ok: z.literal(false), message: z.string() }),
]);
export type ConnectionTestResult = z.infer<typeof ConnectionTestResult>;

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
      kind: z.enum(['table', 'view', 'matview']),
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
]);
export type WorkerRequest = z.infer<typeof WorkerRequest>;

export const WorkerResponse = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ping'),
    id: z.string(),
    echo: z.string(),
    timestamp: z.number(),
  }),
  z.object({ kind: z.literal('connected'), id: z.string(), serverVersion: z.string() }),
  z.object({ kind: z.literal('disconnected'), id: z.string() }),
  z.object({ kind: z.literal('queryResult'), id: z.string(), result: QueryResult }),
  z.object({ kind: z.literal('cancelled'), id: z.string() }),
  z.object({ kind: z.literal('schemaInfo'), id: z.string(), info: SchemaInfo }),
  z.object({ kind: z.literal('txnState'), id: z.string(), state: TxnState }),
  z.object({ kind: z.literal('error'), id: z.string(), message: z.string() }),
]);
export type WorkerResponse = z.infer<typeof WorkerResponse>;

// ─── Settings (keyed values in SQLite) ───────────────────────────────

export const SettingsShape = z.object({
  theme: z.enum(['paper', 'midnight']).default('paper'),
  sidebarCollapsed: z.boolean().default(false),
  sidebarWidth: z.number().int().min(200).max(520).default(264),
  editorExpanded: z.boolean().default(false),
  editorFontSize: z.number().int().min(10).max(24).default(14),
  defaultPageSize: z.number().int().positive().default(50),
  queryTimeoutMs: z.number().int().nonnegative().default(0), // 0 = no timeout
  telemetryEnabled: z.boolean().default(false),
  claudeApiKey: z.string().default(''),
  transactionMode: z.boolean().default(false),
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

// ─── IPC channel names ───────────────────────────────────────────────

export const IpcChannel = {
  AppMeta: 'plasma:app:meta',
  ConnectionConnect: 'plasma:conn:connect',
  ConnectionDisconnect: 'plasma:conn:disconnect',
  ConnectionTest: 'plasma:conn:test',
  ConnectionIntrospect: 'plasma:conn:introspect',
  QueryRun: 'plasma:query:run',
  QueryCancel: 'plasma:query:cancel',
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
  // Window controls (custom titlebar — Windows/Linux)
  WindowMinimize: 'plasma:window:minimize',
  WindowMaximizeToggle: 'plasma:window:maximizeToggle',
  WindowClose: 'plasma:window:close',
  WindowIsMaximized: 'plasma:window:isMaximized',
  // Dev sanity checks
  PingMain: 'plasma:ping:main',
  PingWorker: 'plasma:ping:worker',
} as const;

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
    connectById(
      id: string,
    ): Promise<{ info: ConnectionInfo; config: SavedConnection }>;
    /**
     * Read a saved connection with its decrypted password. Used for the
     * Edit flow so the user doesn't have to re-type their password.
     * Returns null if no connection with that id exists.
     */
    getConfig(id: string): Promise<ConnectionConfig | null>;
  };
  query: {
    run(sql: string, params?: unknown[]): Promise<QueryResult>;
    cancel(): Promise<void>;
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
}
