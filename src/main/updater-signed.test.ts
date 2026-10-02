import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserWindow, app, ipcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { disposeUpdater, getLastUpdateStatus, initUpdater } from './updater';

/**
 * The updater with a signing key embedded (SC-01): nothing downloads until
 * the feed's manifest signature verifies, and the downloaded file is hashed
 * against the signed sha512 before "Restart & install" is possible.
 */

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const keys = vi.hoisted(() => ({ pub: '' }));
keys.pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');

vi.mock('./update-signing-key', () => ({
  get UPDATE_SIGNING_PUBLIC_KEY() {
    return keys.pub;
  },
  SIGNED_UPDATES_REQUIRED_FROM: '3.1.0',
}));
vi.mock('./mac-signature', () => ({ classifyMacAppSignature: () => 'certificate' }));

const autoUpdater = vi.hoisted(() => {
  const listeners: Record<string, (arg: unknown) => void> = {};
  return {
    listeners,
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowPrerelease: true,
    allowDowngrade: true,
    logger: null as unknown,
    on(event: string, handler: (arg: unknown) => void) {
      listeners[event] = handler;
      return this;
    },
    emit(event: string, arg?: unknown) {
      listeners[event]?.(arg);
    },
    checkForUpdates: vi.fn(async () => null),
    downloadUpdate: vi.fn(async () => []),
    quitAndInstall: vi.fn(),
  };
});
vi.mock('electron-updater', () => ({ default: { autoUpdater } }));

const FEED = 'https://cdn.example.com/plasma';
const INSTALLER = Buffer.from('the real installer');
const SHA = createHash('sha512').update(INSTALLER).digest('base64');
const MANIFEST = `version: 3.1.0\nfiles:\n  - url: Plasma-Setup-3.1.0-x64.exe\n    sha512: ${SHA}\n    size: 18\n`;
const offered = { version: '3.1.0', files: [{ url: 'Plasma-Setup-3.1.0-x64.exe', sha512: SHA }] };

let resources: string;
let platform: PropertyDescriptor;
let handlers: Record<string, (...args: unknown[]) => unknown> = {};

function serveFeed(manifest: string, signature: string | null) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const isSig = url.includes('.sig');
      const body = isSig ? signature : manifest;
      return { ok: body != null, status: body != null ? 200 : 404, text: async () => body ?? '' };
    }),
  );
}

const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  handlers = {};
  for (const e of Object.keys(autoUpdater.listeners)) delete autoUpdater.listeners[e];
  autoUpdater.downloadUpdate.mockClear();
  autoUpdater.quitAndInstall.mockClear();
  resources = mkdtempSync(join(tmpdir(), 'plasma-updater-signed-'));
  writeFileSync(join(resources, 'app-update.yml'), `provider: generic\nurl: ${FEED}\n`);
  ipcMain.handle = (...args: unknown[]) => {
    const [channel, handler] = args;
    if (typeof channel === 'string' && typeof handler === 'function') {
      handlers[channel] = handler as (...a: unknown[]) => unknown;
    }
  };
  platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true });
  Object.defineProperty(app, 'isPackaged', { value: true, configurable: true });
  initUpdater(new BrowserWindow());
});

afterEach(() => {
  disposeUpdater();
  Object.defineProperty(process, 'platform', platform);
  Object.defineProperty(app, 'isPackaged', { value: false, configurable: true });
  vi.unstubAllGlobals();
  rmSync(resources, { recursive: true, force: true });
});

describe('initUpdater with a signing key', () => {
  it('holds back the automatic download and install-on-quit until verified', () => {
    expect(autoUpdater.autoDownload).toBe(false);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
  });

  it('downloads after a valid signature and refuses a tampered installer for good', async () => {
    serveFeed(MANIFEST, sign(null, Buffer.from(MANIFEST), privateKey).toString('base64'));
    autoUpdater.emit('update-available', offered);
    await settle();
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(getLastUpdateStatus()).toMatchObject({ kind: 'available', version: '3.1.0' });

    const dir = mkdtempSync(join(tmpdir(), 'plasma-dl-'));
    try {
      const file = join(dir, 'Plasma-Setup-3.1.0-x64.exe');
      writeFileSync(file, 'tampered installer');
      autoUpdater.emit('update-downloaded', { ...offered, downloadedFile: file });
      await settle();
      expect(getLastUpdateStatus()).toMatchObject({ kind: 'error' });
      await handlers['plasma:update:install']?.();
      expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();

      // A refused update stays refused: a later event cannot revive it.
      writeFileSync(file, INSTALLER);
      autoUpdater.emit('update-downloaded', { ...offered, downloadedFile: file });
      await settle();
      expect(getLastUpdateStatus()).toMatchObject({ kind: 'error' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('announces a downloaded installer that matches the signed sha512', async () => {
    serveFeed(MANIFEST, sign(null, Buffer.from(MANIFEST), privateKey).toString('base64'));
    autoUpdater.emit('update-available', offered);
    await settle();
    const dir = mkdtempSync(join(tmpdir(), 'plasma-dl-'));
    try {
      const file = join(dir, 'Plasma-Setup-3.1.0-x64.exe');
      writeFileSync(file, INSTALLER);
      autoUpdater.emit('update-downloaded', { ...offered, downloadedFile: file });
      await settle();
      expect(getLastUpdateStatus()).toMatchObject({ kind: 'downloaded', version: '3.1.0' });
      await handlers['plasma:update:install']?.();
      expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses an update whose signature does not verify and never downloads', async () => {
    serveFeed(MANIFEST, Buffer.alloc(64, 1).toString('base64'));
    autoUpdater.emit('update-available', offered);
    await settle();
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
    expect(getLastUpdateStatus()).toMatchObject({ kind: 'error' });
  });

  it('refuses an unsigned update at or above the cut-off version', async () => {
    serveFeed(MANIFEST, null);
    autoUpdater.emit('update-available', offered);
    await settle();
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
    expect(getLastUpdateStatus()).toMatchObject({ kind: 'error' });
  });

  it('tolerates an unsigned legacy update below the cut-off, without arming install-on-quit', async () => {
    const legacy = {
      version: '3.0.5',
      files: [{ url: 'Plasma-Setup-3.0.5-x64.exe', sha512: 'x' }],
    };
    serveFeed('version: 3.0.5\n', null);
    autoUpdater.emit('update-available', legacy);
    await settle();
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
  });
});
