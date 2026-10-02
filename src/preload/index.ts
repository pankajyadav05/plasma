import { IpcChannel, type PlasmaAPI, type Platform } from '@shared/protocol';
import { contextBridge, ipcRenderer } from 'electron';
import { type EventChannel, eventChannels } from './event-channels';

/**
 * Preload — the ONLY place contextBridge is called.
 *
 * The renderer has `nodeIntegration: false` + `contextIsolation: true`,
 * so it can only see what we expose here. Everything listed in PlasmaAPI
 * must be implemented below.
 */

const api: PlasmaAPI = {
  platform: process.platform as Platform,
  app: {
    meta: () => ipcRenderer.invoke(IpcChannel.AppMeta),
    setUnsavedState: (state) => ipcRenderer.invoke(IpcChannel.AppSetUnsavedState, state),
  },
  conn: {
    connect: (config) => ipcRenderer.invoke(IpcChannel.ConnectionConnect, config),
    disconnect: () => ipcRenderer.invoke(IpcChannel.ConnectionDisconnect),
    test: (config, ssh) => ipcRenderer.invoke(IpcChannel.ConnectionTest, config, ssh),
    introspect: (opts) => ipcRenderer.invoke(IpcChannel.ConnectionIntrospect, opts),
    pickFile: (title) => ipcRenderer.invoke(IpcChannel.ConnectionPickFile, title),
    respondHostKey: (requestId, accept) =>
      ipcRenderer.invoke(IpcChannel.SshHostKeyRespond, { requestId, accept }),
  },
  vault: {
    list: () => ipcRenderer.invoke(IpcChannel.VaultList),
    delete: (id) => ipcRenderer.invoke(IpcChannel.VaultDelete, id),
    connectById: (id) => ipcRenderer.invoke(IpcChannel.VaultConnectById, id),
    getConfig: (id) => ipcRenderer.invoke(IpcChannel.VaultGetConfig, id),
    save: (config) => ipcRenderer.invoke(IpcChannel.VaultSave, config),
    duplicate: (id) => ipcRenderer.invoke(IpcChannel.VaultDuplicate, id),
  },
  query: {
    run: (sql, params, opts) =>
      params || opts
        ? ipcRenderer.invoke(IpcChannel.QueryRun, {
            sql,
            params,
            internal: opts?.internal === true,
            maxRows: opts?.maxRows,
          })
        : ipcRenderer.invoke(IpcChannel.QueryRun, sql),
    commitEditBatch: (req) => ipcRenderer.invoke(IpcChannel.QueryCommitEditBatch, req),
    cancel: () => ipcRenderer.invoke(IpcChannel.QueryCancel),
    cancelAux: () => ipcRenderer.invoke(IpcChannel.QueryCancelAux),
    explain: (req) => ipcRenderer.invoke(IpcChannel.QueryExplain, req),
    safeRun: (req) => ipcRenderer.invoke(IpcChannel.QuerySafeRun, req),
    safeRunFinish: (req) => ipcRenderer.invoke(IpcChannel.QuerySafeRunFinish, req),
    sideband: (sql, params, opts) =>
      params || opts
        ? ipcRenderer.invoke(IpcChannel.QuerySideband, { sql, params, timeoutMs: opts?.timeoutMs })
        : ipcRenderer.invoke(IpcChannel.QuerySideband, sql),
  },
  admin: {
    tools: (binDir) => ipcRenderer.invoke(IpcChannel.AdminTools, binDir),
    backup: (req) => ipcRenderer.invoke(IpcChannel.AdminBackup, req),
    restore: (req) => ipcRenderer.invoke(IpcChannel.AdminRestore, req),
    cancel: (jobId) => ipcRenderer.invoke(IpcChannel.AdminCancel, jobId),
    pickPath: (req) => ipcRenderer.invoke(IpcChannel.AdminPickPath, req),
  },
  export: {
    save: (req) => ipcRenderer.invoke(IpcChannel.ExportSave, req),
    cancel: (jobId) => ipcRenderer.invoke(IpcChannel.ExportCancel, jobId),
  },
  structure: {
    apply: (req) => ipcRenderer.invoke(IpcChannel.StructureApply, req),
  },
  dataImport: {
    pickFile: () => ipcRenderer.invoke(IpcChannel.ImportPickFile),
    preview: (req) => ipcRenderer.invoke(IpcChannel.ImportPreview, req),
    run: (job) => ipcRenderer.invoke(IpcChannel.ImportRun, job),
    cancel: (jobId) => ipcRenderer.invoke(IpcChannel.ImportCancel, jobId),
  },
  redis: {
    overview: () => ipcRenderer.invoke(IpcChannel.RedisOverview),
    scan: (opts) => ipcRenderer.invoke(IpcChannel.RedisScan, opts ?? {}),
    getKey: (key, opts) => ipcRenderer.invoke(IpcChannel.RedisGetKey, { key, opts }),
    deleteKey: (key, opts) => ipcRenderer.invoke(IpcChannel.RedisDeleteKey, { key, ...opts }),
    setTtl: (key, seconds, opts) =>
      ipcRenderer.invoke(IpcChannel.RedisSetTtl, { key, seconds, ...opts }),
    command: (parts, opts) => ipcRenderer.invoke(IpcChannel.RedisCommand, { parts, ...opts }),
    analyze: (opts) => ipcRenderer.invoke(IpcChannel.RedisAnalyze, opts ?? {}),
    slowlog: (limit) => ipcRenderer.invoke(IpcChannel.RedisSlowlog, limit ?? 64),
    bulkDelete: (keys, opts) => ipcRenderer.invoke(IpcChannel.RedisBulkDelete, { keys, ...opts }),
    write: (op, opts) => ipcRenderer.invoke(IpcChannel.RedisWrite, { op, ...opts }),
    deleteByPattern: (opts) => ipcRenderer.invoke(IpcChannel.RedisDeleteByPattern, opts),
    cancel: () => ipcRenderer.invoke(IpcChannel.RedisCancel),
    subscribe: (channel, pattern) =>
      ipcRenderer.invoke(IpcChannel.RedisSubscribe, { channel, pattern: pattern === true }),
    unsubscribe: (channel, pattern) =>
      ipcRenderer.invoke(IpcChannel.RedisUnsubscribe, { channel, pattern: pattern === true }),
  },
  os: {
    overview: () => ipcRenderer.invoke(IpcChannel.OsOverview),
    mapping: (index) => ipcRenderer.invoke(IpcChannel.OsMapping, index),
    search: (opts) => ipcRenderer.invoke(IpcChannel.OsSearch, opts),
    sql: (query, opts) => ipcRenderer.invoke(IpcChannel.OsSql, opts ? { query, ...opts } : query),
    request: (opts) => ipcRenderer.invoke(IpcChannel.OsRequest, opts),
    cancel: (requestId) => ipcRenderer.invoke(IpcChannel.OsCancel, requestId),
    aliases: () => ipcRenderer.invoke(IpcChannel.OsAliases),
    ilm: () => ipcRenderer.invoke(IpcChannel.OsIlm),
    createIndex: (name, body) => ipcRenderer.invoke(IpcChannel.OsCreateIndex, { name, body }),
    deleteIndex: (name) => ipcRenderer.invoke(IpcChannel.OsDeleteIndex, name),
    fieldStats: (opts) => ipcRenderer.invoke(IpcChannel.OsFieldStats, opts),
  },
  ai: {
    chat: (req) => ipcRenderer.invoke(IpcChannel.AiChat, req),
    cancel: (requestId) => ipcRenderer.invoke(IpcChannel.AiCancel, requestId),
  },
  sql: {
    format: (sql) => ipcRenderer.invoke(IpcChannel.FormatSql, sql),
  },
  history: {
    list: (opts) => ipcRenderer.invoke(IpcChannel.HistoryList, opts ?? {}),
    latest: (opts) => ipcRenderer.invoke(IpcChannel.HistoryLatest, opts ?? {}),
    clear: () => ipcRenderer.invoke(IpcChannel.HistoryClear),
    delete: (id) => ipcRenderer.invoke(IpcChannel.HistoryDelete, id),
  },
  schemaSnapshots: {
    list: () => ipcRenderer.invoke(IpcChannel.SchemaSnapshotList),
    get: (id) => ipcRenderer.invoke(IpcChannel.SchemaSnapshotGet, id),
    save: (req) => ipcRenderer.invoke(IpcChannel.SchemaSnapshotSave, req),
    delete: (id) => ipcRenderer.invoke(IpcChannel.SchemaSnapshotDelete, id),
  },
  settings: {
    get: () => ipcRenderer.invoke(IpcChannel.SettingsGet),
    set: (patch) => ipcRenderer.invoke(IpcChannel.SettingsSet, patch),
    clearApiKey: () => ipcRenderer.invoke(IpcChannel.SettingsClearApiKey),
  },
  txn: {
    begin: () => ipcRenderer.invoke(IpcChannel.TxnBegin),
    commit: () => ipcRenderer.invoke(IpcChannel.TxnCommit),
    rollback: () => ipcRenderer.invoke(IpcChannel.TxnRollback),
  },
  ping: {
    main: (req) => ipcRenderer.invoke(IpcChannel.PingMain, req),
    worker: (req) => ipcRenderer.invoke(IpcChannel.PingWorker, req),
  },
  window: {
    minimize: () => ipcRenderer.invoke(IpcChannel.WindowMinimize),
    maximizeToggle: () => ipcRenderer.invoke(IpcChannel.WindowMaximizeToggle),
    close: () => ipcRenderer.invoke(IpcChannel.WindowClose),
    isMaximized: () => ipcRenderer.invoke(IpcChannel.WindowIsMaximized),
  },
  update: {
    check: () => ipcRenderer.invoke(IpcChannel.UpdateCheck),
    install: () => ipcRenderer.invoke(IpcChannel.UpdateInstall),
    status: () => ipcRenderer.invoke(IpcChannel.UpdateStatus),
  },
};

contextBridge.exposeInMainWorld('plasma', api);

// Expose a thin subscription layer for main-process → renderer menu events
// (separate from invoke-based RPC). Renderer components listen via
// `window.plasmaEvents.on('plasma:menu:runQuery', handler)`.
contextBridge.exposeInMainWorld('plasmaEvents', {
  on(channel: EventChannel, handler: (...args: unknown[]) => void): () => void {
    if (!eventChannels.includes(channel)) {
      throw new Error(`unknown event channel: ${channel}`);
    }
    const wrapped = (_: unknown, ...args: unknown[]) => handler(...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.off(channel, wrapped);
  },
});

declare global {
  interface Window {
    plasma: PlasmaAPI;
    plasmaEvents: {
      on(channel: EventChannel, handler: (...args: unknown[]) => void): () => void;
    };
  }
}
