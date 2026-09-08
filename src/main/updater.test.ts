import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserWindow, app, ipcMain, shell } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { disposeUpdater, getLastUpdateStatus, initUpdater } from './updater';

/**
 * The macOS branch of the updater. Squirrel.Mac validates every download
 * against the designated requirement of the *installed* app, so a build that
 * is not certificate-signed cannot install its own updates — it used to
 * download ~110 MB per poll cycle and then surface ShipIt's "code has no
 * resources but signature indicates they must be present" as a failed update
 * check. These tests pin what follows from the classification: unsigned macOS
 * builds never hand a payload to Squirrel, while signed builds — and every
 * non-macOS build — keep the self-installing path.
 */

const signature = vi.hoisted(() => ({ kind: 'bundle-unsigned' as string }));

vi.mock('./mac-signature', () => ({
  classifyMacAppSignature: () => signature.kind,
}));

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
      const handler = listeners[event];
      if (handler == null) throw new Error(`updater never subscribed to ${event}`);
      handler(arg);
    },
    checkForUpdates: vi.fn(async () => null),
    quitAndInstall: vi.fn(),
  };
});

vi.mock('electron-updater', () => ({ default: { autoUpdater } }));

type IpcHandler = (...args: unknown[]) => unknown;

const FEED_URL = 'https://cdn.example.com/plasma';

let handlers: Record<string, IpcHandler> = {};
let openExternal = vi.fn(async (_url: string) => undefined);
let resources: string;
let platform: PropertyDescriptor;
let arch: PropertyDescriptor;

beforeEach(() => {
  vi.useFakeTimers();
  handlers = {};
  for (const event of Object.keys(autoUpdater.listeners)) delete autoUpdater.listeners[event];
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.quitAndInstall.mockClear();

  resources = mkdtempSync(join(tmpdir(), 'plasma-updater-'));
  writeFileSync(join(resources, 'app-update.yml'), `provider: generic\nurl: ${FEED_URL}\n`);

  ipcMain.handle = (...args: unknown[]) => {
    const [channel, handler] = args;
    if (typeof channel === 'string' && typeof handler === 'function') {
      handlers[channel] = handler as IpcHandler;
    }
  };
  openExternal = vi.fn(async (_url: string) => undefined);
  shell.openExternal = openExternal;

  platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
  arch = Object.getOwnPropertyDescriptor(process, 'arch') as PropertyDescriptor;
  Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true });
  Object.defineProperty(app, 'isPackaged', { value: true, configurable: true });
});

afterEach(() => {
  disposeUpdater();
  Object.defineProperty(process, 'platform', platform);
  Object.defineProperty(process, 'arch', arch);
  Object.defineProperty(app, 'isPackaged', { value: false, configurable: true });
  vi.useRealTimers();
  rmSync(resources, { recursive: true, force: true });
});

function launch(options: { platform: string; arch?: string; signature: string }) {
  signature.kind = options.signature;
  Object.defineProperty(process, 'platform', { value: options.platform, configurable: true });
  if (options.arch != null) {
    Object.defineProperty(process, 'arch', { value: options.arch, configurable: true });
  }
  initUpdater(new BrowserWindow());
}

describe('initUpdater on macOS', () => {
  it('offers a manual .dmg download when the bundle is not certificate-signed', async () => {
    launch({ platform: 'darwin', arch: 'arm64', signature: 'bundle-unsigned' });

    expect(autoUpdater.autoDownload).toBe(false);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);

    autoUpdater.emit('update-available', { version: '0.0.21' });
    expect(getLastUpdateStatus()).toEqual({
      kind: 'available-manual',
      version: '0.0.21',
      downloadUrl: `${FEED_URL}/Plasma-0.0.21-arm64.dmg`,
    });

    await handlers['plasma:update:install']?.();
    expect(openExternal).toHaveBeenCalledWith(`${FEED_URL}/Plasma-0.0.21-arm64.dmg`);
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('treats an ad-hoc signed bundle the same way — its requirement dies with the build', () => {
    launch({ platform: 'darwin', arch: 'x64', signature: 'adhoc' });

    expect(autoUpdater.autoDownload).toBe(false);
    autoUpdater.emit('update-available', { version: '0.0.21' });
    expect(getLastUpdateStatus()).toMatchObject({
      kind: 'available-manual',
      downloadUrl: `${FEED_URL}/Plasma-0.0.21-x64.dmg`,
    });
  });

  it('keeps the self-installing path on a certificate-signed bundle', async () => {
    launch({ platform: 'darwin', arch: 'arm64', signature: 'certificate' });

    expect(autoUpdater.autoDownload).toBe(true);
    autoUpdater.emit('update-available', { version: '0.0.21', releaseNotes: 'notes' });
    expect(getLastUpdateStatus()).toEqual({
      kind: 'available',
      version: '0.0.21',
      releaseNotes: 'notes',
    });

    autoUpdater.emit('update-downloaded', { version: '0.0.21' });
    await handlers['plasma:update:install']?.();
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });
});

describe('initUpdater elsewhere', () => {
  it('leaves Windows self-installing regardless of any mac signature state', () => {
    launch({ platform: 'win32', signature: 'bundle-unsigned' });

    expect(autoUpdater.autoDownload).toBe(true);
    autoUpdater.emit('update-available', { version: '0.0.21' });
    expect(getLastUpdateStatus()).toMatchObject({ kind: 'available', version: '0.0.21' });
  });

  it('ignores an install request with nothing downloaded', async () => {
    launch({ platform: 'win32', signature: 'certificate' });
    autoUpdater.emit('update-not-available', { version: '0.0.20' });

    await handlers['plasma:update:install']?.();
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });
});
