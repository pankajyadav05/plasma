import { app, BrowserWindow, ipcMain, nativeImage } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  IpcChannel,
  ConnectionConfig,
  SettingsShape,
  type AppMeta,
  type ConnectionConfig as ConnectionConfigType,
  type ConnectionInfo,
  type ConnectionTestResult,
  type HistoryEntry,
  type PingRequest,
  type PingResponse,
  type QueryResult,
  type SavedConnection,
  type SchemaInfo,
  type Settings,
  type TxnState,
  type WorkerRequest,
  type WorkerResponse,
} from '@shared/protocol';
import { applyThemeToWindow, createMainWindow, resolveIconPath } from './window';
import { WorkerSupervisor } from './worker-supervisor';
import {
  deleteConnection as vaultDelete,
  getFullConnection as vaultGetFull,
  listConnections as vaultList,
  saveConnection as vaultSave,
} from './vault';
import { listHistory, recordHistory, clearHistory } from './history';
import { getAllSettings, setSetting } from './settings';
import { getDb, closeDb } from './db';
import { initLogger, logger } from './logger';
import { buildAppMenu } from './menu';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let mainWindow: BrowserWindow | null = null;
const workerSupervisor = new WorkerSupervisor();

// Track the connection id associated with the currently-active worker
// connection so history entries can be linked back to the right vault row.
let activeConnectionId: string | null = null;

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
      logger.warn('[plasma] dock icon not set — resources/icon.png missing. Run `pnpm build:icons`.');
    }
  }

  // Touch the DB early so migrations run before any IPC handlers can read it
  getDb();

  await workerSupervisor.start(join(__dirname, 'workers/index.js'));

  mainWindow = createMainWindow();
  buildAppMenu();
  registerIpcHandlers();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    workerSupervisor.stop();
    closeDb();
    app.quit();
  }
});

app.on('before-quit', () => {
  workerSupervisor.stop();
  closeDb();
});

// ─── Worker helper ────────────────────────────────────────────────────

async function callWorker<K extends WorkerResponse['kind']>(
  req: Omit<WorkerRequest, 'id'>,
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
  ipcMain.handle(IpcChannel.AppMeta, (): AppMeta => ({
    name: 'plasma',
    version: app.getVersion(),
    platform: process.platform as 'darwin' | 'win32' | 'linux',
    electron: process.versions.electron ?? 'unknown',
    node: process.versions.node,
  }));

  // ── Connection lifecycle ──

  ipcMain.handle(
    IpcChannel.ConnectionConnect,
    async (_e, rawConfig: unknown): Promise<ConnectionInfo> => {
      const config = ConnectionConfig.parse(rawConfig);
      const res = await callWorker({ kind: 'connect', config }, 'connected');
      try {
        vaultSave(config);
        activeConnectionId = config.id;
      } catch (err) {
        logger.error('[plasma] vault save failed (non-fatal):', err);
      }
      return { serverVersion: res.serverVersion };
    },
  );

  ipcMain.handle(IpcChannel.ConnectionDisconnect, async (): Promise<void> => {
    activeConnectionId = null;
    await callWorker({ kind: 'disconnect' }, 'disconnected');
  });

  ipcMain.handle(
    IpcChannel.ConnectionTest,
    async (_e, rawConfig: unknown): Promise<ConnectionTestResult> => {
      try {
        const config = ConnectionConfig.parse(rawConfig);
        const res = await callWorker({ kind: 'connect', config }, 'connected');
        return { ok: true, serverVersion: res.serverVersion };
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

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
      const res = await callWorker({ kind: 'connect', config }, 'connected');
      activeConnectionId = config.id;
      const { password: _pwd, ...safeConfig } = config;
      return {
        info: { serverVersion: res.serverVersion },
        config: safeConfig,
      };
    },
  );

  ipcMain.handle(
    IpcChannel.VaultGetConfig,
    (_e, id: unknown): ConnectionConfigType | null => {
      if (typeof id !== 'string') throw new Error('id must be a string');
      // Returns the decrypted config including password — used only by
      // the renderer's Edit flow so users don't need to re-type passwords.
      return vaultGetFull(id);
    },
  );

  // ── Query execution + history ──

  ipcMain.handle(
    IpcChannel.QueryRun,
    async (_e, payload: unknown): Promise<QueryResult> => {
      // Accept either a legacy string-only payload or { sql, params }.
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
        throw new Error('invalid query payload');
      }
    const executedAt = Date.now();
    try {
      const res = await callWorker({ kind: 'query', sql, params }, 'queryResult');
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
      throw err;
    }
  });

  ipcMain.handle(IpcChannel.QueryCancel, async (): Promise<void> => {
    await callWorker({ kind: 'cancel' }, 'cancelled');
  });

  // ── Query history ──

  ipcMain.handle(
    IpcChannel.HistoryList,
    async (_e, opts: unknown): Promise<HistoryEntry[]> => {
      const safe = (opts ?? {}) as { limit?: number; connectionId?: string };
      return listHistory(safe);
    },
  );

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
