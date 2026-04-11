import { contextBridge, ipcRenderer } from 'electron';
import { IpcChannel, type PlasmaAPI, type Platform } from '@shared/protocol';

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
    run: (sql, params) =>
      params
        ? ipcRenderer.invoke(IpcChannel.QueryRun, { sql, params })
        : ipcRenderer.invoke(IpcChannel.QueryRun, sql),
    cancel: () => ipcRenderer.invoke(IpcChannel.QueryCancel),
  },
  history: {
    list: (opts) => ipcRenderer.invoke(IpcChannel.HistoryList, opts ?? {}),
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
] as const;
type EventChannel = (typeof eventChannels)[number];

contextBridge.exposeInMainWorld('plasmaEvents', {
  on(channel: EventChannel, handler: () => void): () => void {
    if (!eventChannels.includes(channel)) {
      throw new Error(`unknown event channel: ${channel}`);
    }
    const wrapped = () => handler();
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.off(channel, wrapped);
  },
});

declare global {
  interface Window {
    plasma: PlasmaAPI;
    plasmaEvents: {
      on(channel: EventChannel, handler: () => void): () => void;
    };
  }
}
