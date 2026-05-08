import type { BrowserWindow } from 'electron';
import { app, ipcMain } from 'electron';
import electronUpdater, { type UpdateInfo, type ProgressInfo } from 'electron-updater';
import { logger } from './logger';

const { autoUpdater } = electronUpdater;

/**
 * Auto-update wiring. Uses electron-updater + a generic provider
 * (configured in electron-builder.yml) that points at the same Vercel
 * Blob URL space hosting the installer. Only the NSIS installer can
 * self-update; the portable EXE will see the available-update event
 * but the user has to re-download manually.
 *
 * Status flow surfaced to the renderer:
 *
 *   idle → checking → available → downloading (with progress)
 *                              → not-available
 *                              → error
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

export function initUpdater(window: BrowserWindow): void {
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

  autoUpdater.autoDownload = true; // pull installer in the background
  autoUpdater.autoInstallOnAppQuit = true; // swap on next quit
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

  ipcMain.handle('plasma:update:install', () => {
    // Only valid after `update-downloaded`. Falls through harmlessly
    // otherwise — electron-updater will just no-op.
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
