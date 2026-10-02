import { pathToFileURL } from 'node:url';
import { app, ipcMain, session, shell } from 'electron';
import { logger } from './logger';

/**
 * Renderer hardening (C19 / C34):
 * - the main frame can only ever show the app itself (`will-navigate`,
 *   `will-redirect`, no `<webview>`);
 * - `window.open` / target=_blank links go to the OS browser, and only for
 *   http(s) and mailto — never `file:`, `smb:` or custom protocol handlers;
 * - web permission prompts (camera, geolocation, notifications…) are denied;
 * - `ipcMain.handle` handlers only answer frames showing the app.
 */

export type RendererEntry = {
  /** electron-vite dev server URL, when running `pnpm dev`. */
  devUrl?: string;
  /** Absolute path of the built renderer `index.html`. */
  file: string;
};

const EXTERNAL_PROTOCOLS = new Set(['https:', 'http:', 'mailto:']);

/** Links we are willing to hand to the OS (`shell.openExternal`). */
export function isSafeExternalUrl(raw: string): boolean {
  try {
    return EXTERNAL_PROTOCOLS.has(new URL(raw).protocol);
  } catch {
    return false;
  }
}

/** True when `raw` is the app's own renderer page (dev server or built file). */
export function isAppUrl(raw: string, entry: RendererEntry): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (entry.devUrl) {
    try {
      if (url.origin === new URL(entry.devUrl).origin) return true;
    } catch {
      /* malformed dev URL: fall through to the file check */
    }
  }
  if (url.protocol !== 'file:') return false;
  const expected = pathToFileURL(entry.file).href;
  const actual = `${url.protocol}//${url.host}${url.pathname}`;
  return process.platform === 'win32'
    ? actual.toLowerCase() === expected.toLowerCase()
    : actual === expected;
}

/** Web permissions the renderer legitimately needs (copy to clipboard). */
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write']);

export function isAllowedPermission(permission: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission);
}

function openExternalIfSafe(url: string): void {
  if (isSafeExternalUrl(url)) {
    void shell.openExternal(url);
  } else {
    logger.warn('[plasma] blocked external URL with disallowed scheme:', url.slice(0, 200));
  }
}

let installed = false;

/**
 * Install navigation, window-open and permission guards for every
 * webContents the app creates. Call once, before the first window.
 */
export function installWebSecurity(entry: RendererEntry): void {
  if (installed) return;
  installed = true;

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event, url) => {
      if (isAppUrl(url, entry)) return;
      event.preventDefault();
      // A clicked http(s) link without target=_blank: open it outside.
      openExternalIfSafe(url);
    });
    contents.on('will-redirect', (event, url) => {
      if (!isAppUrl(url, entry)) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      openExternalIfSafe(url);
      return { action: 'deny' };
    });
  });

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(isAllowedPermission(permission));
  });
  // Synchronous checks (`navigator.permissions.query`, device enumeration, ...)
  // go through a separate handler; without it Chromium's defaults apply.
  session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
    isAllowedPermission(permission),
  );
  session.defaultSession.setDevicePermissionHandler(() => false);
}

/**
 * Wrap `ipcMain.handle` so every handler registered afterwards rejects
 * calls from frames that are not the app page (a navigated-away frame or
 * an injected iframe). Must run before any handler is registered.
 */
export function guardIpcSenders(entry: RendererEntry): void {
  const original = ipcMain.handle.bind(ipcMain);
  const guarded: typeof ipcMain.handle = (channel, listener) =>
    original(channel, (event, ...args) => {
      const url = event.senderFrame?.url ?? '';
      if (!isAppUrl(url, entry)) {
        logger.warn('[plasma] blocked IPC from untrusted frame:', channel, url.slice(0, 200));
        throw new Error(`IPC ${channel} refused: untrusted sender`);
      }
      return listener(event, ...args);
    });
  ipcMain.handle = guarded;
}
