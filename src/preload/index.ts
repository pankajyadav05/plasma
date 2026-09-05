import { IpcChannel, type PlasmaAPI, type Platform } from '@shared/protocol';
import { contextBridge, ipcRenderer } from 'electron';

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
  },
  conn: {
    connect: (config) => ipcRenderer.invoke(IpcChannel.ConnectionConnect, config),
    disconnect: () => ipcRenderer.invoke(IpcChannel.ConnectionDisconnect),
    test: (config) => ipcRenderer.invoke(IpcChannel.ConnectionTest, config),
    introspect: () => ipcRenderer.invoke(IpcChannel.ConnectionIntrospect),
  },
  vault: {
    list: () => ipcRenderer.invoke(IpcChannel.VaultList),
    delete: (id) => ipcRenderer.invoke(IpcChannel.VaultDelete, id),
    connectById: (id) => ipcRenderer.invoke(IpcChannel.VaultConnectById, id),
    getConfig: (id) => ipcRenderer.invoke(IpcChannel.VaultGetConfig, id),
  },
  query: {
    run: (sql, params, opts) =>
      params || opts
        ? ipcRenderer.invoke(IpcChannel.QueryRun, {
            sql,
            params,
            internal: opts?.internal === true,
          })
        : ipcRenderer.invoke(IpcChannel.QueryRun, sql),
    cancel: () => ipcRenderer.invoke(IpcChannel.QueryCancel),
    sideband: (sql, params) =>
      params
        ? ipcRenderer.invoke(IpcChannel.QuerySideband, { sql, params })
        : ipcRenderer.invoke(IpcChannel.QuerySideband, sql),
  },
  redis: {
    overview: () => ipcRenderer.invoke(IpcChannel.RedisOverview),
    scan: (opts) => ipcRenderer.invoke(IpcChannel.RedisScan, opts ?? {}),
    getKey: (key) => ipcRenderer.invoke(IpcChannel.RedisGetKey, key),
    deleteKey: (key) => ipcRenderer.invoke(IpcChannel.RedisDeleteKey, key),
    setTtl: (key, seconds) => ipcRenderer.invoke(IpcChannel.RedisSetTtl, { key, seconds }),
    command: (parts) => ipcRenderer.invoke(IpcChannel.RedisCommand, parts),
    analyze: (opts) => ipcRenderer.invoke(IpcChannel.RedisAnalyze, opts ?? {}),
    slowlog: (limit) => ipcRenderer.invoke(IpcChannel.RedisSlowlog, limit ?? 64),
    bulkDelete: (keys) => ipcRenderer.invoke(IpcChannel.RedisBulkDelete, keys),
    write: (op) => ipcRenderer.invoke(IpcChannel.RedisWrite, op),
    subscribe: (channel, pattern) =>
      ipcRenderer.invoke(IpcChannel.RedisSubscribe, { channel, pattern: pattern === true }),
    unsubscribe: (channel, pattern) =>
      ipcRenderer.invoke(IpcChannel.RedisUnsubscribe, { channel, pattern: pattern === true }),
  },
  os: {
    overview: () => ipcRenderer.invoke(IpcChannel.OsOverview),
    mapping: (index) => ipcRenderer.invoke(IpcChannel.OsMapping, index),
    search: (opts) => ipcRenderer.invoke(IpcChannel.OsSearch, opts),
    sql: (query) => ipcRenderer.invoke(IpcChannel.OsSql, query),
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
  },
  settings: {
    get: () => ipcRenderer.invoke(IpcChannel.SettingsGet),
    set: (patch) => ipcRenderer.invoke(IpcChannel.SettingsSet, patch),
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
const eventChannels = [
  'plasma:menu:newTab',
  'plasma:menu:closeTab',
  'plasma:menu:exportCsv',
  'plasma:menu:exportJson',
  'plasma:menu:toggleSidebar',
  'plasma:menu:toggleEditor',
  'plasma:menu:palette',
  'plasma:menu:runQuery',
  'plasma:menu:cancelQuery',
  'plasma:menu:history',
  'plasma:window:maximizedChanged',
  'plasma:update:status',
  'plasma:ai:event',
  'plasma:redis:pubsub',
] as const;
type EventChannel = (typeof eventChannels)[number];

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
