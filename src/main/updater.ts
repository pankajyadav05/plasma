import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import { app, ipcMain, shell } from 'electron';
import electronUpdater, { type UpdateInfo, type ProgressInfo } from 'electron-updater';
import { logger } from './logger';
import { type MacSignatureKind, classifyMacAppSignature } from './mac-signature';
import { macDownloadUrl, macDownloadUrlFromManifest, parseFeedBaseUrl } from './update-feed';
import { type WindowRef, readPublisherName, resolveWindow, updatePolicy } from './update-policy';
import {
  type FeedVerification,
  type ParsedManifest,
  checkDownloadedFile,
  manifestNameFor,
  verifyFeed,
} from './update-signing';
import { SIGNED_UPDATES_REQUIRED_FROM, UPDATE_SIGNING_PUBLIC_KEY } from './update-signing-key';

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
 * Signed manifests (SC-01, docs/release.md): when a public key is embedded
 * (`update-signing-key.ts`), nothing is downloaded or offered until the
 * feed's `<manifest>.sig` verifies and agrees with what electron-updater
 * parsed, and the downloaded file is re-hashed against the signed sha512
 * before it can be installed. A missing `.sig` is tolerated (with a warning)
 * only for updates below `SIGNED_UPDATES_REQUIRED_FROM`.
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

/**
 * C33: the updater outlives any one window (macOS reopen creates a new
 * one), so it asks for the current main window on every broadcast
 * instead of keeping the first one it was given.
 */
export type WindowSource = WindowRef<BrowserWindow>;

let windowSource: () => BrowserWindow | null = () => null;

function broadcast(status: UpdateStatus) {
  lastStatus = status;
  const window = windowSource();
  if (window && !window.isDestroyed()) {
    window.webContents.send('plasma:update:status', status);
  }
}

export function getLastUpdateStatus(): UpdateStatus {
  return lastStatus;
}

function packagedPublisherName(): string | null {
  try {
    return readPublisherName(readFileSync(join(process.resourcesPath, 'app-update.yml'), 'utf8'));
  } catch {
    return null;
  }
}

let feedBase: string | null | undefined;

/** Signed manifest that vouched for the update currently being handled. */
let verifiedManifest: ParsedManifest | null = null;
/** Latest verdict for the update in flight; a stale async check must not win. */
let verifyToken = 0;
/** Outcome of the signature check for the update in flight. */
let trust: 'pending' | 'signed' | 'legacy' | 'refused' = 'pending';

const fetchText = async (url: string) => {
  const res = await fetch(url, {
    headers: { 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(15_000),
  });
  return { ok: res.ok, status: res.status, text: () => res.text() };
};

function refuse(reason: string): void {
  logger.error(`[updater] update refused: ${reason}`);
  verifiedManifest = null;
  trust = 'refused';
  broadcast({ kind: 'error', message: `Update refused: ${reason}` });
}

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

export function initUpdater(window: WindowSource): void {
  windowSource = resolveWindow(window);
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

  const policy = updatePolicy(process.platform, packagedPublisherName());
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

  const signing = UPDATE_SIGNING_PUBLIC_KEY != null;
  const wantsDownload = policy.autoDownload && canSelfInstall;
  const wantsInstallOnQuit = policy.autoInstallOnAppQuit && canSelfInstall;
  // With signed manifests the download starts only after the manifest has been
  // verified (see `update-available`), and install-on-quit is armed only once
  // the downloaded file has been re-hashed. Without a key, behave as before.
  autoUpdater.autoDownload = wantsDownload && !signing; // pull installer in the background
  // Silent install-on-quit only when the installer's signature is checked.
  autoUpdater.autoInstallOnAppQuit = wantsInstallOnQuit && !signing;
  if (!signing) {
    logger.warn(
      '[updater] no update-signing public key embedded (src/main/update-signing-key.ts) — update manifests are NOT verified',
    );
  }
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  if (!policy.signatureVerified) {
    logger.warn(
      '[updater] update signatures are not verified on this build (unsigned or no publisherName) — ' +
        'updates install only when the user clicks "Restart & install"',
    );
  }

  autoUpdater.logger = {
    info: (msg) => logger.info('[updater]', msg),
    warn: (msg) => logger.warn('[updater]', msg),
    error: (msg) => logger.error('[updater]', msg),
    debug: (msg) => logger.info('[updater:debug]', msg),
  } as typeof autoUpdater.logger;

  autoUpdater.on('checking-for-update', () => {
    broadcast({ kind: 'checking' });
  });

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    broadcast({ kind: 'not-available', version: info.version });
  });

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    if (signing) {
      const token = ++verifyToken;
      verifiedManifest = null;
      trust = 'pending';
      void verifyFeed({
        feedBase: feedBaseUrl(),
        manifestName: manifestNameFor(process.platform, process.arch),
        offered: info,
        publicKey: UPDATE_SIGNING_PUBLIC_KEY,
        requiredFrom: SIGNED_UPDATES_REQUIRED_FROM,
        fetchText,
      }).then((verdict: FeedVerification) => {
        if (token !== verifyToken) return; // a newer check superseded this one
        if (verdict.status === 'refused') return refuse(verdict.reason);
        if (verdict.status === 'unsigned-allowed') {
          logger.warn(
            `[updater] ${verdict.reason}; accepting ${info.version} because it predates ${SIGNED_UPDATES_REQUIRED_FROM}`,
          );
          trust = 'legacy';
        } else if (verdict.status === 'verified') {
          trust = 'signed';
          verifiedManifest = verdict.manifest;
          logger.info(`[updater] manifest signature verified for ${info.version}`);
        }
        offerUpdate(info, verdict.status === 'verified' ? verdict.manifest : null);
        if (wantsDownload) {
          autoUpdater.downloadUpdate().catch((err: unknown) => {
            logger.warn('[updater] download failed', err);
          });
        }
      });
      return;
    }
    offerUpdate(info, null);
  });

  function offerUpdate(info: UpdateInfo, signed: ParsedManifest | null): void {
    if (!canSelfInstall) {
      broadcast({
        kind: 'available-manual',
        version: info.version,
        downloadUrl: signed
          ? macDownloadUrlFromManifest(feedBaseUrl(), signed.files, info.version, process.arch)
          : macDownloadUrl(feedBaseUrl(), info.version, process.arch),
      });
      return;
    }
    const releaseNotes =
      typeof info.releaseNotes === 'string'
        ? info.releaseNotes
        : Array.isArray(info.releaseNotes)
          ? info.releaseNotes.map((n) => n.note ?? '').join('\n')
          : null;
    broadcast({ kind: 'available', version: info.version, releaseNotes });
  }

  autoUpdater.on('download-progress', (p: ProgressInfo) => {
    broadcast({
      kind: 'downloading',
      percent: p.percent,
      bytesPerSecond: p.bytesPerSecond,
      transferred: p.transferred,
      total: p.total,
    });
  });

  autoUpdater.on('update-downloaded', (info: UpdateInfo & { downloadedFile?: string }) => {
    if (signing && trust !== 'signed' && trust !== 'legacy') {
      // Never verified (or refused): a download that slipped through is not installable.
      logger.warn(`[updater] ignoring a downloaded update, trust=${trust}`);
      return;
    }
    if (signing && verifiedManifest != null) {
      const signed = verifiedManifest;
      const token = verifyToken;
      void checkDownloadedFile(info.downloadedFile ?? '', signed).then((problem) => {
        if (token !== verifyToken) return;
        if (problem != null) return refuse(problem);
        autoUpdater.autoInstallOnAppQuit = wantsInstallOnQuit;
        announceDownloaded(info);
      });
      return;
    }
    if (signing) {
      // Unsigned-but-allowed legacy update: download completes, install stays manual.
      logger.warn('[updater] downloaded an update whose manifest was not signed (legacy feed)');
    }
    announceDownloaded(info);
  });

  function announceDownloaded(info: UpdateInfo): void {
    const releaseNotes =
      typeof info.releaseNotes === 'string'
        ? info.releaseNotes
        : Array.isArray(info.releaseNotes)
          ? info.releaseNotes.map((n) => n.note ?? '').join('\n')
          : null;
    broadcast({ kind: 'downloaded', version: info.version, releaseNotes });
  }

  autoUpdater.on('error', (err) => {
    broadcast({ kind: 'error', message: err?.message ?? String(err) });
  });

  // ── IPC: manual triggers ─────────────────────────────────────────
  ipcMain.handle('plasma:update:check', async () => {
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      broadcast({
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
