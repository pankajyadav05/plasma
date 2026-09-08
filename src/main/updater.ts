import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import { app, ipcMain, shell } from 'electron';
import electronUpdater, { type UpdateInfo, type ProgressInfo } from 'electron-updater';
import { logger } from './logger';
import { type MacSignatureKind, classifyMacAppSignature } from './mac-signature';
import { macDownloadUrl, parseFeedBaseUrl } from './update-feed';

const { autoUpdater } = electronUpdater;

/**
 * Auto-update wiring. Uses electron-updater + a generic provider
 * (configured in electron-builder.yml) that points at the R2 URL space
 * hosting the installers. Only the NSIS installer can self-update; the
 * portable EXE will see the available-update event but the user has to
 * re-download manually.
 *
 * macOS installs go through Squirrel.Mac, which refuses any update whose
 * bundle does not satisfy the *installed* app's designated requirement.
 * Releases here are unsigned (`identity: null`), so that can never hold —
 * ShipIt rejected the payload with "code has no resources but signature
 * indicates they must be present" and the renderer showed the raw error.
 * When `mac-signature.ts` reports anything but a certificate-backed
 * signature the updater switches to manual mode: still poll and report new
 * versions, but never download 110 MB Squirrel will throw away, and hand
 * the user the .dmg instead. See docs/mac-auto-update.md.
 *
 * Status flow surfaced to the renderer:
 *
 *   idle → checking → available → downloading (with progress)
 *                              → not-available
 *                              → error
 *                              → available-manual (macOS, unsigned build)
 *                  → downloaded (ready to install on next quit)
 */

export type UpdateStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'not-available'; version: string }
  | { kind: 'available'; version: string; releaseNotes?: string | null }
  | {
      kind: 'downloading';
      percent: number;
      bytesPerSecond: number;
      transferred: number;
      total: number;
    }
  | { kind: 'downloaded'; version: string; releaseNotes?: string | null }
  | { kind: 'available-manual'; version: string; downloadUrl: string }
  | { kind: 'error'; message: string };

let lastStatus: UpdateStatus = { kind: 'idle' };
let pollTimer: ReturnType<typeof setInterval> | null = null;

const POLL_AFTER_LAUNCH_MS = 30_000; // first auto-check 30s after window open
const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6h while running

function broadcast(window: BrowserWindow | null, status: UpdateStatus) {
  lastStatus = status;
  if (window && !window.isDestroyed()) {
    window.webContents.send('plasma:update:status', status);
  }
}

export function getLastUpdateStatus(): UpdateStatus {
  return lastStatus;
}

let feedBase: string | null | undefined;

/**
 * Feed base URL out of the packaged `app-update.yml` — the bucket this build
 * was published to, and therefore where its .dmg sits. Read once, lazily; a
 * build whose manifest is unreadable falls back to the download page.
 */
function feedBaseUrl(): string | null {
  if (feedBase === undefined) {
    try {
      feedBase = parseFeedBaseUrl(
        readFileSync(join(process.resourcesPath, 'app-update.yml'), 'utf8'),
      );
    } catch (err) {
      logger.warn('[updater] could not read app-update.yml', err);
      feedBase = null;
    }
  }
  return feedBase;
}

export function initUpdater(window: BrowserWindow): void {
  // Packaged E2E / agent runs must not hit the R2 updater feed.
  if (process.env.PLASMA_DISABLE_UPDATER === '1') {
    logger.info('[updater] skipped — PLASMA_DISABLE_UPDATER=1');
    ipcMain.handle('plasma:update:check', async () => lastStatus);
    ipcMain.handle('plasma:update:install', () => {
      // no-op when updater disabled
    });
    ipcMain.handle('plasma:update:status', () => lastStatus);
    return;
  }

  // Dev builds don't have a real signed installer — `electron-updater`
  // throws on missing dev-app-update.yml otherwise. Skip the live polling
  // path but still register stub IPC handlers so the renderer's
  // `useUpdate` hook (which fires immediately on mount) doesn't blow up
  // with "No handler registered for plasma:update:status".
  if (!app.isPackaged) {
    logger.info('[updater] skipped — dev build');
    ipcMain.handle('plasma:update:check', async () => lastStatus);
    ipcMain.handle('plasma:update:install', () => {
      // no-op in dev
    });
    ipcMain.handle('plasma:update:status', () => lastStatus);
    return;
  }

  // Squirrel.Mac validates every downloaded bundle against the installed
  // app's designated requirement, so an unsigned or ad-hoc macOS build can
  // never install its own updates (mac-signature.ts spells out why). Decide
  // that once per launch: no background download, no quitAndInstall.
  const macSignature: MacSignatureKind | null =
    process.platform === 'darwin' ? classifyMacAppSignature(app.getPath('exe')) : null;
  const canSelfInstall = macSignature === null || macSignature === 'certificate';
  if (!canSelfInstall) {
    logger.warn(
      `[updater] macOS bundle signature=${macSignature} — Squirrel cannot install updates, falling back to manual download`,
    );
  }

  autoUpdater.autoDownload = canSelfInstall; // pull installer in the background
  autoUpdater.autoInstallOnAppQuit = canSelfInstall; // swap on next quit
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;

  autoUpdater.logger = {
    info: (msg) => logger.info('[updater]', msg),
    warn: (msg) => logger.warn('[updater]', msg),
    error: (msg) => logger.error('[updater]', msg),
    debug: (msg) => logger.info('[updater:debug]', msg),
  } as typeof autoUpdater.logger;

  autoUpdater.on('checking-for-update', () => {
    broadcast(window, { kind: 'checking' });
  });

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    broadcast(window, { kind: 'not-available', version: info.version });
  });

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    if (!canSelfInstall) {
      broadcast(window, {
        kind: 'available-manual',
        version: info.version,
        downloadUrl: macDownloadUrl(feedBaseUrl(), info.version, process.arch),
      });
      return;
    }
    const releaseNotes =
      typeof info.releaseNotes === 'string'
        ? info.releaseNotes
        : Array.isArray(info.releaseNotes)
          ? info.releaseNotes.map((n) => n.note ?? '').join('\n')
          : null;
    broadcast(window, { kind: 'available', version: info.version, releaseNotes });
  });

  autoUpdater.on('download-progress', (p: ProgressInfo) => {
    broadcast(window, {
      kind: 'downloading',
      percent: p.percent,
      bytesPerSecond: p.bytesPerSecond,
      transferred: p.transferred,
      total: p.total,
    });
  });

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    const releaseNotes =
      typeof info.releaseNotes === 'string'
        ? info.releaseNotes
        : Array.isArray(info.releaseNotes)
          ? info.releaseNotes.map((n) => n.note ?? '').join('\n')
          : null;
    broadcast(window, { kind: 'downloaded', version: info.version, releaseNotes });
  });

  autoUpdater.on('error', (err) => {
    broadcast(window, { kind: 'error', message: err?.message ?? String(err) });
  });

  // ── IPC: manual triggers ─────────────────────────────────────────
  ipcMain.handle('plasma:update:check', async () => {
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      broadcast(window, {
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return lastStatus;
  });

  ipcMain.handle('plasma:update:install', async () => {
    // Unsigned macOS build: there is nothing to install — Squirrel would
    // reject the bundle — so hand the user the .dmg for this version.
    if (lastStatus.kind === 'available-manual') {
      await shell.openExternal(lastStatus.downloadUrl);
      return;
    }
    if (lastStatus.kind !== 'downloaded') {
      logger.warn(`[updater] install requested with status=${lastStatus.kind} — ignored`);
      return;
    }
    autoUpdater.quitAndInstall(false, true);
  });

  ipcMain.handle('plasma:update:status', () => lastStatus);

  // ── Auto-poll schedule ───────────────────────────────────────────
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      logger.warn('[updater] initial check failed', err);
    });
  }, POLL_AFTER_LAUNCH_MS);

  pollTimer = setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      logger.warn('[updater] poll check failed', err);
    });
  }, POLL_INTERVAL_MS);
}

export function disposeUpdater(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  ipcMain.removeHandler('plasma:update:check');
  ipcMain.removeHandler('plasma:update:install');
  ipcMain.removeHandler('plasma:update:status');
}
