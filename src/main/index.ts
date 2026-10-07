import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAgentReadSql } from '@shared/ai-readonly-sql';
import { sshUnsupportedReason } from '@shared/connection-endpoint';
import { CONNECTION_LOST, ConnectionLostError } from '@shared/connection-loss';
import { assertOsSingleIndexName, isReadOnlyOsSql } from '@shared/os-write-policy';
import {
  type AdminJobEvent,
  BackupRequest,
  type PgEndpoint,
  PickPathRequest,
  RestoreRequest,
  buildPgDumpInvocation,
  buildPgRestoreInvocation,
} from '@shared/pg-backup';
import {
  AiChatRequest,
  AiListModelsRequest,
  type AppMeta,
  AppUnsavedState,
  type CancelOutcome,
  CommitEditBatchRequest,
  CompareRunRequest,
  ConnectionConfig,
  type ConnectionConfig as ConnectionConfigType,
  type ConnectionEngine,
  type ConnectionInfo,
  type ConnectionRecovered,
  ConnectionSshConfig,
  type ConnectionTestResult,
  type DataFilePickResult,
  type EditConflict,
  ExplainRequest,
  ExportSaveRequest,
  type ExportSaveResult,
  type HistoryEntry,
  HistoryListOpts,
  IntrospectOpts,
  IpcChannel,
  type PingRequest,
  type PingResponse,
  type QueryResult,
  SafeRunFinishRequest,
  type SafeRunOutcome,
  type SafeRunReport,
  SafeRunStartRequest,
  type SavedConnection,
  type SchemaInfo,
  type Settings,
  SettingsShape,
  type SshHostKeyPrompt,
  type TxnState,
  type WorkerRequest,
  type WorkerResponse,
} from '@shared/protocol';
import { MAX_RESULT_ROWS } from '@shared/result-bounds';
import { isSqlEngine } from '@shared/sql-dialect';
import { isSingleSqlStatement, looksLikeWriteSql } from '@shared/sql-statements';
import { isUninferableParamError } from '@shared/sql-variables';
import { assertTlsAllowedForTag, resolveTls, withTunnelServername } from '@shared/tls';
import { describeLoss, joinLoss } from '@shared/unsaved-summary';
import { BrowserWindow, app, dialog, ipcMain, nativeImage, shell } from 'electron';
import {
  cancelAiChat,
  cancelAllAiChats,
  capAiToolJson,
  isAiRowDataAllowed,
  isAiSchemaAllowed,
  isReadOnlyRedisCommand,
  isReadOnlySql,
  serializeAiToolRows,
  setAiToolExecutor,
  shapeAgentActionResult,
  startAiChat,
  submitAiActionResult,
} from './ai';
import { listLocalModels, listOpenRouterModels, resolveModelsUrl } from './ai-models';
import { type AuditDeps, recordAuditStatements, registerAuditIpc } from './audit-ipc';
import { diagnosedError, runStagedTest } from './connect-diagnose';
import {
  ConnectionRecovery,
  type RecoveredSession,
  type RetainedSession,
} from './connection-recovery';
import {
  DATA_FILE_DIALOG_FILTERS,
  acceptDataFiles,
  assertDuckdbConfigAllowed,
  buildDuckdbAttachments,
  isEphemeralDuckdbSession,
  sanitizeDuckdbOptions,
} from './data-files';
import { closeDb, getDb } from './db';
import { registerE2EHooks } from './e2e-hooks';
import {
  clearHistory,
  deleteHistoryEntry,
  latestHistory,
  listHistory,
  recordHistory,
} from './history';
import { registerImportIpc } from './import-ipc';
import { initLogger, logger } from './logger';
import { buildAppMenu } from './menu';
import {
  assertOsWritable,
  parseOsRequestArgs,
  parseOsSearchArgs,
  parseOsSqlArgs,
} from './opensearch-ipc';
import { cancelAllJobs, cancelJob, detectTools, startJob } from './pg-admin';
import { materializeAdminTls, planAdminTls } from './pg-admin-tls';
import { registerPgListenIpc } from './pg-listen-ipc';
import { maskRowsForAi } from './presentation-mask';
import { describePsqlProblem, scanPsqlScript } from './psql-script-guard';
import { assertAllowedOnReadOnly } from './read-only-guard';
import {
  assertRedisCommandAllowed,
  assertRedisWritable,
  clampAnalyzeSample,
  parseRedisBulkDeleteArgs,
  parseRedisCommandArgs,
  parseRedisGetKeyArgs,
  parseRedisKeyArgs,
  parseRedisPatternDeleteArgs,
  parseRedisScanArgs,
  parseRedisSetTtlArgs,
  parseRedisWriteArgs,
} from './redis-ipc-args';
import {
  deleteSchemaSnapshot,
  getSchemaSnapshot,
  listSchemaSnapshots,
  saveSchemaSnapshot,
} from './schema-snapshots';
import { SessionGate, connectOrCleanUp } from './session-gate';
import { RecoveryRuntime } from './session-recovery';
import { applySettingsPatch, getAllSettings, getPublicSettings } from './settings';
import { formatSql } from './sql-format';
import {
  allowSqlitePath,
  assertSqlitePathAllowed,
  createSqliteFile,
  normalizeSqlitePath,
  sqliteFileProblem,
} from './sqlite-files';
import {
  HOST_KEY_PROMPT_TIMEOUT_MS,
  closeAllTunnels,
  closeTunnel,
  openTunnel,
  setHostKeyPrompt,
  tunnelForwardError,
} from './ssh-tunnel';
import { registerSupportIpc } from './support-ipc';
import { evaluateRestartMarker, installHandoverPending, readRestartMarker } from './update-restart';
import { type UpdaterHost, disposeUpdater, initUpdater } from './updater';
import {
  clearApiKeys,
  confirmWeakSecretStorage,
  duplicateConnection,
  getApiKey,
  getConnectionForEdit,
  getFullSshConfig,
  mergeSshSecretsForTest,
  migrateLingeringPlaintextSecrets,
  redactConnectionForRenderer,
  deleteConnection as vaultDelete,
  getFullConnection as vaultGetFull,
  listConnections as vaultList,
  saveConnection as vaultSave,
  withStoredPassword,
} from './vault';
import { guardIpcSenders, installWebSecurity } from './web-security';
import { applyThemeToWindow, createMainWindow, rendererEntry, resolveIconPath } from './window';
import { WorkerSupervisor } from './worker-supervisor';
import {
  createWorkspaceRuntime,
  handleStartupArgv,
  registerLaunchHandlers,
  registerWorkspaceIpc,
} from './workspace-ipc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let mainWindow: BrowserWindow | null = null;
const workerSupervisor = new WorkerSupervisor();

// Track the connection id associated with the currently-active worker
// connection so history entries can be linked back to the right vault row.
let activeConnectionId: string | null = null;
/** Monotonic revision stamped on query/sideband requests for chunk filtering (U15). */
let queryRequestRevision = 0;

// Track the active engine so the AI tool executor can dispatch the
// right tool call (sideband SQL vs Redis command vs OS search). Set
// by ConnectionConnect / VaultConnectById, cleared on disconnect.
let activeEngine: ConnectionEngine | null = null;
/** The server version of the live session, for the support bundle. */
let activeServerVersion: string | null = null;

/**
 * The session main opened, retained so a transport loss (VPN drop,
 * sleep, Wi-Fi switch) can be repaired without the user reconnecting by
 * hand (U27). Holds the password because that is what `connect`
 * requires; scoped to the live session and dropped on disconnect.
 */
let retainedSession: RetainedSession | null = null;
/** Who the audit log records statements for (the retained session, if any). */
const auditDeps: AuditDeps = {
  session: () =>
    retainedSession
      ? {
          id: retainedSession.id,
          name: retainedSession.config.name,
          user: retainedSession.config.user,
          engine: retainedSession.config.engine,
        }
      : null,
  window: () => mainWindow,
};
/**
 * C11: bumped whenever the user starts a connect or disconnect, so a
 * transparent recovery that is still in flight can tell it is stale.
 */
let sessionEpoch = 0;

// ─── App lifecycle ────────────────────────────────────────────────────

// Windows: set the AppUserModelID before any windows are created. This
// is what Windows uses to group taskbar buttons + attach the correct
// icon. Without it, Windows uses electron.exe's icon and groups Plasma
// windows under "Electron". Must be called synchronously early.
if (process.platform === 'win32') {
  app.setAppUserModelId('sh.plasma.app');
}

// E2E / agent isolation: redirect userData before any getPath('userData') use
// (logger, plasma.db). No-op when unset so production paths are unchanged.
if (process.env.PLASMA_USER_DATA) {
  app.setPath('userData', process.env.PLASMA_USER_DATA);
}

// C34: one instance per profile — a second one would share plasma.db and
// the worker. The lock is per userData dir, so isolated E2E runs coexist.
let hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock && installHandoverPending(app.getPath('userData'), Date.now())) {
  // An update restart: the installer (or the AppImage swap) starts the new
  // version while the old one is still shutting down and holds the lock. Wait
  // for it instead of quitting, which would leave the user with no window.
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 24 && !hasInstanceLock; attempt++) {
    Atomics.wait(pause, 0, 0, 500);
    hasInstanceLock = app.requestSingleInstanceLock();
  }
}
if (!hasInstanceLock) {
  // The running instance gets 'second-instance' and comes forward. Say so,
  // or `pnpm dev` just stops: on macOS (case-insensitive disk) the dev
  // profile `plasma` is the installed app's `Plasma`, so an open Plasma.app
  // holds the lock.
  console.error(
    `Plasma is already running with this profile (${app.getPath('userData')}). Quit it first, or set PLASMA_USER_DATA to another folder to run alongside it.`,
  );
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

// B2: crash recovery. The session marker says whether the last run ended
// cleanly; a crashed run's snapshot is set aside before this run can write its
// own. Only the instance that holds the lock owns these files.
const recovery = new RecoveryRuntime(app.getPath('userData'), (message) =>
  logger.warn(`[plasma] ${message}`),
);
let previousExit: ReturnType<RecoveryRuntime['start']> = { kind: 'clean' };
if (hasInstanceLock) {
  try {
    const now = Date.now();
    previousExit = recovery.start({
      version: app.getVersion(),
      now,
      pid: process.pid,
      // An update restart ends the old process on purpose; it is not a crash.
      updateRestart: evaluateRestartMarker(
        readRestartMarker(app.getPath('userData')),
        app.getVersion(),
        now,
      ).resume,
    });
  } catch {
    // Recovery is a safety net; failing to arm it must never stop the app.
  }
}

// D1/D2: workspaces, plasma:// links and the `plasma` launcher's arguments
// (open-url, second-instance argv). Registered before `ready` so a link that
// started the app is not missed.
const workspaceRuntime = createWorkspaceRuntime(() => mainWindow);
registerLaunchHandlers(workspaceRuntime, hasInstanceLock);

app
  .whenReady()
  .then(async () => {
    if (!hasInstanceLock) return;
    initLogger();
    // C19/C34: navigation + window.open + permission guards, and IPC only
    // from the app's own page. Before any window or handler exists.
    installWebSecurity(rendererEntry());
    guardIpcSenders(rendererEntry());
    registerE2EHooks(() => workerSupervisor);
    logger.info('[plasma] app ready, version', app.getVersion());
    if (previousExit.kind === 'unclean') {
      logger.warn(
        '[plasma] the previous run did not exit cleanly',
        previousExit.version ? `(version ${previousExit.version})` : '',
        previousExit.startedAt ? `started ${new Date(previousExit.startedAt).toISOString()}` : '',
      );
    }

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
    // C27: warn (and let the user refuse) when Linux has no keyring.
    await confirmWeakSecretStorage().catch((err) => {
      logger.error('[plasma] vault: keyring check failed:', err);
    });
    // C3: installs already at schema v3 may still hold plaintext secrets that
    // older builds wrote into settings — move them into the vault.
    try {
      migrateLingeringPlaintextSecrets();
    } catch (err) {
      logger.error('[plasma] vault: re-migration of plaintext secrets failed:', err);
    }

    await workerSupervisor.start(join(__dirname, 'workers/index.js'));

    // Forward worker broadcasts (Redis pub/sub, Postgres NOTICE) to the
    // renderer over dedicated event channels.
    workerSupervisor.setBroadcastHandler((evt) => {
      if (evt.kind === 'redisPubsub') {
        mainWindow?.webContents.send('plasma:redis:pubsub', evt.message);
      } else if (evt.kind === 'queryChunk') {
        mainWindow?.webContents.send('plasma:query:chunk', evt);
      } else if (evt.kind === 'pgNotification') {
        mainWindow?.webContents.send('plasma:pg:notification', evt.notification);
      } else if (evt.kind === 'pgNotice') {
        mainWindow?.webContents.send('plasma:pg:notice', evt.notice);
      } else if (evt.kind === 'importProgress') {
        mainWindow?.webContents.send('plasma:import:progress', evt.progress);
      } else if (evt.kind === 'exportProgress') {
        mainWindow?.webContents.send('plasma:export:progress', evt.progress);
      }
    });

    // Worker crash after readiness invalidates the live connection — the
    // respawned worker has no DB session (U20). Nothing to recover here:
    // the process that held the session is gone, so drop the retained
    // session too and let the renderer fall back to the connect screen.
    workerSupervisor.setCrashHandler(() => {
      const id = activeConnectionId;
      activeConnectionId = null;
      activeEngine = null;
      retainedSession = null;
      if (id) closeTunnel(id);
      mainWindow?.webContents.send(IpcChannel.WorkerResetEvent);
    });

    // AI tools dispatch by the active engine. Postgres uses the worker
    // aux connection so tool queries don't queue behind a long primary
    // query and never block cancel (U19); Redis routes through the
    // read-only command list; OpenSearch hits search / SQL plugin.
    setAiToolExecutor(async (name, args) => {
      if (name === 'query_database') {
        if (!isSqlEngine(activeEngine)) {
          return JSON.stringify({ error: 'no SQL connection' });
        }
        const sql = typeof args.sql === 'string' ? args.sql : '';
        if (!sql) return JSON.stringify({ error: 'missing sql arg' });
        if (!isReadOnlySql(sql)) {
          return JSON.stringify({
            error: 'rejected: only SELECT / EXPLAIN / SHOW / WITH / VALUES / TABLE allowed',
          });
        }
        try {
          // aiQuery runs on the aux client inside BEGIN … READ ONLY and
          // rejects multi-statement SQL (C18) — the regex above is only a
          // pre-filter.
          const res = await callWorker({ kind: 'aiQuery', sql }, 'queryResult');
          return serializeAiToolRows({
            columns: res.result.columns.map((c) => c.name),
            rows: maskRowsForAi(activeConnectionId, res.result.columns, res.result.rows),
            rowCount: res.result.rowCount,
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
            error: `rejected: ${parts[0]}${parts[1] ? ` ${parts[1]}` : ''} is not in the read-only allow-list`,
          });
        }
        try {
          const res = await callWorker({ kind: 'redisCommand', parts }, 'redisCommand');
          return capAiToolJson({
            command: res.result.command,
            args: res.result.args,
            reply: res.result.reply,
            durationMs: res.result.durationMs,
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
          const res = await callWorker({ kind: 'osSearch', index, body, size: 50 }, 'osSearch');
          return capAiToolJson({
            total: res.result.total,
            took: res.result.took,
            hits: res.result.hits.slice(0, 50),
            fields: res.result.fields,
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
        if (!isReadOnlyOsSql(query)) {
          return JSON.stringify({ error: 'only a single SELECT / SHOW / DESCRIBE allowed' });
        }
        try {
          const res = await callWorker({ kind: 'osSql', query }, 'osSql');
          const rowsObj = res.result.rows
            .slice(0, 50)
            .map((row) => Object.fromEntries(res.result.columns.map((c, i) => [c.name, row[i]])));
          return capAiToolJson({
            rowCount: res.result.rows.length,
            columns: res.result.columns,
            rows: rowsObj,
            durationMs: res.result.durationMs,
            truncated: res.result.rows.length > 50,
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
    attachWindowGuards(mainWindow);
    buildAppMenu();
    registerIpcHandlers();
    registerWorkspaceIpc(workspaceRuntime, () => mainWindow);
    registerSupportIpc({
      window: () => mainWindow,
      active: () =>
        retainedSession && activeEngine
          ? { engine: activeEngine, serverVersion: activeServerVersion ?? 'unknown' }
          : null,
      connections: () => vaultList(),
      settings: () => getAllSettings(),
    });
    handleStartupArgv(workspaceRuntime);
    // C33: the updater follows whichever window is current (macOS reopen).
    initUpdater(() => mainWindow, updaterHost);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow();
        attachWindowGuards(mainWindow);
      }
    });
  })
  .catch((err) => {
    // Anything thrown during boot (native module ABI mismatch, DB migration,
    // worker ready timeout) used to surface only as an unhandled rejection:
    // the process stayed alive with no window and no cause anywhere. Log it
    // to main.log + stderr and exit non-zero so launchers fail fast.
    logger.error('[plasma] boot failed — no window created', err);
    console.error('[plasma] boot failed:', err instanceof Error ? err.stack || err.message : err);
    app.exit(1);
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

// C32: 'will-quit', not 'before-quit' — a window can still cancel the
// quit from its close guard, and the worker must survive that.
app.on('will-quit', () => {
  // B2: reaching here is a clean quit; a crash never does. (A second instance
  // that lost the lock must not remove the running one's marker.)
  if (hasInstanceLock) recovery.end();
  cancelAllJobs();
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

/** Requests that are part of a session change themselves and must not wait for it. */
const SESSION_PLUMBING_KINDS: ReadonlySet<WorkerRequest['kind']> = new Set([
  'connect',
  'disconnect',
  'testConnect',
  'ping',
]);

async function callWorker<K extends WorkerResponse['kind']>(
  req: DistributiveOmit<WorkerRequest, 'id'>,
  expected: K,
): Promise<Extract<WorkerResponse, { kind: K }>> {
  // U27: a request that died with the transport is retried once on a
  // freshly re-established session; see connection-recovery.ts.
  const loose = req as { kind: WorkerRequest['kind'] } & Record<string, unknown>;
  // SC-29: a connect/disconnect in flight will change which session (and
  // which read-only flag) this request runs against; evaluate the guard
  // and post the request only once the session has settled.
  if (!SESSION_PLUMBING_KINDS.has(req.kind)) {
    await sessionGate.settled();
  }
  // C1: one guard for every engine and every route — whatever handler
  // issued it, a write never reaches the worker on a read-only session.
  if (retainedSession?.config.readOnly === true) {
    assertAllowedOnReadOnly(loose, retainedSession.config.engine);
  }
  return connectionRecovery.run(
    req.kind,
    async () => {
      const id = randomUUID();
      const res = await workerSupervisor.request({ ...req, id } as WorkerRequest);
      if (res.kind === 'error') {
        if (res.fatal === CONNECTION_LOST) {
          const lost = new ConnectionLostError(res.message);
          // C5: recovery must not replay into a fresh session.
          if (res.txnLost) Object.assign(lost, { txnLost: true });
          throw lost;
        }
        // The codes the error carried (SQLSTATE, errno, HTTP status...) travel with it,
        // so a failed connect can be explained in plain words (connect-diagnosis.ts).
        throw Object.assign(new Error(res.message), res.info ?? {});
      }
      if (res.kind !== expected) {
        throw new Error(`unexpected worker response: ${res.kind} (expected ${expected})`);
      }
      return res as Extract<WorkerResponse, { kind: K }>;
    },
    loose,
  );
}

/**
 * Re-establish the retained session after a transport loss: reopen the
 * SSH tunnel when the connection uses one (the tunnel died with the
 * network too), reconnect the worker, and tell the renderer which
 * generation it is now talking to (U27).
 */
const connectionRecovery = new ConnectionRecovery({
  session: () => retainedSession,
  epoch: () => sessionEpoch,
  reopenTunnel: async (session) => {
    const settings = SettingsShape.parse(getAllSettings());
    const ssh = getFullSshConfig(session.id, settings.connectionSsh);
    if (!ssh) throw new Error(`ssh config for ${session.id} is gone — reconnect manually`);
    // The old tunnel's sockets are dead; drop them before re-forwarding.
    closeTunnel(session.id);
    return openTunnel({
      id: session.id,
      ssh,
      pgHost: session.config.host,
      pgPort: session.config.port,
    });
  },
  connect: async (session, dial) => {
    const config = {
      ...session.config,
      readOnly: session.config.readOnly ?? false,
      ...(dial ?? {}),
    };
    const res = await callWorker(
      { kind: 'connect', config, statementTimeoutMs: currentQueryTimeoutMs() },
      'connected',
    );
    return {
      serverVersion: res.serverVersion,
      engine: res.engine,
      connectionGen: res.connectionGen ?? 0,
      attempts: 1,
    };
  },
  onRecovered: (recovered: RecoveredSession) => {
    // Only reached when the epoch is unchanged (C11), i.e. still this session.
    if (recovered.connectionId) activeConnectionId = recovered.connectionId;
    activeEngine = recovered.engine;
    activeServerVersion = recovered.serverVersion;
    const payload: ConnectionRecovered = recovered;
    mainWindow?.webContents.send(IpcChannel.ConnectionRecoveredEvent, payload);
  },
  onLost: (reason) => {
    logger.error('[plasma] connection unrecoverable:', reason);
    const id = activeConnectionId;
    activeConnectionId = null;
    activeEngine = null;
    retainedSession = null;
    if (id) closeTunnel(id);
    mainWindow?.webContents.send(IpcChannel.WorkerResetEvent);
  },
  log: (message, err) => {
    if (err === undefined) logger.info(message);
    else logger.error(message, err);
  },
});

/** Settings → result size cap in bytes (P2-3); the worker clamps it to 256 MiB. */
function resultMaxBytes(): number | undefined {
  const mb = SettingsShape.parse(getAllSettings()).resultMaxMegabytes;
  return mb ? mb * 1024 * 1024 : undefined;
}

function currentQueryTimeoutMs(): number {
  return SettingsShape.parse(getAllSettings()).queryTimeoutMs;
}

/** Push queryTimeoutMs → PG statement_timeout on primary+aux (U20). */
async function applyStatementTimeout(timeoutMs = currentQueryTimeoutMs()): Promise<void> {
  try {
    await callWorker({ kind: 'setStatementTimeout', timeoutMs }, 'statementTimeoutSet');
  } catch (err) {
    logger.error('[plasma] failed to apply statement_timeout:', err);
  }
}

// ─── IPC handlers ─────────────────────────────────────────────────────

// ─── Connection session helpers (C2/C4/C9/C10/C11/C12/C13/C21) ─────────

/** One connect/disconnect at a time from main (C12). */
const sessionGate = new SessionGate();
function serializeSessionChange<T>(fn: () => Promise<T>): Promise<T> {
  return sessionGate.serialize(fn);
}

/** Parse a renderer config, with a readable message instead of Zod JSON (F6). */
function parseConnectionConfig(raw: unknown): ConnectionConfigType {
  const parsed = ConnectionConfig.safeParse(raw);
  if (parsed.success) {
    // A SQLite file may only be one the user picked in the native dialog
    // (or the one already saved for this very connection).
    if (parsed.data.engine === 'sqlite') {
      const saved = vaultList().find((c) => c.id === parsed.data.id);
      assertSqlitePathAllowed(
        parsed.data.database,
        saved?.engine === 'sqlite' ? saved.database : null,
      );
    }
    if (parsed.data.engine === 'duckdb') {
      const saved = vaultList().find((c) => c.id === parsed.data.id);
      // Only main fills in `attach` (it carries a password); anything the renderer sent is dropped.
      const config = { ...parsed.data, duckdb: sanitizeDuckdbOptions(parsed.data.duckdb) };
      assertDuckdbConfigAllowed(config, saved?.engine === 'duckdb' ? saved.database : null);
      return config;
    }
    return parsed.data;
  }
  const first = parsed.error.issues[0];
  const field = first?.path.join('.') || 'connection';
  throw new Error(`Invalid ${field}: ${first?.message ?? 'check the connection details'}`);
}

/** C9: read the CA / client cert / key files the user picked into PEM text. */
async function withTlsFiles(config: ConnectionConfigType): Promise<ConnectionConfigType> {
  const tls = config.tls;
  if (!config.ssl || !tls) return config;
  const read = async (path: string | undefined, what: string): Promise<string | undefined> => {
    if (!path?.trim()) return undefined;
    try {
      return await readFile(path, 'utf8');
    } catch (err) {
      throw new Error(
        `Could not read the TLS ${what} file ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
  const [ca, cert, key] = await Promise.all([
    read(tls.caFile, 'CA'),
    read(tls.certFile, 'client certificate'),
    read(tls.keyFile, 'client key'),
  ]);
  return {
    ...config,
    tls: { ...tls, ca: ca ?? tls.ca, cert: cert ?? tls.cert, key: key ?? tls.key },
  };
}

type SshTarget = NonNullable<ReturnType<typeof getFullSshConfig>>;

/**
 * SSH config for a Test. `rawSsh` is what the dialog holds right now:
 * null = SSH off, undefined = use what is saved, an object = the form's
 * values with blank secrets meaning "the saved ones".
 */
function testSshConfig(id: string, rawSsh: unknown): SshTarget | null {
  const settings = SettingsShape.parse(getAllSettings());
  const saved = getFullSshConfig(id, settings.connectionSsh);
  if (rawSsh === undefined) return saved;
  if (rawSsh === null) return null;
  const form = ConnectionSshConfig.parse(rawSsh);
  if (!form.host || !form.user) return null;
  // Blank secrets mean "the saved ones" — only for the same bastion + login.
  return mergeSshSecretsForTest(form, saved);
}

/** Drop main's idea of the live session (and its tunnel). */
function clearSession(): void {
  const id = activeConnectionId;
  activeConnectionId = null;
  activeEngine = null;
  retainedSession = null;
  if (id) closeTunnel(id);
}

/**
 * Open the worker session for `config`: TLS policy + files, tunnel (with
 * the real host as TLS servername), connect, and record it for recovery.
 * Callers hold `serializeSessionChange`.
 */
async function establishSession(config: ConnectionConfigType) {
  sessionEpoch++;
  let ssh: ReturnType<typeof getFullSshConfig> = null;
  // SC-07: everything that can fail sits inside the try, so any failure
  // (TLS policy, unreadable cert file, tunnel, host-key refusal) leaves
  // main AND the worker disconnected, in agreement with what the UI shows.
  const attempt = async () => {
    const settings = SettingsShape.parse(getAllSettings());
    // C4: unverified TLS is refused for prod-tagged connections.
    assertTlsAllowedForTag(resolveTls(config), settings.connectionTags?.[config.id]);
    const withFiles = await withTlsFiles(config);
    ssh = getFullSshConfig(config.id, settings.connectionSsh);

    // C13: switching connection closes the previous one's tunnel; a
    // reconnect to the same one gets a fresh tunnel rather than a stale one.
    const previousId = activeConnectionId;
    if (previousId && previousId !== config.id) closeTunnel(previousId);
    if (ssh) closeTunnel(config.id);

    let effective: ConnectionConfigType = { ...withFiles, readOnly: config.readOnly ?? false };
    if (config.engine === 'duckdb' && config.duckdb?.attachConnectionIds?.length) {
      // Saved Postgres connections to attach read-only: resolved here, in main, with their stored passwords.
      effective = {
        ...effective,
        duckdb: {
          files: config.duckdb.files,
          installPostgresExtension: config.duckdb.installPostgresExtension,
          installExcelExtension: config.duckdb.installExcelExtension,
          attach: buildDuckdbAttachments(config.duckdb.attachConnectionIds, {
            load: (id) => vaultGetFull(id),
            sshFor: (id) => getFullSshConfig(id, settings.connectionSsh) !== null,
          }),
        },
      };
    }
    if (ssh) {
      const refusal = sshUnsupportedReason(config);
      if (refusal) throw new Error(refusal);
      const local = await openTunnel({
        id: config.id,
        ssh,
        pgHost: config.host,
        pgPort: config.port,
      });
      // C10: the certificate names the real host, not 127.0.0.1.
      effective = {
        ...withTunnelServername(effective, config.host),
        host: local.host,
        port: local.port,
      };
    }
    let res: Awaited<ReturnType<typeof callWorker<'connected'>>>;
    try {
      res = await callWorker(
        {
          kind: 'connect',
          config: { ...effective, readOnly: config.readOnly ?? false },
          statementTimeoutMs: currentQueryTimeoutMs(),
        },
        'connected',
      );
    } catch (err) {
      // Read before the cleanup closes the tunnel: the jump host's own reason.
      if (ssh) {
        const forwardError = tunnelForwardError(config.id);
        if (forwardError) Object.assign(err as Error, { forwardError });
      }
      throw err;
    }
    activeConnectionId = config.id;
    activeEngine = res.engine;
    activeServerVersion = res.serverVersion;
    // U27: keep what it takes to rebuild this session after a transport
    // loss. Host/port are the pre-tunnel ones so a retry re-forwards
    // through a fresh tunnel.
    retainedSession = {
      id: config.id,
      config: { ...effective, host: config.host, port: config.port },
      tunnelled: Boolean(ssh),
    };
    return res;
  };
  return connectOrCleanUp(attempt, async () => {
    // C21: the worker tore the previous session down before dialling, so
    // main must not keep claiming it. When the failure came before the
    // worker was reached, the previous session is still open there: close it.
    clearSession();
    if (ssh) closeTunnel(config.id);
    await callWorker({ kind: 'disconnect' }, 'disconnected').catch(() => undefined);
  }).catch((err: unknown) => {
    // Say what went wrong in plain words: the message carries the diagnosis.
    throw diagnosedError(err, config, {
      ssh,
      forwardError: (err as { forwardError?: string } | null)?.forwardError,
    });
  });
}

// ─── SSH host-key prompt (C8) ─────────────────────────────────────────

const hostKeyWaiters = new Map<string, (accept: boolean) => void>();
// HOST_KEY_PROMPT_TIMEOUT_MS (ssh-tunnel.ts) is shorter than the ssh ready timeout (SC-17).

setHostKeyPrompt((info) => {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return Promise.resolve(false);
  const requestId = randomUUID();
  const payload: SshHostKeyPrompt = { requestId, ...info };
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      hostKeyWaiters.delete(requestId);
      resolve(false);
    }, HOST_KEY_PROMPT_TIMEOUT_MS);
    hostKeyWaiters.set(requestId, (accept) => {
      clearTimeout(timer);
      resolve(accept);
    });
    win.webContents.send(IpcChannel.SshHostKeyPromptEvent, payload);
  });
});

// ─── Quit / close guard (C32) ─────────────────────────────────────────

let unsavedState: AppUnsavedState = { openTransaction: false, pendingEdits: 0 };
let closeConfirmed = false;

function describeUnsaved(state: AppUnsavedState): string | null {
  const parts = describeLoss(state);
  return parts.length > 0 ? `You have ${joinLoss(parts)}.` : null;
}

/**
 * What the updater needs from the app. `shutdownForUpdate` is the clean stop
 * before the installer takes over: the user already confirmed what would be
 * lost, so the close guard is released, the session is disconnected (rolling
 * back any open transaction), tunnels and the worker end and the local store
 * is closed, all with a time limit so a stuck server cannot block the update.
 */
const updaterHost: UpdaterHost = {
  getUnsaved: () => unsavedState,
  getActiveConnectionId: () => activeConnectionId,
  getWorkspaceRoot: () =>
    workspaceRuntime.workspace.isOpen ? workspaceRuntime.workspace.rootPath : null,
  reopenWorkspace: (root) => {
    // Only a folder the user approved before; the marker alone never opens anything new.
    if (!workspaceRuntime.recents.has(root)) return;
    workspaceRuntime.recents.add(workspaceRuntime.workspace.open(root).root);
  },
  async shutdownForUpdate() {
    closeConfirmed = true;
    cancelAllAiChats();
    cancelAllJobs();
    const stopSession = serializeSessionChange(async () => {
      sessionEpoch++;
      clearSession();
      await callWorker({ kind: 'disconnect' }, 'disconnected').catch(() => undefined);
    });
    await Promise.race([stopSession, new Promise<void>((r) => setTimeout(r, 6000))]).catch((err) =>
      logger.warn('[plasma] session stop before update failed', err),
    );
    closeAllTunnels();
    workerSupervisor.stop();
    closeDb();
    // The installer ends this process without 'will-quit': this restart is on purpose.
    recovery.end();
  },
  relaunchAfterFailedInstall() {
    logger.error('[plasma] the update did not start; relaunching the current version');
    app.relaunch(process.env.APPIMAGE ? { execPath: process.env.APPIMAGE } : undefined);
    app.exit(0);
  },
};

/**
 * B2: the window's process died (crash, out of memory, killed) while the app
 * stayed up. Its snapshot is set aside, and the window reloads so the renderer
 * restores tabs and staged edits the same way a restart would. It never
 * replays anything, and a window that keeps crashing is left alone.
 */
function handleRendererGone(win: BrowserWindow, reason: string, exitCode: number): void {
  if (reason === 'clean-exit') return;
  logger.error(`[plasma] the window process ended unexpectedly: ${reason} (exit code ${exitCode})`);
  unsavedState = { openTransaction: false, pendingEdits: 0 };
  let reload = false;
  try {
    reload = recovery.rendererGone(Date.now()).reload;
  } catch (err) {
    logger.warn('[plasma] could not set the window snapshot aside', err);
  }
  if (win.isDestroyed()) return;
  if (reload) {
    setTimeout(() => {
      if (!win.isDestroyed()) win.webContents.reload();
    }, 300);
    return;
  }
  logger.error('[plasma] the window keeps crashing; not reloading it again');
  dialog.showErrorBox(
    'Plasma keeps closing its window',
    'Your tabs and staged edits are saved and will be offered again the next time you open Plasma. Nothing was committed or re-run.',
  );
}

function attachWindowGuards(win: BrowserWindow): void {
  // Agent cards wait for a click in the renderer. When the page reloads, the
  // process dies or the window closes nobody can answer them: release the chat.
  win.webContents.on('did-start-navigation', (_e, _url, inPlace, isMainFrame) => {
    if (isMainFrame && !inPlace) cancelAllAiChats();
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    cancelAllAiChats();
    handleRendererGone(win, details.reason, details.exitCode);
  });
  win.on('closed', () => cancelAllAiChats());
  win.on('close', (e) => {
    if (closeConfirmed) return;
    const detail = describeUnsaved(unsavedState);
    if (!detail) return;
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Cancel', 'Discard and close'],
      defaultId: 0,
      cancelId: 0,
      message: 'Close Plasma and discard your work?',
      detail,
    });
    if (choice === 1) {
      closeConfirmed = true;
      win.close();
    }
  });
  // C33: on macOS the app outlives its window. The next window starts
  // idle, so drop the session it can no longer see instead of leaving the
  // worker and tunnel connected behind it.
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
    workspaceRuntime.launch.rendererGone();
    unsavedState = { openTransaction: false, pendingEdits: 0 };
    closeConfirmed = false;
    // The user closed the window on purpose (after the discard prompt, if any).
    void recovery.save(null);
    if (!retainedSession && !activeConnectionId) return;
    void serializeSessionChange(async () => {
      sessionEpoch++;
      clearSession();
      await callWorker({ kind: 'disconnect' }, 'disconnected').catch(() => undefined);
    });
  });
}

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
    (_e, rawConfig: unknown): Promise<ConnectionInfo> =>
      serializeSessionChange(async () => {
        const requested = parseConnectionConfig(rawConfig);
        // D1: a team-workspace profile is rebuilt from its `.plasma/` file and the
        // vault in main — nothing the renderer sent but the id is trusted — and it
        // is never copied into the personal connection list.
        const workspaceConfig = workspaceRuntime.connectConfigFor(requested.id);
        // Blank password = keep the saved one (C17: the renderer never has it).
        const config = workspaceConfig ?? withStoredPassword(requested);
        const res = await establishSession(config);
        // A session over data files is not a saved connection.
        if (!workspaceConfig && !isEphemeralDuckdbSession(config)) {
          try {
            vaultSave(config);
          } catch (err) {
            logger.error('[plasma] vault save failed (non-fatal):', err);
          }
        }
        return {
          serverVersion: res.serverVersion,
          engine: res.engine,
          connectionGen: res.connectionGen,
        };
      }),
  );

  ipcMain.handle(
    IpcChannel.ConnectionDisconnect,
    (): Promise<void> =>
      serializeSessionChange(async () => {
        sessionEpoch++;
        const id = activeConnectionId;
        activeConnectionId = null;
        activeEngine = null;
        retainedSession = null;
        // C22: the tunnel goes even when the worker call fails or times out.
        try {
          await callWorker({ kind: 'disconnect' }, 'disconnected');
        } finally {
          if (id) closeTunnel(id);
        }
      }),
  );

  ipcMain.handle(
    IpcChannel.ConnectionTest,
    async (_e, rawConfig: unknown, rawSsh: unknown): Promise<ConnectionTestResult> => {
      // C2: a throwaway driver in the worker (`testConnect`) and, for SSH,
      // a throwaway tunnel — the live session is never touched. The test runs
      // as steps (host, port, TLS, login, database) so a failure says where.
      const tunnelKey = `test:${randomUUID()}`;
      let tunnelled = false;
      let config: ConnectionConfigType | null = null;
      let ssh: ReturnType<typeof testSshConfig> = null;
      try {
        config = await withTlsFiles(withStoredPassword(parseConnectionConfig(rawConfig)));
        ssh = testSshConfig(config.id, rawSsh);
        const tested = config;
        if (ssh) {
          const refusal = sshUnsupportedReason(tested);
          if (refusal) throw new Error(refusal);
        }
        return await runStagedTest(
          tested,
          {
            openTunnel: ssh
              ? async () => {
                  const local = await openTunnel({
                    id: tunnelKey,
                    ssh: ssh as NonNullable<typeof ssh>,
                    pgHost: tested.host,
                    pgPort: tested.port,
                  });
                  tunnelled = true;
                  return local;
                }
              : undefined,
            connect: async (target) => {
              const effective: ConnectionConfigType = ssh
                ? {
                    ...withTunnelServername(tested, tested.host),
                    host: target.host,
                    port: target.port,
                  }
                : tested;
              try {
                const res = await callWorker(
                  {
                    kind: 'testConnect',
                    config: { ...effective, readOnly: effective.readOnly ?? false },
                  },
                  'connected',
                );
                return {
                  serverVersion: res.serverVersion,
                  engine: res.engine,
                  clusterStatus: res.clusterStatus,
                };
              } catch (err) {
                if (ssh) {
                  const forwardError = tunnelForwardError(tunnelKey);
                  if (forwardError) Object.assign(err as Error, { forwardError });
                }
                throw err;
              }
            },
            forwardError: () => tunnelForwardError(tunnelKey),
          },
          ssh,
        );
      } catch (err) {
        // Before the steps could start: a bad config, an unreadable certificate file.
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, message };
      } finally {
        if (tunnelled) closeTunnel(tunnelKey);
      }
    },
  );

  ipcMain.handle(
    IpcChannel.ConnectionPickFile,
    async (e, title: unknown): Promise<string | null> => {
      const win = BrowserWindow.fromWebContents(e.sender);
      const opts = {
        title: typeof title === 'string' && title ? title : 'Choose a file',
        properties: ['openFile' as const, 'showHiddenFiles' as const],
      };
      const picked = win
        ? await dialog.showOpenDialog(win, opts)
        : await dialog.showOpenDialog(opts);
      return picked.canceled ? null : (picked.filePaths[0] ?? null);
    },
  );

  ipcMain.handle(
    IpcChannel.ConnectionPickSqlite,
    async (e, rawMode: unknown): Promise<string | null> => {
      const win = BrowserWindow.fromWebContents(e.sender);
      const create = rawMode === 'create';
      const filters = [
        { name: 'SQLite database', extensions: ['db', 'sqlite', 'sqlite3', 'db3', 's3db'] },
        { name: 'All files', extensions: ['*'] },
      ];
      let picked: string | undefined;
      if (create) {
        const opts = { title: 'Create a SQLite database', defaultPath: 'database.db', filters };
        const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
        picked = r.canceled ? undefined : r.filePath;
      } else {
        const opts = {
          title: 'Open a SQLite database',
          filters,
          properties: ['openFile' as const, 'showHiddenFiles' as const],
        };
        const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
        picked = r.canceled ? undefined : r.filePaths[0];
      }
      if (!picked) return null;
      if (create) createSqliteFile(picked);
      else {
        const problem = sqliteFileProblem(picked);
        if (problem) throw new Error(problem);
      }
      allowSqlitePath(picked);
      return picked;
    },
  );

  // DuckDB "Open data file…" / database picker. Main validates and allowlists
  // the paths; the renderer only ever sees what passed.
  ipcMain.handle(
    IpcChannel.DataFilePick,
    async (e, rawTarget: unknown): Promise<DataFilePickResult | null> => {
      const win = BrowserWindow.fromWebContents(e.sender);
      const database = rawTarget === 'database';
      const opts = {
        title: database ? 'Open a DuckDB database' : 'Open data files',
        filters: database ? DATA_FILE_DIALOG_FILTERS.database : DATA_FILE_DIALOG_FILTERS.files,
        properties: database
          ? ['openFile' as const, 'showHiddenFiles' as const]
          : ['openFile' as const, 'multiSelections' as const, 'showHiddenFiles' as const],
      };
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      if (r.canceled || r.filePaths.length === 0) return null;
      const { accepted, problems } = acceptDataFiles(r.filePaths);
      return { files: accepted, problems };
    },
  );

  // Files dropped on the window: the preload read the paths, main validates them.
  ipcMain.on(IpcChannel.DataFileDrop, (e, paths: unknown) => {
    if (!mainWindow || e.sender !== mainWindow.webContents) return;
    const { accepted, problems } = acceptDataFiles(paths);
    const payload: DataFilePickResult = { files: accepted, problems };
    mainWindow.webContents.send(IpcChannel.DataFilesDroppedEvent, payload);
  });

  // "Export database file copy": the worker runs SQLite's backup API; main
  // only chooses where the copy goes.
  ipcMain.handle(
    IpcChannel.SqliteBackupCopy,
    async (e): Promise<{ filePath: string; bytes: number } | null> => {
      if (activeEngine !== 'sqlite' || !retainedSession) {
        throw new Error('No SQLite database is open.');
      }
      const win = BrowserWindow.fromWebContents(e.sender);
      const source = retainedSession.config.database;
      const base = source.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '') || 'database';
      const opts = {
        title: 'Export database file copy',
        defaultPath: `${base}-copy.db`,
        filters: [{ name: 'SQLite database', extensions: ['db', 'sqlite', 'sqlite3'] }],
      };
      const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
      if (r.canceled || !r.filePath) return null;
      if (normalizeSqlitePath(r.filePath) === normalizeSqlitePath(source)) {
        throw new Error('Choose a different file than the database itself.');
      }
      const done = await callWorker(
        { kind: 'sqliteBackup', filePath: r.filePath },
        'sqliteBackupDone',
      );
      return { filePath: done.filePath, bytes: done.bytes };
    },
  );

  ipcMain.handle(IpcChannel.SshHostKeyRespond, (_e, raw: unknown): void => {
    const p = (raw ?? {}) as { requestId?: unknown; accept?: unknown };
    if (typeof p.requestId !== 'string') return;
    const waiter = hostKeyWaiters.get(p.requestId);
    hostKeyWaiters.delete(p.requestId);
    waiter?.(p.accept === true);
  });

  ipcMain.handle(IpcChannel.AppSetUnsavedState, (_e, raw: unknown): void => {
    unsavedState = AppUnsavedState.parse(raw);
  });

  // B2: crash recovery. The renderer keeps a snapshot of the live workspace
  // here; after a crash the next launch asks what is waiting.
  ipcMain.on(IpcChannel.RecoverySave, (e, raw: unknown, durable: unknown) => {
    if (!mainWindow || e.sender !== mainWindow.webContents) return;
    void recovery.save(raw, durable === true);
  });
  ipcMain.handle(
    IpcChannel.RecoveryFlush,
    (_e, raw: unknown): Promise<boolean> => recovery.save(raw, true),
  );
  ipcMain.handle(IpcChannel.RecoveryLaunchInfo, () =>
    recovery.launchInfo(existsSync(join(app.getPath('userData'), 'logs', 'main.log'))),
  );
  ipcMain.handle(
    IpcChannel.RecoveryResolve,
    (_e, connectionId: unknown, keepAsRestored: unknown): void => {
      recovery.resolve(
        typeof connectionId === 'string' ? connectionId : undefined,
        keepAsRestored === true,
      );
    },
  );
  ipcMain.handle(IpcChannel.RecoveryShowLog, (): void => {
    shell.showItemInFolder(join(app.getPath('userData'), 'logs', 'main.log'));
  });

  // Postgres-only schema introspect. For redis/opensearch the renderer
  // calls the engine-specific overview channels directly.
  ipcMain.handle(
    IpcChannel.ConnectionIntrospect,
    async (_e, opts: unknown): Promise<SchemaInfo> => {
      const parsed = opts === undefined || opts === null ? undefined : IntrospectOpts.parse(opts);
      const res = await callWorker({ kind: 'introspect', opts: parsed }, 'schemaInfo');
      return res.info;
    },
  );

  // ── Vault ──

  ipcMain.handle(IpcChannel.VaultList, (): SavedConnection[] => vaultList());

  ipcMain.handle(IpcChannel.VaultDelete, (_e, id: unknown): void => {
    if (typeof id !== 'string') throw new Error('id must be a string');
    vaultDelete(id);
  });

  ipcMain.handle(
    IpcChannel.VaultConnectById,
    (_e, id: unknown): Promise<{ info: ConnectionInfo; config: SavedConnection }> =>
      serializeSessionChange(async () => {
        if (typeof id !== 'string') throw new Error('id must be a string');
        const config = vaultGetFull(id);
        if (!config) throw new Error(`no saved connection with id ${id}`);
        const res = await establishSession(config);
        const safeConfig = redactConnectionForRenderer(config);
        return {
          info: {
            serverVersion: res.serverVersion,
            engine: res.engine,
            connectionGen: res.connectionGen,
          },
          config: safeConfig,
        };
      }),
  );

  ipcMain.handle(IpcChannel.VaultSave, (_e, rawConfig: unknown): SavedConnection => {
    // Blank password / OpenSearch secrets = keep the saved ones (C17).
    const config = withStoredPassword(parseConnectionConfig(rawConfig));
    vaultSave(config);
    return redactConnectionForRenderer(config);
  });

  ipcMain.handle(IpcChannel.VaultDuplicate, (_e, id: unknown): SavedConnection => {
    if (typeof id !== 'string') throw new Error('id must be a string');
    const newId = randomUUID();
    const copy = duplicateConnection(id, newId);
    if (!copy) throw new Error(`no saved connection with id ${id}`);
    // Tag, SSH tunnel (with its secrets) and safe-mode level follow the copy.
    const settings = SettingsShape.parse(getAllSettings());
    const patch: Record<string, unknown> = {};
    const tag = settings.connectionTags?.[id];
    if (tag) patch.connectionTags = { ...settings.connectionTags, [newId]: tag };
    const level = settings.connectionSafeMode?.[id];
    if (level) patch.connectionSafeMode = { ...settings.connectionSafeMode, [newId]: level };
    const safeRun = settings.connectionAlwaysSafeRun?.[id];
    if (safeRun !== undefined) {
      patch.connectionAlwaysSafeRun = { ...settings.connectionAlwaysSafeRun, [newId]: safeRun };
    }
    const ssh = getFullSshConfig(id, settings.connectionSsh);
    if (ssh) patch.connectionSsh = { ...settings.connectionSsh, [newId]: ssh };
    if (Object.keys(patch).length > 0) applySettingsPatch(patch);
    return copy;
  });

  ipcMain.handle(IpcChannel.VaultGetConfig, (_e, id: unknown): ConnectionConfigType | null => {
    if (typeof id !== 'string') throw new Error('id must be a string');
    // Edit flow: the password is never sent to the renderer (C17). A blank
    // password on connect/test means "keep the saved one" (withStoredPassword).
    return getConnectionForEdit(id);
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
    let maxRows: number | undefined;
    let auditSource: 'editor' | 'ai' = 'editor';
    if (typeof payload === 'string') {
      sql = payload;
    } else if (payload && typeof payload === 'object' && 'sql' in payload) {
      const p = payload as { sql: unknown; params?: unknown; internal?: unknown };
      if (typeof p.sql !== 'string') throw new Error('sql must be a string');
      sql = p.sql;
      params = Array.isArray(p.params) ? p.params : undefined;
      internal = p.internal === true;
      if ((p as { auditSource?: unknown }).auditSource === 'ai') auditSource = 'ai';
      maxRows = parseRowLimit((p as { maxRows?: unknown }).maxRows);
    } else {
      throw new Error('invalid query payload');
    }
    const executedAt = Date.now();
    try {
      const revision = ++queryRequestRevision;
      // F9: Transaction mode applies to the user's own SQL only; the
      // worker BEGINs when the session is idle and reports txnState.
      const autoBegin = !internal && SettingsShape.parse(getAllSettings()).transactionMode === true;
      const res = await callWorker(
        { kind: 'query', sql, params, revision, maxRows, autoBegin, maxBytes: resultMaxBytes() },
        'queryResult',
      );
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
        recordAuditStatements(auditDeps, [
          {
            sql,
            source: auditSource,
            affectedRows: res.result.rowCount,
            durationMs: res.result.durationMs,
            ts: executedAt,
          },
        ]);
      }
      return res.result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A bound query variable whose type Postgres could not infer is retried
      // with a literal by the renderer; the first attempt is not a user error.
      if (!internal && !(params && isUninferableParamError(message))) {
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
        recordAuditStatements(auditDeps, [
          {
            sql,
            source: auditSource,
            error: message,
            ts: executedAt,
            durationMs: Date.now() - executedAt,
          },
        ]);
      }
      throw err;
    }
  });

  ipcMain.handle(IpcChannel.QueryCancel, async (): Promise<CancelOutcome> => {
    const res = await callWorker({ kind: 'cancel' }, 'cancelled');
    if (res.failed) return 'failed';
    if (res.delivered === undefined) return 'unsupported';
    return res.delivered ? 'sent' : 'nothing-running';
  });

  ipcMain.handle(IpcChannel.QuerySideband, async (_e, payload: unknown): Promise<QueryResult> => {
    let sql: string;
    let params: unknown[] | undefined;
    let timeoutMs: number | undefined;
    if (typeof payload === 'string') {
      sql = payload;
    } else if (payload && typeof payload === 'object' && 'sql' in payload) {
      const p = payload as { sql: unknown; params?: unknown; timeoutMs?: unknown };
      if (typeof p.sql !== 'string') throw new Error('sql must be a string');
      sql = p.sql;
      params = Array.isArray(p.params) ? p.params : undefined;
      if (typeof p.timeoutMs === 'number' && Number.isInteger(p.timeoutMs) && p.timeoutMs > 0) {
        timeoutMs = Math.min(p.timeoutMs, 600_000);
      }
    } else {
      throw new Error('invalid sideband payload');
    }
    const res = await callWorker(
      { kind: 'sidebandQuery', sql, params, timeoutMs, revision: ++queryRequestRevision },
      'queryResult',
    );
    return res.result;
  });

  // C7: grid edit commits. The worker runs the batch in one transaction
  // (a savepoint inside the user's own), requires rowCount === 1 per
  // statement and rolls everything back naming the failing edit.
  ipcMain.handle(
    IpcChannel.QueryCommitEditBatch,
    async (
      _e,
      raw: unknown,
    ): Promise<{ state: TxnState; applied: number; conflicts?: EditConflict[] }> => {
      const req = CommitEditBatchRequest.parse(raw);
      if (retainedSession?.config.readOnly === true) {
        throw new Error('This connection is read-only — edits cannot be committed.');
      }
      const startedAt = Date.now();
      let res: Awaited<ReturnType<typeof callWorker<'editBatchResult'>>>;
      try {
        res = await callWorker(
          { kind: 'commitEditBatch', connectionGen: req.connectionGen, updates: req.updates },
          'editBatchResult',
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        recordAuditStatements(
          auditDeps,
          req.updates.map((u) => ({
            sql: u.sql,
            source: 'grid-commit' as const,
            error: message,
            ts: startedAt,
            durationMs: Date.now() - startedAt,
          })),
        );
        throw err;
      }
      const conflicted = res.conflicts && res.conflicts.length > 0;
      recordAuditStatements(
        auditDeps,
        req.updates.map((u) => ({
          sql: u.sql,
          source: 'grid-commit' as const,
          ...(conflicted
            ? { error: 'Rolled back: a row changed on the server since it was loaded.' }
            : { affectedRows: 1 }),
          ts: startedAt,
          durationMs: Date.now() - startedAt,
        })),
      );
      return {
        state: res.state,
        applied: res.applied,
        ...(conflicted ? { conflicts: res.conflicts } : {}),
      };
    },
  );

  // Structure editing, create table and import (see import-ipc.ts).
  registerAuditIpc(auditDeps);
  registerPgListenIpc({
    callWorker,
    onNotify: (channel, payload, error, durationMs) =>
      recordAuditStatements(auditDeps, [
        {
          sql: `SELECT pg_notify('${channel.replace(/'/g, "''")}', '${payload.replace(/'/g, "''")}')`,
          source: 'notify',
          error,
          durationMs,
        },
      ]),
  });
  registerImportIpc({
    audit: (statements) => recordAuditStatements(auditDeps, statements),
    window: () => mainWindow,
    isReadOnly: () => retainedSession?.config.readOnly === true,
    callWorker,
  });

  // F2: EXPLAIN never runs through query.run. Plain EXPLAIN doesn't
  // execute; ANALYZE executes inside a transaction the worker rolls back.
  ipcMain.handle(IpcChannel.QueryExplain, async (_e, raw: unknown): Promise<QueryResult> => {
    const req = ExplainRequest.parse(raw);
    if (req.analyze && retainedSession?.config.readOnly === true && looksLikeWriteSql(req.sql)) {
      throw new Error(
        'This connection is read-only — EXPLAIN ANALYZE of a data-changing statement is not allowed.',
      );
    }
    const res = await callWorker(
      { kind: 'explain', sql: req.sql, analyze: req.analyze, params: req.params },
      'queryResult',
    );
    return res.result;
  });

  // Safe Run: a write held open in a transaction until the user decides.
  // Read-only connections refuse it here and again in callWorker's guard;
  // the worker refuses anything else on the primary while one is pending.
  let pendingSafeRun: { runId: string; sql: string; executedAt: number; affected: number } | null =
    null;
  ipcMain.handle(IpcChannel.QuerySafeRun, async (_e, raw: unknown): Promise<SafeRunReport> => {
    const req = SafeRunStartRequest.parse(raw);
    if (retainedSession?.config.readOnly === true) {
      throw new Error('This connection is read-only — Safe Run is not available.');
    }
    const executedAt = Date.now();
    const res = await callWorker(
      {
        kind: 'safeRunStart',
        sql: req.sql,
        connectionGen: req.connectionGen,
        timeoutSec: req.timeoutSec,
        explain: req.explain,
      },
      'safeRunReport',
    );
    pendingSafeRun = {
      runId: res.report.runId,
      sql: req.sql,
      executedAt,
      affected: res.report.affected,
    };
    return res.report;
  });

  ipcMain.handle(
    IpcChannel.QuerySafeRunFinish,
    async (_e, raw: unknown): Promise<SafeRunOutcome> => {
      const req = SafeRunFinishRequest.parse(raw);
      const res = await callWorker(
        { kind: 'safeRunFinish', runId: req.runId, action: req.action },
        'safeRunDone',
      );
      const ran = pendingSafeRun?.runId === req.runId ? pendingSafeRun : null;
      if (ran) pendingSafeRun = null;
      if (ran && res.outcome.outcome === 'committed') {
        try {
          recordHistory({
            connectionId: activeConnectionId,
            sql: ran.sql,
            rowCount: ran.affected,
            durationMs: null,
            error: null,
            executedAt: ran.executedAt,
          });
        } catch (err) {
          logger.error('[plasma] history write failed (non-fatal):', err);
        }
        recordAuditStatements(auditDeps, [
          {
            sql: ran.sql,
            source: 'safe-run',
            affectedRows: ran.affected,
            ts: ran.executedAt,
            durationMs: Date.now() - ran.executedAt,
          },
        ]);
      }
      return res.outcome;
    },
  );

  ipcMain.handle(IpcChannel.ExportSave, async (_e, raw: unknown): Promise<ExportSaveResult> => {
    const req = ExportSaveRequest.parse(raw);
    const extension = req.format;
    const defaultPath = req.defaultPath.toLowerCase().endsWith('.'.concat(extension))
      ? req.defaultPath
      : req.defaultPath.concat('.', extension);
    if (!req.rows) {
      // F7: full-result export re-runs SQL on the primary — only ever a
      // single read-only statement, never the user's DML again.
      if (!req.sql || !isSingleSqlStatement(req.sql) || looksLikeWriteSql(req.sql)) {
        throw new Error('Full export needs a single read-only query.');
      }
    }
    const picked = await dialog.showSaveDialog({
      defaultPath,
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
    });
    if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
    // Settings → Data → CSV export decides the dialect of every CSV file.
    const csv = req.format === 'csv' ? getPublicSettings().csvExport : undefined;
    try {
      const res = await callWorker(
        req.rows
          ? {
              kind: 'exportRows',
              format: req.format,
              filePath: picked.filePath,
              columns: req.columns,
              rows: req.rows,
              targetTable: req.targetTable,
              csv,
              jobId: req.jobId,
            }
          : {
              kind: 'exportQuery',
              format: req.format,
              filePath: picked.filePath,
              sql: req.sql!,
              params: req.params,
              targetTable: req.targetTable,
              csv,
              jobId: req.jobId,
            },
        'exportDone',
      );
      return {
        ok: true,
        filePath: res.filePath,
        rowCount: res.rowCount,
        bytesWritten: res.bytesWritten,
      };
    } catch (err) {
      // C30: a user cancel is not an error.
      if (err instanceof Error && err.message === 'export cancelled')
        return { ok: false, canceled: true };
      throw err;
    }
  });

  ipcMain.handle(IpcChannel.ExportCancel, async (_e, jobId: unknown): Promise<void> => {
    if (typeof jobId !== 'string' || !jobId) return;
    await callWorker({ kind: 'exportCancel', jobId }, 'cancelled');
  });

  ipcMain.handle(IpcChannel.QueryCancelAux, async (): Promise<void> => {
    await callWorker({ kind: 'cancelAux' }, 'cancelled');
  });

  // ── Backup / restore (pg_dump, pg_restore, psql) ──

  /** Temp TLS files of running admin jobs, removed when the job ends (SC-09). */
  const adminCleanups = new Map<string, () => Promise<void>>();
  const adminEndpoint = async (): Promise<{
    endpoint: PgEndpoint;
    cleanup: () => Promise<void>;
  }> => {
    const session = retainedSession;
    if (!session || activeEngine !== 'postgres')
      throw new Error('Connect to a Postgres database first.');
    const settings = SettingsShape.parse(getAllSettings());
    // SC-09: same TLS mode, CA and client certificate as the live session.
    const plan = planAdminTls(session.config, settings.connectionTags?.[session.id]);
    let { host, port } = session.config;
    let hostAddr: string | undefined;
    if (session.tunnelled) {
      // Same tunnel the worker uses (identical target -> cached local port).
      const ssh = getFullSshConfig(session.id, settings.connectionSsh);
      if (!ssh) throw new Error('The SSH tunnel for this connection is gone — reconnect first.');
      const local = await openTunnel({ id: session.id, ssh, pgHost: host, pgPort: port });
      // Keep the real name for certificate checks; dial the tunnel's local end.
      host = session.config.tls?.servername?.trim() || host;
      hostAddr = local.host;
      port = local.port;
    }
    const files = await materializeAdminTls(plan);
    return {
      endpoint: {
        host,
        port,
        user: session.config.user,
        password: session.config.password,
        ssl: plan.sslMode !== 'disable',
        sslMode: plan.sslMode,
        sslRootCert: files.sslRootCert,
        sslCert: files.sslCert,
        sslKey: files.sslKey,
        hostAddr,
      },
      cleanup: files.cleanup,
    };
  };
  const adminBinDir = (): string => SettingsShape.parse(getAllSettings()).pgBinDir;
  const emitAdminEvent = (ev: AdminJobEvent) => {
    if (ev.type === 'done') {
      const cleanup = adminCleanups.get(ev.jobId);
      adminCleanups.delete(ev.jobId);
      void cleanup?.().catch(() => undefined);
    }
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send(IpcChannel.AdminJobEvent, ev);
  };

  // Backup/restore only touch paths the user picked in a native dialog, so a
  // compromised renderer can't make pg_dump overwrite or psql read any file.
  const adminPickedPaths = new Set<string>();
  const assertAdminPicked = (path: string) => {
    if (!adminPickedPaths.has(path)) throw new Error('Choose the file with the file picker first.');
  };

  ipcMain.handle(IpcChannel.AdminTools, (_e, binDir: unknown) =>
    detectTools(typeof binDir === 'string' && binDir.trim() ? binDir : adminBinDir()),
  );

  ipcMain.handle(IpcChannel.AdminBackup, async (_e, raw: unknown) => {
    const req = BackupRequest.parse(raw);
    assertAdminPicked(req.outputPath);
    const { endpoint, cleanup } = await adminEndpoint();
    try {
      const invocation = buildPgDumpInvocation(req, endpoint);
      const jobId = await startJob({
        invocation,
        binDir: adminBinDir(),
        emit: emitAdminEvent,
        outputPath: req.outputPath,
      });
      adminCleanups.set(jobId, cleanup);
      return { jobId, command: invocation.display };
    } catch (err) {
      await cleanup().catch(() => undefined);
      throw err;
    }
  });

  ipcMain.handle(IpcChannel.AdminRestore, async (_e, raw: unknown) => {
    const req = RestoreRequest.parse(raw);
    assertAdminPicked(req.filePath);
    // A restore rewrites the target database: never on a read-only connection.
    if (retainedSession?.config.readOnly === true)
      assertAllowedOnReadOnly({ kind: 'adminRestore' });
    const st = await stat(req.filePath);
    if (req.kind === 'plain' && st.isDirectory())
      throw new Error('Choose a file, not a folder, for a plain SQL restore.');
    const gunzip = /\.gz$/i.test(req.filePath);
    if (req.kind === 'plain') {
      // SC-16: refuse psql meta-commands that reach the shell, before anything runs.
      const problem = await scanPsqlScript(req.filePath, gunzip);
      if (problem) throw new Error(describePsqlProblem(problem));
    }
    const { endpoint, cleanup } = await adminEndpoint();
    try {
      const invocation = buildPgRestoreInvocation(req, endpoint);
      const jobId = await startJob({
        invocation,
        binDir: adminBinDir(),
        emit: emitAdminEvent,
        ...(req.kind === 'plain' ? { stdinFile: { path: req.filePath, gunzip } } : {}),
      });
      adminCleanups.set(jobId, cleanup);
      return { jobId, command: invocation.display };
    } catch (err) {
      await cleanup().catch(() => undefined);
      throw err;
    }
  });

  ipcMain.handle(IpcChannel.AdminCancel, (_e, jobId: unknown): void => {
    if (typeof jobId === 'string') cancelJob(jobId);
  });

  ipcMain.handle(IpcChannel.AdminPickPath, async (e, raw: unknown): Promise<string | null> => {
    const req = PickPathRequest.parse(raw);
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = { title: req.title, defaultPath: req.defaultPath, filters: req.filters };
    if (req.mode === 'save') {
      const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
      if (r.canceled || !r.filePath) return null;
      adminPickedPaths.add(r.filePath);
      return r.filePath;
    }
    const properties: ('openFile' | 'openDirectory' | 'createDirectory')[] =
      req.mode === 'directory' ? ['openDirectory', 'createDirectory'] : ['openFile'];
    const r = win
      ? await dialog.showOpenDialog(win, { ...opts, properties })
      : await dialog.showOpenDialog({ ...opts, properties });
    const picked = r.canceled ? undefined : r.filePaths[0];
    if (!picked) return null;
    adminPickedPaths.add(picked);
    return picked;
  });

  // ── AI (OpenRouter) ──

  ipcMain.handle(IpcChannel.AiChat, async (_e, raw: unknown): Promise<{ accepted: boolean }> => {
    const parsed = AiChatRequest.parse(raw);
    const settings = SettingsShape.parse(getAllSettings());
    // Keys live in the encrypted vault (C3). Prefers the OpenRouter key and
    // falls back to the legacy claudeApiKey slot from v0.0.10. A local model
    // needs none, and nothing is read from the vault for it.
    const provider = settings.aiProvider;
    const apiKey = provider === 'local' ? '' : getApiKey();
    // Row-data tools only when the active connection opted in (C18).
    // SC-05: bind the chat to the connection it started on and re-check the
    // opt-in every time a tool is about to run (the user may switch to prod
    // or revoke the opt-in between rounds).
    const chatConnectionId = activeConnectionId;
    const sameConnection = () =>
      Boolean(chatConnectionId) && activeConnectionId === chatConnectionId;
    const result = await startAiChat(mainWindow, parsed, apiKey, settings.openrouterModel, {
      provider,
      localUrl: settings.aiLocalUrl,
      localModel: settings.aiLocalModel,
      allowRowData: isAiRowDataAllowed(chatConnectionId, settings.connectionAiRowData),
      allowSchema: isAiSchemaAllowed(chatConnectionId, settings),
      toolGuard: () => {
        if (!sameConnection()) {
          return 'the active connection changed since this chat started';
        }
        const live = SettingsShape.parse(getAllSettings());
        return isAiRowDataAllowed(chatConnectionId, live.connectionAiRowData)
          ? null
          : 'row-data access is not enabled for this connection';
      },
      // Agent actions: the user's click decides; only the connection must still be the chat's.
      actionGuard: () =>
        sameConnection() ? null : 'the active connection changed since this chat started',
      // What the user's decision sends back to the model: rows only while the
      // opt-in holds right now, on this same connection, masked and capped.
      shapeActionResult: (res) => {
        const live = SettingsShape.parse(getAllSettings());
        return shapeAgentActionResult(res, {
          rowData:
            sameConnection() && isAiRowDataAllowed(chatConnectionId, live.connectionAiRowData),
          schema: isAiSchemaAllowed(chatConnectionId, live),
          maskRows: (columns, rows) =>
            maskRowsForAi(
              chatConnectionId,
              columns.map((name) => ({ name })),
              rows,
            ),
        });
      },
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

  // The user's decision on an agent action card. Validated in `ai.ts`; a
  // result nobody waits on is ignored.
  ipcMain.handle(IpcChannel.AiActionResult, (_e, raw: unknown): void => {
    submitAiActionResult(raw);
  });

  // Result Compare: one read-only statement on a saved connection. The active
  // connection uses the agent's read-only path as is; any other saved
  // connection gets a throwaway read-only session (tunnel included) that is
  // closed right after, so the live session is never disturbed.
  ipcMain.handle(IpcChannel.CompareCancel, async (_e, runId: unknown): Promise<void> => {
    if (typeof runId !== 'string' || runId === '') return;
    await callWorker({ kind: 'compareCancel', runId }, 'cancelled');
  });

  ipcMain.handle(IpcChannel.CompareRun, async (_e, raw: unknown): Promise<QueryResult> => {
    const req = CompareRunRequest.parse(raw);
    if (!isSingleSqlStatement(req.sql) || !isAgentReadSql(req.sql)) {
      throw new Error(
        'rejected: Compare runs one read-only statement (SELECT, WITH, SHOW, EXPLAIN)',
      );
    }
    const maxRows = req.maxRows ?? 200_000;
    if (req.connectionId === null || req.connectionId === activeConnectionId) {
      if (!isSqlEngine(activeEngine)) throw new Error('no SQL connection');
      const res = await callWorker({ kind: 'aiQuery', sql: req.sql, maxRows }, 'queryResult');
      return res.result;
    }
    const targetId = req.connectionId;
    const config = workspaceRuntime.connectConfigFor(targetId) ?? vaultGetFull(targetId);
    if (!config) throw new Error('That connection is not saved any more.');
    if (!isSqlEngine(config.engine ?? 'postgres')) {
      throw new Error(
        'Compare needs a SQL connection (Postgres, MySQL, SQLite, ClickHouse, DuckDB).',
      );
    }
    const settings = SettingsShape.parse(getAllSettings());
    assertTlsAllowedForTag(resolveTls(config), settings.connectionTags?.[config.id]);
    const tunnelKey = `compare:${randomUUID()}`;
    let tunnelled = false;
    try {
      let effective: ConnectionConfigType = await withTlsFiles(config);
      if (config.engine === 'duckdb' && config.duckdb?.attachConnectionIds?.length) {
        // Saved Postgres connections attached read-only, resolved here with their stored passwords.
        effective = {
          ...effective,
          duckdb: {
            files: config.duckdb.files,
            installPostgresExtension: config.duckdb.installPostgresExtension,
            installExcelExtension: config.duckdb.installExcelExtension,
            attach: buildDuckdbAttachments(config.duckdb.attachConnectionIds, {
              load: (id) => vaultGetFull(id),
              sshFor: (id) => getFullSshConfig(id, settings.connectionSsh) !== null,
            }),
          },
        };
      }
      const ssh = getFullSshConfig(config.id, settings.connectionSsh);
      if (ssh) {
        const refusal = sshUnsupportedReason(config);
        if (refusal) throw new Error(refusal);
        const local = await openTunnel({
          id: tunnelKey,
          ssh,
          pgHost: config.host,
          pgPort: config.port,
        });
        tunnelled = true;
        effective = {
          ...withTunnelServername(effective, config.host),
          host: local.host,
          port: local.port,
        };
      }
      const executedAt = Date.now();
      try {
        const res = await callWorker(
          {
            kind: 'compareQuery',
            config: { ...effective, readOnly: true },
            sql: req.sql,
            maxRows,
            runId: req.runId ?? randomUUID(),
          },
          'queryResult',
        );
        try {
          recordHistory({
            connectionId: targetId,
            sql: req.sql,
            rowCount: res.result.rowCount,
            durationMs: res.result.durationMs,
            error: null,
            executedAt,
          });
        } catch (err) {
          logger.error('[plasma] history write failed (non-fatal):', err);
        }
        return res.result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        try {
          recordHistory({
            connectionId: targetId,
            sql: req.sql,
            rowCount: null,
            durationMs: null,
            error: message,
            executedAt,
          });
        } catch {}
        throw err;
      }
    } finally {
      if (tunnelled) closeTunnel(tunnelKey);
    }
  });

  // The agent's run_query: one read-only statement on the aux client inside a
  // read-only session, then shown in a tab. History and audit say it was the AI.
  ipcMain.handle(IpcChannel.AiRunReadOnly, async (_e, raw: unknown): Promise<QueryResult> => {
    const sql = typeof raw === 'string' ? raw : '';
    if (!isSqlEngine(activeEngine)) throw new Error('no SQL connection');
    if (!isSingleSqlStatement(sql) || !isAgentReadSql(sql)) {
      throw new Error('rejected: only one read-only statement is allowed here');
    }
    const executedAt = Date.now();
    try {
      const res = await callWorker({ kind: 'aiQuery', sql }, 'queryResult');
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
      recordAuditStatements(auditDeps, [
        {
          sql,
          source: 'ai',
          affectedRows: res.result.rowCount,
          durationMs: res.result.durationMs,
          ts: executedAt,
        },
      ]);
      return res.result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
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
      recordAuditStatements(auditDeps, [
        { sql, source: 'ai', error: message, ts: executedAt, durationMs: Date.now() - executedAt },
      ]);
      throw err;
    }
  });

  ipcMain.handle(IpcChannel.AiListModels, async (_e, raw: unknown) => {
    const { refresh } = AiListModelsRequest.parse(raw ?? {});
    const settings = SettingsShape.parse(getAllSettings());
    if (settings.aiProvider === 'local') return listLocalModels(settings.aiLocalUrl);
    return listOpenRouterModels(
      { refresh },
      {
        cachePath: join(app.getPath('userData'), 'ai-models.json'),
        url: resolveModelsUrl(process.env.PLASMA_AI_MODELS_URL),
      },
    );
  });

  ipcMain.handle(IpcChannel.AiCancel, async (_e, requestId: unknown): Promise<void> => {
    if (typeof requestId !== 'string') return;
    cancelAiChat(requestId);
    // Tool queries the model started run on the aux connection (C30).
    void callWorker({ kind: 'cancelAux' }, 'cancelled').catch(() => undefined);
  });

  ipcMain.handle(IpcChannel.FormatSql, (_e, sql: unknown): string => {
    if (typeof sql !== 'string') return '';
    return formatSql(sql);
  });

  // ── Query history ──

  ipcMain.handle(IpcChannel.HistoryList, async (_e, opts: unknown): Promise<HistoryEntry[]> => {
    const safe = HistoryListOpts.parse(opts ?? {});
    return listHistory(safe);
  });

  ipcMain.handle(
    IpcChannel.HistoryLatest,
    async (_e, opts: unknown): Promise<HistoryEntry | null> => {
      const raw = (opts ?? {}) as { connectionId?: string };
      return latestHistory({
        connectionId: typeof raw.connectionId === 'string' ? raw.connectionId : undefined,
      });
    },
  );

  ipcMain.handle(IpcChannel.HistoryClear, async (): Promise<void> => {
    clearHistory();
  });

  ipcMain.handle(IpcChannel.HistoryDelete, async (_e, id: unknown): Promise<void> => {
    if (typeof id !== 'number') throw new Error('history id must be a number');
    deleteHistoryEntry(id);
  });

  // ── Settings ──

  // Secrets never cross IPC in either direction's response: API keys and
  // SSH credentials go to the encrypted vault, the renderer gets presence
  // flags only (C3).
  ipcMain.handle(IpcChannel.SettingsGet, (): Settings => getPublicSettings());

  ipcMain.handle(IpcChannel.SettingsSet, (_e, patch: unknown): Settings => {
    const prev = SettingsShape.parse(getAllSettings());
    const merged = applySettingsPatch(patch);
    // Side effect: if theme changed, update the native window background +
    // title bar overlay so the native window controls follow suit.
    if (merged.theme !== prev.theme && mainWindow && !mainWindow.isDestroyed()) {
      applyThemeToWindow(mainWindow, merged.theme);
    }
    // Push queryTimeoutMs → PG statement_timeout while connected (U20).
    if (merged.queryTimeoutMs !== prev.queryTimeoutMs && isSqlEngine(activeEngine)) {
      void applyStatementTimeout(merged.queryTimeoutMs);
    }
    return merged;
  });

  // ── Schema-diff snapshots (R-18) ──

  ipcMain.handle(IpcChannel.SchemaSnapshotList, () => listSchemaSnapshots(getDb()));
  ipcMain.handle(IpcChannel.SchemaSnapshotGet, (_e, id: unknown) => {
    if (typeof id !== 'string') throw new Error('id must be a string');
    return getSchemaSnapshot(getDb(), id);
  });
  ipcMain.handle(IpcChannel.SchemaSnapshotSave, (_e, raw: unknown) =>
    saveSchemaSnapshot(getDb(), raw),
  );
  ipcMain.handle(IpcChannel.SchemaSnapshotDelete, (_e, id: unknown): void => {
    if (typeof id !== 'string') throw new Error('id must be a string');
    deleteSchemaSnapshot(getDb(), id);
  });

  ipcMain.handle(IpcChannel.SettingsClearApiKey, (): Settings => {
    clearApiKeys();
    return getPublicSettings();
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

  // ── Redis ── (argument parsing + read-only policy: redis-ipc-args.ts)

  const redisReadOnly = (): boolean => retainedSession?.config.readOnly === true;

  ipcMain.handle(IpcChannel.RedisOverview, async () => {
    const res = await callWorker({ kind: 'redisOverview' }, 'redisOverview');
    return res.info;
  });

  ipcMain.handle(IpcChannel.RedisScan, async (_e, raw: unknown) => {
    const res = await callWorker({ kind: 'redisScan', ...parseRedisScanArgs(raw) }, 'redisScan');
    return res.result;
  });

  ipcMain.handle(IpcChannel.RedisGetKey, async (_e, raw: unknown) => {
    const res = await callWorker({ kind: 'redisGetKey', ...parseRedisGetKeyArgs(raw) }, 'redisKey');
    return res.result;
  });

  ipcMain.handle(IpcChannel.RedisDeleteKey, async (_e, raw: unknown) => {
    const args = parseRedisKeyArgs(raw);
    assertRedisWritable(redisReadOnly(), 'delete');
    await callWorker({ kind: 'redisDeleteKey', ...args }, 'redisAck');
  });

  ipcMain.handle(IpcChannel.RedisSetTtl, async (_e, raw: unknown) => {
    const args = parseRedisSetTtlArgs(raw);
    assertRedisWritable(redisReadOnly(), 'set TTL');
    await callWorker({ kind: 'redisSetTtl', ...args }, 'redisAck');
  });

  ipcMain.handle(IpcChannel.RedisCommand, async (_e, raw: unknown) => {
    const args = parseRedisCommandArgs(raw);
    assertRedisCommandAllowed(args.parts, redisReadOnly());
    const res = await callWorker({ kind: 'redisCommand', ...args }, 'redisCommand');
    return res.result;
  });

  ipcMain.handle(IpcChannel.RedisAnalyze, async (_e, raw: unknown) => {
    const opts = (raw ?? {}) as { sampleCap?: unknown; match?: unknown; db?: unknown };
    const res = await callWorker(
      {
        kind: 'redisAnalyze',
        sampleCap: clampAnalyzeSample(opts.sampleCap),
        match: typeof opts.match === 'string' && opts.match ? opts.match : undefined,
        db: typeof opts.db === 'number' && opts.db >= 0 ? Math.floor(opts.db) : undefined,
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
    const args = parseRedisBulkDeleteArgs(raw);
    if (args.keys.length === 0) return { deleted: [], failed: [] };
    assertRedisWritable(redisReadOnly(), 'delete');
    // R1: the worker answers `redisBulkDelete` (with per-key failures), not `redisAck`.
    const res = await callWorker({ kind: 'redisBulkDelete', ...args }, 'redisBulkDelete');
    return res.result;
  });

  ipcMain.handle(IpcChannel.RedisDeleteByPattern, async (_e, raw: unknown) => {
    const args = parseRedisPatternDeleteArgs(raw);
    if (!args.dryRun) assertRedisWritable(redisReadOnly(), 'delete');
    const res = await callWorker({ kind: 'redisDeleteByPattern', ...args }, 'redisPatternDelete');
    return res.result;
  });

  ipcMain.handle(IpcChannel.RedisCancel, async () => {
    await callWorker({ kind: 'redisCancel' }, 'redisAck');
  });

  ipcMain.handle(IpcChannel.RedisWrite, async (_e, raw: unknown) => {
    const args = parseRedisWriteArgs(raw);
    assertRedisWritable(redisReadOnly(), 'write');
    // The worker re-parses the op via Zod.
    await callWorker({ kind: 'redisWrite', op: args.op as never, db: args.db }, 'redisAck');
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
    const res = await callWorker({ kind: 'osSearch', ...parseOsSearchArgs(raw) }, 'osSearch');
    return res.result;
  });

  ipcMain.handle(IpcChannel.OsSql, async (_e, raw: unknown) => {
    // S1: the SQL plugin can DELETE — read-only sessions only run reads.
    const args = parseOsSqlArgs(raw, retainedSession?.config.readOnly === true);
    const res = await callWorker({ kind: 'osSql', ...args }, 'osSql');
    return res.result;
  });

  ipcMain.handle(IpcChannel.OsRequest, async (_e, raw: unknown) => {
    // O14: Dev Tools console / doc CRUD / index ops; writes gated (S1).
    const args = parseOsRequestArgs(raw, retainedSession?.config.readOnly === true);
    const res = await callWorker({ kind: 'osRequest', ...args }, 'osResponse');
    return res.response;
  });

  ipcMain.handle(IpcChannel.OsCancel, async (_e, raw: unknown) => {
    if (typeof raw !== 'string' || !raw) throw new Error('requestId required');
    await callWorker({ kind: 'osCancel', requestId: raw }, 'cancelled');
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
    assertOsWritable(retainedSession?.config.readOnly === true);
    assertOsSingleIndexName(p.name);
    const body =
      p.body && typeof p.body === 'object' && !Array.isArray(p.body)
        ? (p.body as Record<string, unknown>)
        : undefined;
    const res = await callWorker({ kind: 'osCreateIndex', name: p.name, body }, 'osCreateIndex');
    return { acknowledged: res.acknowledged, index: res.index };
  });

  ipcMain.handle(IpcChannel.OsDeleteIndex, async (_e, raw: unknown) => {
    if (typeof raw !== 'string' || !raw) throw new Error('index name required');
    assertOsWritable(retainedSession?.config.readOnly === true);
    assertOsSingleIndexName(raw);
    const res = await callWorker({ kind: 'osDeleteIndex', name: raw }, 'osDeleteIndex');
    return { acknowledged: res.acknowledged };
  });

  ipcMain.handle(IpcChannel.OsFieldStats, async (_e, raw: unknown) => {
    const p = (raw ?? {}) as {
      index?: unknown;
      fields?: unknown;
      queryString?: unknown;
      query?: unknown;
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
        query: typeof p.query === 'string' && p.query ? p.query : undefined,
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

/** Editor row limit from the renderer — a positive integer within the worker cap. */
function parseRowLimit(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) return undefined;
  return Math.min(v, MAX_RESULT_ROWS);
}
