import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserWindow, app, dialog, ipcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type UpdaterHost, disposeUpdater, getLastUpdateStatus, initUpdater } from './updater';

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
    addQuitHandler: vi.fn(),
  };
});
vi.mock('electron-updater', () => ({ default: { autoUpdater } }));

const FEED = 'https://cdn.example.com/plasma';
const INSTALLER = Buffer.from('the real installer');
const SHA = createHash('sha512').update(INSTALLER).digest('base64');
const MANIFEST = `version: 3.1.0\nfiles:\n  - url: Plasma-Setup-3.1.0-x64.exe\n    sha512: ${SHA}\n    size: 18\n`;
const offered = { version: '3.1.0', files: [{ url: 'Plasma-Setup-3.1.0-x64.exe', sha512: SHA }] };

let resources: string;
let userData: string;
let platform: PropertyDescriptor;
let host: UpdaterHost & { shutdownForUpdate: ReturnType<typeof vi.fn> };
const realGetPath = app.getPath;
const realShowMessageBox = dialog.showMessageBox;
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

/** Click "Restart to update"; the renderer answers main's prepare request. */
async function clickRestart() {
  const done = handlers['plasma:update:install']?.();
  await settle();
  await handlers['plasma:update:prepared']?.({}, { connectionId: 'conn-9' });
  await done;
}

/** A verified, downloaded installer; returns the file so a test can tamper with it. */
async function downloadVerified(dir: string): Promise<string> {
  serveFeed(MANIFEST, sign(null, Buffer.from(MANIFEST), privateKey).toString('base64'));
  autoUpdater.emit('update-available', offered);
  await settle();
  const file = join(dir, 'Plasma-Setup-3.1.0-x64.exe');
  writeFileSync(file, INSTALLER);
  autoUpdater.emit('update-downloaded', { ...offered, downloadedFile: file });
  // The feed check is async; on a busy CI runner it can outlast a fixed pause.
  await vi.waitFor(
    () => {
      if (!['downloaded', 'error'].includes(getLastUpdateStatus().kind))
        throw new Error('not settled');
    },
    { timeout: 3000, interval: 10 },
  );
  return file;
}

beforeEach(() => {
  handlers = {};
  for (const e of Object.keys(autoUpdater.listeners)) delete autoUpdater.listeners[e];
  autoUpdater.downloadUpdate.mockClear();
  autoUpdater.quitAndInstall.mockClear();
  autoUpdater.quitAndInstall.mockClear();
  autoUpdater.addQuitHandler.mockClear();
  autoUpdater.autoInstallOnAppQuit = true;
  resources = mkdtempSync(join(tmpdir(), 'plasma-updater-signed-'));
  userData = mkdtempSync(join(tmpdir(), 'plasma-userdata-'));
  app.getPath = () => userData;
  host = {
    getUnsaved: () => ({ openTransaction: false, pendingEdits: 0 }),
    getActiveConnectionId: () => 'conn-1',
    getWorkspaceRoot: () => null,
    reopenWorkspace: vi.fn(),
    shutdownForUpdate: vi.fn(async () => undefined),
    relaunchAfterFailedInstall: vi.fn(),
  };
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
  initUpdater(new BrowserWindow(), host);
});

afterEach(() => {
  disposeUpdater();
  Object.defineProperty(process, 'platform', platform);
  Object.defineProperty(app, 'isPackaged', { value: false, configurable: true });
  vi.unstubAllGlobals();
  app.getPath = realGetPath;
  dialog.showMessageBox = realShowMessageBox;
  rmSync(resources, { recursive: true, force: true });
  rmSync(userData, { recursive: true, force: true });
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
      await clickRestart();
      // Verified against the signed manifest: installs silently and relaunches.
      expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true);
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

describe('restart to update (signed feed)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plasma-dl-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('arms install-on-quit only after the file matched, and registers the quit handler then', async () => {
    serveFeed(MANIFEST, sign(null, Buffer.from(MANIFEST), privateKey).toString('base64'));
    autoUpdater.emit('update-available', offered);
    await settle();
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
    const file = join(dir, 'Plasma-Setup-3.1.0-x64.exe');
    writeFileSync(file, INSTALLER);
    autoUpdater.emit('update-downloaded', { ...offered, downloadedFile: file });
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false); // check still running
    await settle();
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true);
    expect(autoUpdater.addQuitHandler).toHaveBeenCalledTimes(1);
  });

  it('disarms install-on-quit again when a newer update is found, until it is verified', async () => {
    await downloadVerified(dir);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true);
    autoUpdater.emit('update-available', { ...offered, version: '3.1.1' });
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
  });

  it('with nothing at stake restarts at once, with no dialog, after stopping the workers', async () => {
    const ask = vi.fn(async () => ({ response: 0, checkboxChecked: false }));
    dialog.showMessageBox = ask as unknown as typeof dialog.showMessageBox;
    await downloadVerified(dir);
    const order: string[] = [];
    host.shutdownForUpdate.mockImplementation(async () => void order.push('shutdown'));
    autoUpdater.quitAndInstall.mockImplementation(() => void order.push('install'));

    await clickRestart();

    expect(ask).not.toHaveBeenCalled();
    expect(order).toEqual(['shutdown', 'install']);
    expect(getLastUpdateStatus()).toMatchObject({ kind: 'restarting', version: '3.1.0' });
  });

  it('writes the restart marker with the live connection before it quits', async () => {
    await downloadVerified(dir);
    await clickRestart();
    const marker = JSON.parse(readFileSync(join(userData, 'update-restart.json'), 'utf8'));
    expect(marker).toMatchObject({
      v: 1,
      expectedVersion: '3.1.0',
      fromVersion: app.getVersion(),
      connectionId: 'conn-9', // the renderer's answer wins
      platform: 'win32',
    });
  });

  it('lists what would be lost and does nothing when the user cancels', async () => {
    const ask = vi.fn(async () => ({ response: 0, checkboxChecked: false }));
    dialog.showMessageBox = ask as unknown as typeof dialog.showMessageBox;
    host.getUnsaved = () => ({ openTransaction: false, pendingEdits: 3, runningQuery: true });
    await downloadVerified(dir);

    await handlers['plasma:update:install']?.();

    expect(ask).toHaveBeenCalledTimes(1);
    const options = (
      ask.mock.calls[0] as unknown as [unknown, { message: string; detail: string }]
    )[1];
    expect(options.message).toBe('Restart now?');
    expect(options.detail).toContain('3 unsaved grid edits');
    expect(options.detail).toContain('a query that is still running');
    expect(host.shutdownForUpdate).not.toHaveBeenCalled();
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(existsSync(join(userData, 'update-restart.json'))).toBe(false);
    expect(getLastUpdateStatus()).toMatchObject({ kind: 'downloaded' });
  });

  it('restarts after the user confirms discarding', async () => {
    dialog.showMessageBox = (async () => ({
      response: 1,
      checkboxChecked: false,
    })) as unknown as typeof dialog.showMessageBox;
    host.getUnsaved = () => ({ openTransaction: true, pendingEdits: 0 });
    await downloadVerified(dir);
    await clickRestart();
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it('re-hashes the installer at the click and refuses a file swapped since the check', async () => {
    const file = await downloadVerified(dir);
    expect(getLastUpdateStatus()).toMatchObject({ kind: 'downloaded' });
    writeFileSync(file, 'something else was put here');

    await clickRestart();

    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(host.shutdownForUpdate).not.toHaveBeenCalled();
    expect(getLastUpdateStatus()).toMatchObject({ kind: 'error' });
  });

  it('hashes the installer once more after the workers stopped, right before handing over', async () => {
    const file = await downloadVerified(dir);
    host.shutdownForUpdate.mockImplementation(async () => {
      writeFileSync(file, 'swapped while the workers were stopping');
    });
    await clickRestart();
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(host.relaunchAfterFailedInstall).toHaveBeenCalledTimes(1);
    expect(getLastUpdateStatus()).toMatchObject({ kind: 'error' });
  });

  it('flushes the renderer storage to disk before stopping anything', async () => {
    const flush = vi.fn();
    const win = new BrowserWindow();
    (win.webContents as unknown as { session: unknown }).session = { flushStorageData: flush };
    disposeUpdater();
    initUpdater(win, host);
    await downloadVerified(dir);
    host.shutdownForUpdate.mockImplementation(async () => {
      expect(flush).toHaveBeenCalledTimes(1);
    });
    await clickRestart();
    expect(host.shutdownForUpdate).toHaveBeenCalled();
  });

  describe('install-on-quit', () => {
    let quit: (() => void) | undefined;
    const realOn = app.on;
    beforeEach(() => {
      app.on = ((event: string, handler: () => void) => {
        if (event === 'before-quit') quit = handler;
        return app;
      }) as unknown as typeof app.on;
      disposeUpdater();
      initUpdater(new BrowserWindow(), host);
    });
    afterEach(() => {
      app.on = realOn;
      quit = undefined;
    });

    it('stays armed when the file still matches at quit', async () => {
      await downloadVerified(dir);
      quit?.();
      expect(autoUpdater.autoInstallOnAppQuit).toBe(true);
    });

    it('is disarmed at quit when the file changed since the check', async () => {
      const file = await downloadVerified(dir);
      writeFileSync(file, 'replaced hours later');
      quit?.();
      expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
      expect(getLastUpdateStatus()).toMatchObject({ kind: 'error' });
    });

    it('is disarmed at quit when the file is gone', async () => {
      const file = await downloadVerified(dir);
      rmSync(file);
      quit?.();
      expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
    });
  });

  it('brings Plasma back when the installer fails after the workers were stopped', async () => {
    await downloadVerified(dir);
    await clickRestart();
    autoUpdater.emit('error', new Error('spawn failed'));
    expect(host.relaunchAfterFailedInstall).toHaveBeenCalledTimes(1);
  });
});

describe('the first launch after an update restart', () => {
  it('hands the renderer what to restore, once', async () => {
    const marker = {
      v: 1,
      platform: 'win32',
      fromVersion: '3.0.0',
      expectedVersion: '0.0.0', // app.getVersion() in the stub
      at: Date.now() - 5_000,
      connectionId: 'conn-7',
      workspaceRoot: '/work/space',
      logPath: null,
    };
    writeFileSync(join(userData, 'update-restart.json'), JSON.stringify(marker));
    disposeUpdater();
    initUpdater(new BrowserWindow(), host);

    expect(host.reopenWorkspace).toHaveBeenCalledWith('/work/space');
    expect(existsSync(join(userData, 'update-restart.json'))).toBe(false);
    const info = (await handlers['plasma:update:launchInfo']?.()) as Record<string, unknown>;
    expect(info).toMatchObject({
      resume: true,
      connectionId: 'conn-7',
      outcome: 'updated',
      version: '0.0.0',
    });
    expect(await handlers['plasma:update:launchInfo']?.()).toMatchObject({
      resume: false,
      outcome: 'none',
    });
  });

  it('says the update failed when the old version is still running', async () => {
    writeFileSync(
      join(userData, 'update-restart.json'),
      JSON.stringify({
        v: 1,
        platform: 'win32',
        fromVersion: '0.0.0',
        expectedVersion: '9.9.9',
        at: Date.now() - 5_000,
        connectionId: 'conn-7',
        workspaceRoot: null,
        logPath: null,
      }),
    );
    disposeUpdater();
    initUpdater(new BrowserWindow(), host);

    expect(await handlers['plasma:update:launchInfo']?.()).toMatchObject({
      resume: true,
      connectionId: 'conn-7',
      outcome: 'failed',
      version: '9.9.9',
    });
    expect(getLastUpdateStatus()).toMatchObject({ kind: 'error' });
  });
});
