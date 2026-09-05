import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AiChatRequest,
  type AppMeta,
  ConnectionConfig,
  type ConnectionConfig as ConnectionConfigType,
  type ConnectionInfo,
  type ConnectionTestResult,
  type HistoryEntry,
  IpcChannel,
  type PingRequest,
  type PingResponse,
  type QueryResult,
  type SavedConnection,
  type SchemaInfo,
  type Settings,
  SettingsShape,
  type TxnState,
  type WorkerRequest,
  type WorkerResponse,
} from '@shared/protocol';
import { isSingleSqlStatement } from '@shared/sql-statements';
import { BrowserWindow, app, ipcMain, nativeImage } from 'electron';
import {
  AI_TOOL_MAX_ROWS,
  cancelAiChat,
  capAiToolJson,
  isAiRowDataAllowed,
  isReadOnlyRedisCommand,
  isReadOnlySql,
  serializeAiToolRows,
  setAiToolExecutor,
  startAiChat,
} from './ai';
import { closeDb, getDb } from './db';
import { clearHistory, listHistory, recordHistory } from './history';
import { initLogger, logger } from './logger';
import { buildAppMenu } from './menu';
import { getAllSettings, setSetting } from './settings';
import { formatSql } from './sql-format';
import { closeAllTunnels, closeTunnel, openTunnel } from './ssh-tunnel';
import { disposeUpdater, initUpdater } from './updater';
import {
  deleteConnection as vaultDelete,
  getFullConnection as vaultGetFull,
  listConnections as vaultList,
  saveConnection as vaultSave,
} from './vault';
import { applyThemeToWindow, createMainWindow, resolveIconPath } from './window';
import { WorkerSupervisor } from './worker-supervisor';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let mainWindow: BrowserWindow | null = null;
const workerSupervisor = new WorkerSupervisor();

// Track the connection id associated with the currently-active worker
// connection so history entries can be linked back to the right vault row.
let activeConnectionId: string | null = null;

// Track the active engine so the AI tool executor can dispatch the
// right tool call (sideband SQL vs Redis command vs OS search). Set
// by ConnectionConnect / VaultConnectById, cleared on disconnect.
let activeEngine: 'postgres' | 'redis' | 'opensearch' | null = null;

// ─── App lifecycle ────────────────────────────────────────────────────

// Windows: set the AppUserModelID before any windows are created. This
// is what Windows uses to group taskbar buttons + attach the correct
// icon. Without it, Windows uses electron.exe's icon and groups Plasma
// windows under "Electron". Must be called synchronously early.
if (process.platform === 'win32') {
  app.setAppUserModelId('sh.plasma.app');
}

app.whenReady().then(async () => {
  initLogger();
  logger.info('[plasma] app ready, version', app.getVersion());

  // On macOS, set the dock icon explicitly. BrowserWindow `icon` alone
  // doesn't touch the dock — that's handled separately by app.dock.
  // On Windows/Linux the taskbar picks up BrowserWindow.icon directly.
  if (process.platform === 'darwin') {
    const iconPath = resolveIconPath();
    if (iconPath) {
      try {
        const image = nativeImage.createFromPath(iconPath);
        app.dock?.setIcon(image);
        logger.info('[plasma] dock icon set from', iconPath);
      } catch (err) {
        logger.error('[plasma] dock icon failed:', err);
      }
    } else {
      logger.warn(
        '[plasma] dock icon not set — resources/icon.png missing. Run `pnpm build:icons`.',
      );
    }
  }

  // Touch the DB early so migrations run before any IPC handlers can read it
  getDb();

  await workerSupervisor.start(join(__dirname, 'workers/index.js'));

  // Forward worker broadcasts (currently just Redis pub/sub) to the
  // renderer over a dedicated event channel.
  workerSupervisor.setBroadcastHandler((evt) => {
    if (evt.kind === 'redisPubsub') {
      mainWindow?.webContents.send('plasma:redis:pubsub', evt.message);
    }
  });

  // AI tools dispatch by the active engine. Postgres uses a dedicated
  // read-only AI client (U04); Redis routes through the read-only
  // command list; OpenSearch hits search / SQL plugin. Row-data tools
  // require per-connection opt-in (U06) and are row/byte capped.
  setAiToolExecutor(async (name, args) => {
    const settings = SettingsShape.parse(getAllSettings());
    const allowRows = isAiRowDataAllowed(activeConnectionId, settings.connectionAiRowData);
    if (!allowRows) {
      return JSON.stringify({
        error:
          'rejected: AI row-data tools are disabled for this connection. Enable "Allow AI tools to read row data" in the connection dialog.',
      });
    }

    if (name === 'query_database') {
      if (activeEngine !== 'postgres') {
        return JSON.stringify({ error: 'no postgres connection' });
      }
      const sql = typeof args.sql === 'string' ? args.sql : '';
      if (!sql) return JSON.stringify({ error: 'missing sql arg' });
      // Cheap pre-filter only — database-side READ ONLY is the real boundary.
      if (!isReadOnlySql(sql)) {
        return JSON.stringify({
          error: 'rejected: only SELECT / EXPLAIN / SHOW / WITH / VALUES / TABLE allowed',
        });
      }
      if (!isSingleSqlStatement(sql)) {
        return JSON.stringify({
          error: 'rejected: AI queries must be a single SQL statement',
        });
      }
      try {
        const res = await callWorker({ kind: 'aiQuery', sql }, 'queryResult');
        const cols = res.result.columns.map((c) => c.name);
        return serializeAiToolRows({
          columns: cols,
          rows: res.result.rows,
          rowCount: res.result.rowCount,
          maxRows: AI_TOOL_MAX_ROWS,
        });
      } catch (err) {
        return JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (name === 'redis_command') {
      if (activeEngine !== 'redis') {
        return JSON.stringify({ error: 'no redis connection' });
      }
      const partsRaw = args.parts;
      const parts = Array.isArray(partsRaw) ? partsRaw.map((p) => String(p)) : [];
      if (parts.length === 0) return JSON.stringify({ error: 'parts required' });
      if (!isReadOnlyRedisCommand(parts)) {
        return JSON.stringify({
          error: `rejected: ${parts[0]}${parts[1] ? ' ' + parts[1] : ''} is not in the read-only allow-list`,
        });
      }
      try {
        const res = await callWorker({ kind: 'redisCommand', parts }, 'redisCommand');
        return capAiToolJson({
          command: res.result.command,
          args: res.result.args,
          reply: res.result.reply,
          durationMs: res.result.durationMs,
          capped: true,
        });
      } catch (err) {
        return JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (name === 'os_search') {
      if (activeEngine !== 'opensearch') {
        return JSON.stringify({ error: 'no opensearch connection' });
      }
      const index = typeof args.index === 'string' ? args.index : '';
      const body = typeof args.body === 'string' ? args.body : '';
      if (!index || !body) return JSON.stringify({ error: 'index + body required' });
      try {
        const res = await callWorker(
          { kind: 'osSearch', index, body, size: AI_TOOL_MAX_ROWS },
          'osSearch',
        );
        return capAiToolJson({
          total: res.result.total,
          took: res.result.took,
          hits: res.result.hits.slice(0, AI_TOOL_MAX_ROWS),
          fields: res.result.fields,
          truncated: res.result.hits.length > AI_TOOL_MAX_ROWS,
          capped: { maxRows: AI_TOOL_MAX_ROWS },
        });
      } catch (err) {
        return JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (name === 'os_sql') {
      if (activeEngine !== 'opensearch') {
        return JSON.stringify({ error: 'no opensearch connection' });
      }
      const query = typeof args.query === 'string' ? args.query : '';
      if (!query) return JSON.stringify({ error: 'query required' });
      // Only allow SELECT — the SQL plugin can technically issue
      // CREATE / DELETE on some distributions, but the AI's job is
      // observation only.
      if (!/^\s*select\b/i.test(query)) {
        return JSON.stringify({ error: 'only SELECT allowed' });
      }
      try {
        const res = await callWorker({ kind: 'osSql', query }, 'osSql');
        const cols = res.result.columns.map((c) => c.name);
        return serializeAiToolRows({
          columns: cols,
          rows: res.result.rows,
          rowCount: res.result.rows.length,
          maxRows: AI_TOOL_MAX_ROWS,
          extra: { durationMs: res.result.durationMs },
        });
      } catch (err) {
        return JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return JSON.stringify({ error: `unknown tool ${name}` });
  });

  mainWindow = createMainWindow();
  buildAppMenu();
  registerIpcHandlers();
  initUpdater(mainWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    disposeUpdater();
    closeAllTunnels();
    workerSupervisor.stop();
    closeDb();
    app.quit();
  }
});

app.on('before-quit', () => {
  closeAllTunnels();
  workerSupervisor.stop();
  closeDb();
});

// ─── Worker helper ────────────────────────────────────────────────────

/**
 * Distributive Omit — preserves discriminated-union narrowing when we
 * strip `id` from a WorkerRequest variant. Plain `Omit<U, 'id'>` flattens
 * the union once it crosses ~10 variants and TS stops checking variant
 * membership of the call-site object literal.
 */
type DistributiveOmit<T, K extends keyof T> = T extends T ? Omit<T, K> : never;

async function callWorker<K extends WorkerResponse['kind']>(
  req: DistributiveOmit<WorkerRequest, 'id'>,
  expected: K,
): Promise<Extract<WorkerResponse, { kind: K }>> {
  const id = randomUUID();
  const res = await workerSupervisor.request({ ...req, id } as WorkerRequest);
  if (res.kind === 'error') {
    throw new Error(res.message);
  }
  if (res.kind !== expected) {
    throw new Error(`unexpected worker response: ${res.kind} (expected ${expected})`);
  }
  return res as Extract<WorkerResponse, { kind: K }>;
}

// ─── IPC handlers ─────────────────────────────────────────────────────

function registerIpcHandlers() {
  ipcMain.handle(
    IpcChannel.AppMeta,
    (): AppMeta => ({
      name: 'plasma',
      version: app.getVersion(),
      platform: process.platform as 'darwin' | 'win32' | 'linux',
      electron: process.versions.electron ?? 'unknown',
      node: process.versions.node,
    }),
  );

  // ── Connection lifecycle ──

  ipcMain.handle(
    IpcChannel.ConnectionConnect,
    async (_e, rawConfig: unknown): Promise<ConnectionInfo> => {
      const config = ConnectionConfig.parse(rawConfig);
      const settings = SettingsShape.parse(getAllSettings());
      const ssh = settings.connectionSsh?.[config.id];
      const effective = { ...config };
      if (ssh) {
        const local = await openTunnel({
          id: config.id,
          ssh,
          pgHost: config.host,
          pgPort: config.port,
        });
        effective.host = local.host;
        effective.port = local.port;
      }
      try {
        const res = await callWorker({ kind: 'connect', config: effective }, 'connected');
        try {
          vaultSave(config);
          activeConnectionId = config.id;
          activeEngine = res.engine;
        } catch (err) {
          logger.error('[plasma] vault save failed (non-fatal):', err);
        }
        return { serverVersion: res.serverVersion, engine: res.engine };
      } catch (err) {
        if (ssh) closeTunnel(config.id);
        throw err;
      }
    },
  );

  ipcMain.handle(IpcChannel.ConnectionDisconnect, async (): Promise<void> => {
    const id = activeConnectionId;
    activeConnectionId = null;
    activeEngine = null;
    await callWorker({ kind: 'disconnect' }, 'disconnected');
    if (id) closeTunnel(id);
  });

  ipcMain.handle(
    IpcChannel.ConnectionTest,
    async (_e, rawConfig: unknown): Promise<ConnectionTestResult> => {
      try {
        const config = ConnectionConfig.parse(rawConfig);
        const res = await callWorker({ kind: 'connect', config }, 'connected');
        return { ok: true, serverVersion: res.serverVersion, engine: res.engine };
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  // Postgres-only schema introspect. For redis/opensearch the renderer
  // calls the engine-specific overview channels directly.
  ipcMain.handle(IpcChannel.ConnectionIntrospect, async (): Promise<SchemaInfo> => {
    const res = await callWorker({ kind: 'introspect' }, 'schemaInfo');
    return res.info;
  });

  // ── Vault ──

  ipcMain.handle(IpcChannel.VaultList, (): SavedConnection[] => vaultList());

  ipcMain.handle(IpcChannel.VaultDelete, (_e, id: unknown): void => {
    if (typeof id !== 'string') throw new Error('id must be a string');
    vaultDelete(id);
  });

  ipcMain.handle(
    IpcChannel.VaultConnectById,
    async (_e, id: unknown): Promise<{ info: ConnectionInfo; config: SavedConnection }> => {
      if (typeof id !== 'string') throw new Error('id must be a string');
      const config = vaultGetFull(id);
      if (!config) throw new Error(`no saved connection with id ${id}`);
      const settings = SettingsShape.parse(getAllSettings());
      const ssh = settings.connectionSsh?.[id];
      const effective = { ...config };
      if (ssh) {
        const local = await openTunnel({ id, ssh, pgHost: config.host, pgPort: config.port });
        effective.host = local.host;
        effective.port = local.port;
      }
      try {
        const res = await callWorker({ kind: 'connect', config: effective }, 'connected');
        activeConnectionId = config.id;
        activeEngine = res.engine;
        const { password: _pwd, ...safeConfig } = config;
        return {
          info: { serverVersion: res.serverVersion, engine: res.engine },
          config: safeConfig,
        };
      } catch (err) {
        if (ssh) closeTunnel(id);
        throw err;
      }
    },
  );

  ipcMain.handle(IpcChannel.VaultGetConfig, (_e, id: unknown): ConnectionConfigType | null => {
    if (typeof id !== 'string') throw new Error('id must be a string');
    // Returns the decrypted config including password — used only by
    // the renderer's Edit flow so users don't need to re-type passwords.
    return vaultGetFull(id);
  });

  // ── Query execution + history ──

  ipcMain.handle(IpcChannel.QueryRun, async (_e, payload: unknown): Promise<QueryResult> => {
    // Accept either a legacy string-only payload or { sql, params, internal }.
    // `internal: true` skips history recording — used for Plasma's own
    // plumbing queries (introspection, RLS lookup, count, table data,
    // etc.) so the user-facing history list stays clean.
    let sql: string;
    let params: unknown[] | undefined;
    let internal = false;
    if (typeof payload === 'string') {
      sql = payload;
    } else if (payload && typeof payload === 'object' && 'sql' in payload) {
      const p = payload as { sql: unknown; params?: unknown; internal?: unknown };
      if (typeof p.sql !== 'string') throw new Error('sql must be a string');
      sql = p.sql;
      params = Array.isArray(p.params) ? p.params : undefined;
      internal = p.internal === true;
    } else {
      throw new Error('invalid query payload');
    }
    const executedAt = Date.now();
    try {
      const res = await callWorker({ kind: 'query', sql, params }, 'queryResult');
      if (!internal) {
        try {
          recordHistory({
            connectionId: activeConnectionId,
            sql,
            rowCount: res.result.rowCount,
            durationMs: res.result.durationMs,
            error: null,
            executedAt,
          });
        } catch (err) {
          logger.error('[plasma] history write failed (non-fatal):', err);
        }
      }
      return res.result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!internal) {
        try {
          recordHistory({
            connectionId: activeConnectionId,
            sql,
            rowCount: null,
            durationMs: null,
            error: message,
            executedAt,
          });
        } catch (histErr) {
          logger.error('[plasma] history write failed (non-fatal):', histErr);
        }
      }
      throw err;
    }
  });

  ipcMain.handle(IpcChannel.QueryCancel, async (): Promise<void> => {
    await callWorker({ kind: 'cancel' }, 'cancelled');
  });

  ipcMain.handle(IpcChannel.QuerySideband, async (_e, payload: unknown): Promise<QueryResult> => {
    let sql: string;
    let params: unknown[] | undefined;
    if (typeof payload === 'string') {
      sql = payload;
    } else if (payload && typeof payload === 'object' && 'sql' in payload) {
      const p = payload as { sql: unknown; params?: unknown };
      if (typeof p.sql !== 'string') throw new Error('sql must be a string');
      sql = p.sql;
      params = Array.isArray(p.params) ? p.params : undefined;
    } else {
      throw new Error('invalid sideband payload');
    }
    const res = await callWorker({ kind: 'sidebandQuery', sql, params }, 'queryResult');
    return res.result;
  });

  // ── AI (OpenRouter) ──

  ipcMain.handle(IpcChannel.AiChat, async (_e, raw: unknown): Promise<{ accepted: boolean }> => {
    const parsed = AiChatRequest.parse(raw);
    const settings = SettingsShape.parse(getAllSettings());
    // Prefer the OpenRouter key. Fall back to the legacy claudeApiKey
    // field so users upgrading from v0.0.10 keep working without
    // touching settings — `claude-3-5-*` model ids on OpenRouter route
    // to Anthropic, so the key (sk-or-...) is the only thing that
    // really has to change.
    const apiKey = settings.openrouterApiKey || settings.claudeApiKey;
    const allowRowData = isAiRowDataAllowed(activeConnectionId, settings.connectionAiRowData);
    const result = await startAiChat(mainWindow, parsed, apiKey, settings.openrouterModel, {
      allowRowData,
    });
    if (!result.accepted && result.reason) {
      // Surface the failure as a stream event too, so the UI shows it
      // even if the renderer awaits the promise without checking the
      // returned `accepted` flag.
      mainWindow?.webContents.send('plasma:ai:event', {
        kind: 'error',
        requestId: parsed.requestId,
        message: result.reason,
      });
    }
    return { accepted: result.accepted };
  });

  ipcMain.handle(IpcChannel.AiCancel, async (_e, requestId: unknown): Promise<void> => {
    if (typeof requestId !== 'string') return;
    cancelAiChat(requestId);
  });

  ipcMain.handle(IpcChannel.FormatSql, (_e, sql: unknown): string => {
    if (typeof sql !== 'string') return '';
    return formatSql(sql);
  });

  // ── Query history ──

  ipcMain.handle(IpcChannel.HistoryList, async (_e, opts: unknown): Promise<HistoryEntry[]> => {
    const safe = (opts ?? {}) as { limit?: number; connectionId?: string };
    return listHistory(safe);
  });

  ipcMain.handle(IpcChannel.HistoryClear, async (): Promise<void> => {
    clearHistory();
  });

  // ── Settings ──

  ipcMain.handle(IpcChannel.SettingsGet, (): Settings => {
    const raw = getAllSettings();
    return SettingsShape.parse(raw);
  });

  ipcMain.handle(IpcChannel.SettingsSet, (_e, patch: unknown): Settings => {
    const prev = SettingsShape.parse(getAllSettings());
    const merged = SettingsShape.parse({ ...prev, ...(patch as Record<string, unknown>) });
    for (const [k, v] of Object.entries(merged)) {
      setSetting(k, v);
    }
    // Side effect: if theme changed, update the native window background +
    // title bar overlay so the native window controls follow suit.
    if (merged.theme !== prev.theme && mainWindow && !mainWindow.isDestroyed()) {
      applyThemeToWindow(mainWindow, merged.theme);
    }
    return merged;
  });

  // ── Transactions ──

  ipcMain.handle(IpcChannel.TxnBegin, async (): Promise<TxnState> => {
    const res = await callWorker({ kind: 'beginTxn' }, 'txnState');
    return res.state;
  });

  ipcMain.handle(IpcChannel.TxnCommit, async (): Promise<TxnState> => {
    const res = await callWorker({ kind: 'commitTxn' }, 'txnState');
    return res.state;
  });

  ipcMain.handle(IpcChannel.TxnRollback, async (): Promise<TxnState> => {
    const res = await callWorker({ kind: 'rollbackTxn' }, 'txnState');
    return res.state;
  });

  // ── Redis ──

  ipcMain.handle(IpcChannel.RedisOverview, async () => {
    const res = await callWorker({ kind: 'redisOverview' }, 'redisOverview');
    return res.info;
  });

  ipcMain.handle(IpcChannel.RedisScan, async (_e, raw: unknown) => {
    const opts = (raw ?? {}) as {
      cursor?: string;
      match?: string;
      count?: number;
      db?: number;
    };
    const res = await callWorker(
      {
        kind: 'redisScan',
        cursor: opts.cursor ?? '0',
        match: typeof opts.match === 'string' && opts.match ? opts.match : undefined,
        count: typeof opts.count === 'number' ? opts.count : 500,
        db: typeof opts.db === 'number' ? opts.db : undefined,
      },
      'redisScan',
    );
    return res.result;
  });

  ipcMain.handle(IpcChannel.RedisGetKey, async (_e, key: unknown) => {
    if (typeof key !== 'string') throw new Error('key must be a string');
    const res = await callWorker({ kind: 'redisGetKey', key }, 'redisKey');
    return res.result;
  });

  ipcMain.handle(IpcChannel.RedisDeleteKey, async (_e, key: unknown) => {
    if (typeof key !== 'string') throw new Error('key must be a string');
    await callWorker({ kind: 'redisDeleteKey', key }, 'redisAck');
  });

  ipcMain.handle(IpcChannel.RedisSetTtl, async (_e, raw: unknown) => {
    const p = (raw ?? {}) as { key?: unknown; seconds?: unknown };
    if (typeof p.key !== 'string') throw new Error('key must be a string');
    if (typeof p.seconds !== 'number') throw new Error('seconds must be a number');
    await callWorker(
      { kind: 'redisSetTtl', key: p.key, seconds: Math.floor(p.seconds) },
      'redisAck',
    );
  });

  ipcMain.handle(IpcChannel.RedisCommand, async (_e, raw: unknown) => {
    if (!Array.isArray(raw)) throw new Error('parts must be an array');
    const parts = raw.map((p) => String(p));
    if (parts.length === 0) throw new Error('empty command');
    const res = await callWorker({ kind: 'redisCommand', parts }, 'redisCommand');
    return res.result;
  });

  ipcMain.handle(IpcChannel.RedisAnalyze, async (_e, raw: unknown) => {
    const opts = (raw ?? {}) as { sampleCap?: number; match?: string };
    const res = await callWorker(
      {
        kind: 'redisAnalyze',
        sampleCap: typeof opts.sampleCap === 'number' ? opts.sampleCap : 5000,
        match: typeof opts.match === 'string' && opts.match ? opts.match : undefined,
      },
      'redisAnalyze',
    );
    return res.result;
  });

  ipcMain.handle(IpcChannel.RedisSlowlog, async (_e, raw: unknown) => {
    const limit = typeof raw === 'number' ? raw : 64;
    const res = await callWorker({ kind: 'redisSlowlog', limit }, 'redisSlowlog');
    return res.entries;
  });

  ipcMain.handle(IpcChannel.RedisBulkDelete, async (_e, raw: unknown) => {
    if (!Array.isArray(raw)) throw new Error('keys must be an array');
    const keys = raw.map((k) => String(k));
    if (keys.length === 0) return;
    await callWorker({ kind: 'redisBulkDelete', keys }, 'redisAck');
  });

  ipcMain.handle(IpcChannel.RedisWrite, async (_e, raw: unknown) => {
    // The worker re-parses via Zod, so we forward as-is.
    await callWorker({ kind: 'redisWrite', op: raw as never }, 'redisAck');
  });

  ipcMain.handle(IpcChannel.RedisSubscribe, async (_e, raw: unknown) => {
    const p = (raw ?? {}) as { channel?: unknown; pattern?: unknown };
    if (typeof p.channel !== 'string' || !p.channel) throw new Error('channel required');
    await callWorker(
      { kind: 'redisSubscribe', channel: p.channel, pattern: p.pattern === true },
      'redisAck',
    );
  });

  ipcMain.handle(IpcChannel.RedisUnsubscribe, async (_e, raw: unknown) => {
    const p = (raw ?? {}) as { channel?: unknown; pattern?: unknown };
    if (typeof p.channel !== 'string' || !p.channel) throw new Error('channel required');
    await callWorker(
      { kind: 'redisUnsubscribe', channel: p.channel, pattern: p.pattern === true },
      'redisAck',
    );
  });

  // ── OpenSearch ──

  ipcMain.handle(IpcChannel.OsOverview, async () => {
    const res = await callWorker({ kind: 'osOverview' }, 'osOverview');
    return res.info;
  });

  ipcMain.handle(IpcChannel.OsMapping, async (_e, index: unknown) => {
    if (typeof index !== 'string') throw new Error('index must be a string');
    const res = await callWorker({ kind: 'osMapping', index }, 'osMapping');
    return res.root;
  });

  ipcMain.handle(IpcChannel.OsSearch, async (_e, raw: unknown) => {
    const p = (raw ?? {}) as { index?: unknown; body?: unknown; size?: unknown };
    if (typeof p.index !== 'string') throw new Error('index must be a string');
    if (typeof p.body !== 'string') throw new Error('body must be a string');
    const size = typeof p.size === 'number' ? p.size : 100;
    const res = await callWorker(
      { kind: 'osSearch', index: p.index, body: p.body, size },
      'osSearch',
    );
    return res.result;
  });

  ipcMain.handle(IpcChannel.OsSql, async (_e, raw: unknown) => {
    if (typeof raw !== 'string' || !raw) throw new Error('query required');
    const res = await callWorker({ kind: 'osSql', query: raw }, 'osSql');
    return res.result;
  });

  ipcMain.handle(IpcChannel.OsAliases, async () => {
    const res = await callWorker({ kind: 'osAliases' }, 'osAliases');
    return res.aliases;
  });

  ipcMain.handle(IpcChannel.OsIlm, async () => {
    const res = await callWorker({ kind: 'osIlm' }, 'osIlm');
    return res.policies;
  });

  ipcMain.handle(IpcChannel.OsCreateIndex, async (_e, raw: unknown) => {
    const p = (raw ?? {}) as { name?: unknown; body?: unknown };
    if (typeof p.name !== 'string' || !p.name) throw new Error('index name required');
    const body =
      p.body && typeof p.body === 'object' && !Array.isArray(p.body)
        ? (p.body as Record<string, unknown>)
        : undefined;
    const res = await callWorker({ kind: 'osCreateIndex', name: p.name, body }, 'osCreateIndex');
    return { acknowledged: res.acknowledged, index: res.index };
  });

  ipcMain.handle(IpcChannel.OsDeleteIndex, async (_e, raw: unknown) => {
    if (typeof raw !== 'string' || !raw) throw new Error('index name required');
    const res = await callWorker({ kind: 'osDeleteIndex', name: raw }, 'osDeleteIndex');
    return { acknowledged: res.acknowledged };
  });

  ipcMain.handle(IpcChannel.OsFieldStats, async (_e, raw: unknown) => {
    const p = (raw ?? {}) as {
      index?: unknown;
      fields?: unknown;
      queryString?: unknown;
    };
    if (typeof p.index !== 'string') throw new Error('index required');
    if (!Array.isArray(p.fields) || p.fields.length === 0) throw new Error('fields required');
    const fields = p.fields.map((f) => String(f));
    const res = await callWorker(
      {
        kind: 'osFieldStats',
        index: p.index,
        fields,
        queryString: typeof p.queryString === 'string' && p.queryString ? p.queryString : undefined,
      },
      'osFieldStats',
    );
    return res.stats;
  });

  // ── Dev sanity checks ──

  // ── Window controls (custom titlebar buttons) ──

  ipcMain.handle(IpcChannel.WindowMinimize, (e): void => {
    BrowserWindow.fromWebContents(e.sender)?.minimize();
  });

  ipcMain.handle(IpcChannel.WindowMaximizeToggle, (e): void => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });

  ipcMain.handle(IpcChannel.WindowClose, (e): void => {
    BrowserWindow.fromWebContents(e.sender)?.close();
  });

  ipcMain.handle(IpcChannel.WindowIsMaximized, (e): boolean => {
    return BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false;
  });

  ipcMain.handle(IpcChannel.PingMain, (_e, req: PingRequest): PingResponse => {
    return { echo: req.message, via: 'main', timestamp: Date.now() };
  });

  ipcMain.handle(IpcChannel.PingWorker, async (_e, req: PingRequest): Promise<PingResponse> => {
    const res = await callWorker({ kind: 'ping', message: req.message }, 'ping');
    return { echo: res.echo, via: 'worker', timestamp: res.timestamp };
  });
}
