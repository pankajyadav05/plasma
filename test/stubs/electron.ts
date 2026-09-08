/**
 * Node-safe stub for the `electron` package in unit tests.
 *
 * CI sets ELECTRON_SKIP_BINARY_DOWNLOAD=1 so the real package throws on
 * require ("Electron failed to install correctly…"). Vitest aliases
 * `electron` here so main-process modules (e.g. logger → app) can load
 * without the ~100MB binary.
 */
const noop = (..._args: unknown[]): void => {};

export const app = {
  getPath: (name: string) => `/tmp/plasma-vitest/${name}`,
  getName: () => 'plasma',
  getVersion: () => '0.0.0',
  getAppPath: () => '/tmp/plasma-vitest',
  isPackaged: false,
  isReady: () => true,
  whenReady: () => Promise.resolve(),
  on: noop,
  once: noop,
  off: noop,
  quit: noop,
  exit: noop,
  dock: undefined as undefined,
};

export class BrowserWindow {
  static getAllWindows(): BrowserWindow[] {
    return [];
  }
  static getFocusedWindow(): BrowserWindow | null {
    return null;
  }
  isDestroyed(): boolean {
    return false;
  }
  webContents = {
    send: noop,
    on: noop,
    once: noop,
    openDevTools: noop,
    setWindowOpenHandler: noop,
  };
  on = noop;
  once = noop;
  loadURL = async () => undefined;
  loadFile = async () => undefined;
  show = noop;
  focus = noop;
  close = noop;
  destroy = noop;
  getBounds = () => ({ x: 0, y: 0, width: 800, height: 600 });
  setBounds = noop;
}

export const ipcMain = {
  handle: noop,
  handleOnce: noop,
  on: noop,
  once: noop,
  off: noop,
  removeHandler: noop,
  removeAllListeners: noop,
};

export const ipcRenderer = {
  invoke: async () => undefined,
  send: noop,
  on: noop,
  once: noop,
  off: noop,
  removeAllListeners: noop,
};

export const contextBridge = {
  exposeInMainWorld: noop,
};

export const shell = {
  openExternal: async () => undefined,
  openPath: async () => '',
  showItemInFolder: noop,
};

export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] as string[] }),
  showSaveDialog: async () => ({ canceled: true, filePath: undefined as string | undefined }),
  showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
  showErrorBox: noop,
};

export const Menu = {
  buildFromTemplate: () => ({ popup: noop, items: [] }),
  setApplicationMenu: noop,
  getApplicationMenu: () => null,
};

export const nativeImage = {
  createEmpty: () => ({}),
  createFromPath: (_p: string) => ({}),
  createFromDataURL: (_u: string) => ({}),
};

export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (s: string) => Buffer.from(s),
  decryptString: (b: Buffer) => b.toString('utf8'),
};

export const utilityProcess = {
  fork: () => ({
    pid: 0,
    stdout: null,
    stderr: null,
    on: noop,
    once: noop,
    postMessage: noop,
    kill: () => true,
  }),
};

export type MenuItemConstructorOptions = Record<string, unknown>;
export type UtilityProcess = ReturnType<typeof utilityProcess.fork>;

export default {
  app,
  BrowserWindow,
  ipcMain,
  ipcRenderer,
  contextBridge,
  shell,
  dialog,
  Menu,
  nativeImage,
  safeStorage,
  utilityProcess,
};
