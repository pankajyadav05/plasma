import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserWindow, app, ipcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type UpdaterHost, disposeUpdater, getLastUpdateStatus, initUpdater } from './updater';

/**
 * macOS without a Developer ID: Plasma's own installer. The OS-facing pieces
 * (`ditto`, `codesign`, the helper process) are mocked; the helper script itself
 * is exercised for real in mac-self-update.test.ts.
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
vi.mock('./mac-signature', () => ({ classifyMacAppSignature: () => 'bundle-unsigned' }));

const mac = vi.hoisted(() => ({
  writability: 'writable' as 'writable' | 'read-only' | 'denied',
  downloadVerified: vi.fn(),
  stageUpdate: vi.fn(),
  launchHelper: vi.fn((_a: { script: string; stageDir: string; logPath: string }) => 4321),
}));
vi.mock('./mac-self-update', async () => {
  const actual = await vi.importActual<typeof import('./mac-self-update')>('./mac-self-update');
  return {
    ...actual,
    findAppBundle: () => '/Applications/Plasma.app',
    probeWritability: () => mac.writability,
    probeBundleWritable: () => true,
    readBundleInfo: async () => ({ identifier: 'sh.plasma.app', version: '3.2.0' }),
    downloadVerified: mac.downloadVerified,
    stageUpdate: mac.stageUpdate,
    launchHelper: mac.launchHelper,
    removePendingDownloads: () => undefined,
    removeStages: () => undefined,
  };
});

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
const ZIP_SHA = createHash('sha512').update('zip').digest('base64');
const DMG_SHA = createHash('sha512').update('dmg').digest('base64');
const MANIFEST = [
  'version: 3.2.2',
  'files:',
  '  - url: Plasma-3.2.2-arm64.zip',
  `    sha512: ${ZIP_SHA}`,
  '    size: 3',
  '  - url: Plasma-3.2.2-arm64.dmg',
  `    sha512: ${DMG_SHA}`,
  '    size: 3',
  '',
].join('\n');
const offered = {
  version: '3.2.2',
  files: [
    { url: 'Plasma-3.2.2-arm64.zip', sha512: ZIP_SHA },
    { url: 'Plasma-3.2.2-arm64.dmg', sha512: DMG_SHA },
  ],
};

let resources: string;
let userData: string;
let handlers: Record<string, (...args: unknown[]) => unknown> = {};
let platform: PropertyDescriptor;
let arch: PropertyDescriptor;
let host: UpdaterHost & { shutdownForUpdate: ReturnType<typeof vi.fn> };
const realGetPath = app.getPath;
const realQuit = app.quit;
const order: string[] = [];

const settle = () => new Promise((r) => setTimeout(r, 20));

function serveFeed() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const isSig = url.includes('.sig');
      const body = isSig
        ? sign(null, Buffer.from(MANIFEST), privateKey).toString('base64')
        : MANIFEST;
      return { ok: true, status: 200, text: async () => body };
    }),
  );
}

beforeEach(() => {
  handlers = {};
  order.length = 0;
  for (const e of Object.keys(autoUpdater.listeners)) delete autoUpdater.listeners[e];
  autoUpdater.downloadUpdate.mockClear();
  autoUpdater.quitAndInstall.mockClear();
  mac.writability = 'writable';
  mac.downloadVerified.mockReset();
  mac.downloadVerified.mockImplementation(async (o: { onProgress?: (p: unknown) => void }) => {
    o.onProgress?.({ percent: 50, bytesPerSecond: 10, transferred: 1, total: 3 });
  });
  mac.stageUpdate.mockReset();
  mac.stageUpdate.mockResolvedValue({
    stageDir: '/u/pending-update/stage-3.2.2-aabbccdd',
    bundle: '/u/pending-update/stage-3.2.2-aabbccdd/Plasma.app',
  });
  mac.launchHelper.mockReset();
  mac.launchHelper.mockImplementation(() => {
    order.push('helper');
    return 4321;
  });
  resources = mkdtempSync(join(tmpdir(), 'plasma-updater-mac-'));
  userData = mkdtempSync(join(tmpdir(), 'plasma-userdata-mac-'));
  writeFileSync(join(resources, 'app-update.yml'), `provider: generic\nurl: ${FEED}\n`);
  app.getPath = () => userData;
  app.quit = vi.fn(() => void order.push('quit')) as unknown as typeof app.quit;
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
    getActiveConnectionId: () => 'conn-1',
    getWorkspaceRoot: () => null,
    reopenWorkspace: vi.fn(),
    shutdownForUpdate: vi.fn(async () => void order.push('shutdown')),
    relaunchAfterFailedInstall: vi.fn(),
  };
  serveFeed();
});

afterEach(() => {
  disposeUpdater();
  Object.defineProperty(process, 'platform', platform);
  Object.defineProperty(process, 'arch', arch);
  Object.defineProperty(app, 'isPackaged', { value: false, configurable: true });
  app.getPath = realGetPath;
  app.quit = realQuit;
  vi.unstubAllGlobals();
  rmSync(resources, { recursive: true, force: true });
  rmSync(userData, { recursive: true, force: true });
});

const launch = () => initUpdater(new BrowserWindow(), host);

describe('macOS self-install', () => {
  it('downloads the signed zip itself, never through electron-updater', async () => {
    launch();
    expect(autoUpdater.autoDownload).toBe(false);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);

    autoUpdater.emit('update-available', offered);
    await settle();

    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
    expect(mac.downloadVerified).toHaveBeenCalledTimes(1);
    const call = mac.downloadVerified.mock.calls[0]?.[0] as {
      url: string;
      sha512: string;
      size: number;
      dest: string;
    };
    expect(call).toMatchObject({
      url: `${FEED}/Plasma-3.2.2-arm64.zip`,
      sha512: ZIP_SHA,
      size: 3,
    });
    expect(call.dest).toBe(join(userData, 'pending-update', 'Plasma-3.2.2-arm64.zip'));
    expect(mac.stageUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ version: '3.2.2', expectedIdentifier: 'sh.plasma.app' }),
    );
    expect(getLastUpdateStatus()).toMatchObject({ kind: 'downloaded', version: '3.2.2' });
  });

  it('restarts through the helper, after the workers stopped, and quits', async () => {
    launch();
    autoUpdater.emit('update-available', offered);
    await settle();

    const done = handlers['plasma:update:install']?.();
    await settle();
    await handlers['plasma:update:prepared']?.({}, { connectionId: 'conn-5' });
    await done;

    expect(order).toEqual(['shutdown', 'helper', 'quit']);
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    const arg = mac.launchHelper.mock.calls[0]?.[0] as unknown as {
      script: string;
      stageDir: string;
      logPath: string;
    };
    expect(arg.script).toContain(`PID='${process.pid}'`);
    expect(arg.script).toContain(`OLD='/Applications/Plasma.app'`);
    expect(arg.script).toContain(`NEW='/u/pending-update/stage-3.2.2-aabbccdd/Plasma.app'`);
    expect(arg.logPath).toBe(join(userData, 'logs', 'update-helper.log'));
    const marker = JSON.parse(readFileSync(join(userData, 'update-restart.json'), 'utf8'));
    expect(marker).toMatchObject({
      expectedVersion: '3.2.2',
      connectionId: 'conn-5',
      logPath: join(userData, 'logs', 'update-helper.log'),
      platform: 'darwin',
    });
  });

  it('falls back to the manual download from a translocated or read-only copy', async () => {
    mac.writability = 'read-only';
    launch();
    expect(autoUpdater.autoDownload).toBe(false);
    autoUpdater.emit('update-available', offered);
    await settle();

    expect(mac.downloadVerified).not.toHaveBeenCalled();
    expect(getLastUpdateStatus()).toEqual({
      kind: 'available-manual',
      version: '3.2.2',
      downloadUrl: `${FEED}/Plasma-3.2.2-arm64.dmg`,
      reason: 'Move Plasma to Applications to get automatic updates.',
    });
  });

  it('offers the manual download, with the reason, when the bundle fails its checks', async () => {
    mac.stageUpdate.mockRejectedValue(
      new Error('the update bundle is com.evil.app, not sh.plasma.app'),
    );
    launch();
    autoUpdater.emit('update-available', offered);
    await settle();

    expect(getLastUpdateStatus()).toMatchObject({
      kind: 'available-manual',
      downloadUrl: `${FEED}/Plasma-3.2.2-arm64.dmg`,
      reason: expect.stringContaining('com.evil.app'),
    });
    // ...and there is nothing to restart into.
    await handlers['plasma:update:install']?.();
    expect(mac.launchHelper).not.toHaveBeenCalled();
  });

  it('refuses an update whose download does not match the signed hash', async () => {
    mac.downloadVerified.mockRejectedValue(
      new Error('the downloaded file does not match the signed sha512'),
    );
    launch();
    autoUpdater.emit('update-available', offered);
    await settle();
    expect(getLastUpdateStatus()).toMatchObject({ kind: 'error' });
    expect(mac.stageUpdate).not.toHaveBeenCalled();
  });

  it('reports a network failure as an error the user can retry', async () => {
    mac.downloadVerified.mockRejectedValue(new Error('download failed (HTTP 503)'));
    launch();
    autoUpdater.emit('update-available', offered);
    await settle();
    expect(getLastUpdateStatus()).toMatchObject({ kind: 'error' });
    expect((getLastUpdateStatus() as { message: string }).message).toContain('503');
  });

  it('relaunches the old app if the helper cannot be started after the shutdown', async () => {
    mac.launchHelper.mockImplementation(() => {
      throw new Error('spawn EACCES');
    });
    launch();
    autoUpdater.emit('update-available', offered);
    await settle();
    const done = handlers['plasma:update:install']?.();
    await settle();
    await handlers['plasma:update:prepared']?.({}, { connectionId: null });
    await done;
    expect(host.relaunchAfterFailedInstall).toHaveBeenCalledTimes(1);
    expect(existsSync(join(userData, 'update-restart.json'))).toBe(true);
  });
});
