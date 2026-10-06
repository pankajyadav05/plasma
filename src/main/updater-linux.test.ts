import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserWindow, app, ipcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APPIMAGE_MARKER, installLauncher } from './cli-install';
import { disposeUpdater, getLastUpdateStatus, initUpdater } from './updater';

/** Linux: which installs may update themselves, and what an AppImage rename must keep working. */

vi.mock('./update-signing-key', () => ({
  UPDATE_SIGNING_PUBLIC_KEY: null,
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

let resources: string;
let home: string;
let platform: PropertyDescriptor;
const saved = {
  HOME: process.env.HOME,
  APPIMAGE: process.env.APPIMAGE,
  APPDIR: process.env.APPDIR,
};
const realGetPath = app.getPath;

function launch(opts: { packageType?: string; appImage?: string; appDir?: string }) {
  if (opts.packageType) writeFileSync(join(resources, 'package-type'), opts.packageType);
  process.env.APPIMAGE = opts.appImage ?? '';
  process.env.APPDIR = opts.appDir ?? '';
  if (!opts.appImage) {
    process.env.APPIMAGE = undefined;
    process.env.APPDIR = undefined;
    // biome-ignore lint/performance/noDelete: an env var must be absent, not the string "undefined"
    delete process.env.APPIMAGE;
    // biome-ignore lint/performance/noDelete: see above
    delete process.env.APPDIR;
  }
  initUpdater(new BrowserWindow());
}

beforeEach(() => {
  for (const e of Object.keys(autoUpdater.listeners)) delete autoUpdater.listeners[e];
  autoUpdater.downloadUpdate.mockClear();
  resources = mkdtempSync(join(tmpdir(), 'plasma-linux-res-'));
  home = mkdtempSync(join(tmpdir(), 'plasma-linux-home-'));
  writeFileSync(
    join(resources, 'app-update.yml'),
    'provider: generic\nurl: https://cdn.example.com/p\n',
  );
  process.env.HOME = home;
  app.getPath = () => join(home, 'userData');
  ipcMain.handle = () => undefined;
  platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true });
  Object.defineProperty(app, 'isPackaged', { value: true, configurable: true });
});

afterEach(() => {
  disposeUpdater();
  Object.defineProperty(process, 'platform', platform);
  Object.defineProperty(app, 'isPackaged', { value: false, configurable: true });
  app.getPath = realGetPath;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(resources, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('a .deb with an AppImage environment inherited from another app', () => {
  it('never downloads or installs by itself', () => {
    launch({
      packageType: 'deb',
      appImage: '/home/u/Cursor.AppImage',
      appDir: '/tmp/.mount_Cursor',
    });
    expect(autoUpdater.autoDownload).toBe(false);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
    autoUpdater.emit('update-available', { version: '3.2.2' });
    expect(getLastUpdateStatus()).toMatchObject({ kind: 'available-manual', version: '3.2.2' });
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
  });
});

describe('an AppImage that an update renames', () => {
  const OLD_NAME = 'Plasma-3.2.0-x86_64.AppImage';
  const NEW_NAME = 'Plasma-3.2.2-x86_64.AppImage';

  it('keeps the old name and the installed `plasma` command working', () => {
    const apps = join(home, 'Apps');
    mkdirSync(apps);
    const oldPath = join(apps, OLD_NAME);
    const newPath = join(apps, NEW_NAME);
    // The CLI wrapper as the user installed it, pointing at the old file.
    const script = join(home, 'plasma-script');
    writeFileSync(
      script,
      `#!/bin/sh\n# plasma — command-line companion for the Plasma app.\n${APPIMAGE_MARKER}\n`,
    );
    installLauncher({ script, dir: join(home, '.local', 'bin'), appImage: oldPath });

    launch({ appImage: oldPath, appDir: resources });
    // What electron-updater has done when it emits the event: old file gone, new one in place.
    writeFileSync(newPath, 'new build');
    autoUpdater.emit('appimage-filename-updated', newPath);

    expect(readlinkSync(oldPath)).toBe(newPath);
    const wrapper = readFileSync(join(home, '.local', 'bin', 'plasma'), 'utf8');
    expect(wrapper).toContain(`PLASMA_APP="${newPath}"`);
    expect(wrapper).not.toContain(OLD_NAME);
  });
});
