import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserWindow, app, ipcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type UpdaterHost, disposeUpdater, getLastUpdateStatus, initUpdater } from './updater';

/**
 * macOS with a Developer ID: Squirrel.Mac installs. The fake below keeps the one
 * rule of electron-updater's MacUpdater that matters here: `quitAndInstall` asks
 * Squirrel for the update only while `autoInstallOnAppQuit` is off (it assumes
 * the download already handed it over otherwise). Signed builds 3.2.8–3.2.10 left
 * it on, so Squirrel was never asked and "Restarting" never ended.
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
  const updater = {
    listeners,
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowPrerelease: true,
    allowDowngrade: true,
    logger: null as unknown,
    /** Squirrel.Mac was asked to fetch the update. */
    squirrelAsked: false,
    on(event: string, handler: (arg: unknown) => void) {
      listeners[event] = handler;
      return updater;
    },
    emit(event: string, arg?: unknown) {
      listeners[event]?.(arg);
    },
    checkForUpdates: vi.fn(async () => null),
    downloadUpdate: vi.fn(async () => []),
    quitAndInstall: vi.fn(() => {
      if (!updater.autoInstallOnAppQuit) updater.squirrelAsked = true;
    }),
  };
  return updater;
});
vi.mock('electron-updater', () => ({ default: { autoUpdater } }));

const FEED = 'https://cdn.example.com/plasma';
const ZIP = Buffer.from('the signed app zip');
const SHA = createHash('sha512').update(ZIP).digest('base64');
const MANIFEST = `version: 3.2.11\nfiles:\n  - url: Plasma-3.2.11-arm64.zip\n    sha512: ${SHA}\n    size: ${ZIP.length}\n`;
const offered = { version: '3.2.11', files: [{ url: 'Plasma-3.2.11-arm64.zip', sha512: SHA }] };

let resources: string;
let userData: string;
let platform: PropertyDescriptor;
let arch: PropertyDescriptor;
let host: UpdaterHost & { relaunchAfterFailedInstall: ReturnType<typeof vi.fn> };
let handlers: Record<string, (...args: unknown[]) => unknown> = {};
const realGetPath = app.getPath;

const settle = () => new Promise((r) => setTimeout(r, 20));

async function downloadVerified(): Promise<void> {
  const signature = sign(null, Buffer.from(MANIFEST), privateKey).toString('base64');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body = url.includes('.sig') ? signature : MANIFEST;
      return { ok: true, status: 200, text: async () => body };
    }),
  );
  autoUpdater.emit('update-available', offered);
  await settle();
  const file = join(userData, 'Plasma-3.2.11-arm64.zip');
  writeFileSync(file, ZIP);
  autoUpdater.emit('update-downloaded', { ...offered, downloadedFile: file });
  await vi.waitFor(
    () => {
      if (getLastUpdateStatus().kind !== 'downloaded') throw new Error('not downloaded');
    },
    { timeout: 3000, interval: 10 },
  );
}

async function clickRestart() {
  const done = handlers['plasma:update:install']?.();
  await settle();
  await handlers['plasma:update:prepared']?.({}, { connectionId: null });
  await done;
}

beforeEach(() => {
  handlers = {};
  for (const e of Object.keys(autoUpdater.listeners)) delete autoUpdater.listeners[e];
  autoUpdater.squirrelAsked = false;
  autoUpdater.quitAndInstall.mockClear();
  resources = mkdtempSync(join(tmpdir(), 'plasma-updater-squirrel-'));
  userData = mkdtempSync(join(tmpdir(), 'plasma-userdata-squirrel-'));
  writeFileSync(join(resources, 'app-update.yml'), `provider: generic\nurl: ${FEED}\n`);
  app.getPath = () => userData;
  ipcMain.handle = (...args: unknown[]) => {
    const [channel, handler] = args;
    if (typeof channel === 'string' && typeof handler === 'function') {
      handlers[channel] = handler as (...a: unknown[]) => unknown;
    }
  };
  platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
  arch = Object.getOwnPropertyDescriptor(process, 'arch') as PropertyDescriptor;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
  Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true });
  Object.defineProperty(app, 'isPackaged', { value: true, configurable: true });
  host = {
    getUnsaved: () => ({ openTransaction: false, pendingEdits: 0 }),
    getActiveConnectionId: () => null,
    getWorkspaceRoot: () => null,
    reopenWorkspace: vi.fn(),
    shutdownForUpdate: vi.fn(async () => undefined),
    relaunchAfterFailedInstall: vi.fn(),
  };
});

afterEach(() => {
  disposeUpdater();
  vi.useRealTimers();
  Object.defineProperty(process, 'platform', platform);
  Object.defineProperty(process, 'arch', arch);
  Object.defineProperty(app, 'isPackaged', { value: false, configurable: true });
  app.getPath = realGetPath;
  vi.unstubAllGlobals();
  rmSync(resources, { recursive: true, force: true });
  rmSync(userData, { recursive: true, force: true });
});

describe('macOS Developer ID (Squirrel.Mac) restart', () => {
  it('asks Squirrel for the update when the user restarts', async () => {
    initUpdater(new BrowserWindow(), host);
    await downloadVerified();
    // The verified download arms install-on-quit…
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true);

    await clickRestart();

    // …but the restart must turn it off, or MacUpdater never asks Squirrel.
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(autoUpdater.squirrelAsked).toBe(true);
    expect(getLastUpdateStatus()).toMatchObject({ kind: 'restarting', version: '3.2.11' });
  });

  it('brings Plasma back when Squirrel never finishes', async () => {
    initUpdater(new BrowserWindow(), host);
    await downloadVerified();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await clickRestart();

    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    expect(host.relaunchAfterFailedInstall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60 * 1000 + 1);
    expect(host.relaunchAfterFailedInstall).toHaveBeenCalledTimes(1);
  });

  it('relaunches once when Squirrel reports an error', async () => {
    initUpdater(new BrowserWindow(), host);
    await downloadVerified();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await clickRestart();

    autoUpdater.emit('error', new Error('code signature did not match'));
    expect(host.relaunchAfterFailedInstall).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
    expect(host.relaunchAfterFailedInstall).toHaveBeenCalledTimes(1);
  });
});
