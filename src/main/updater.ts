import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AppUnsavedState, type UpdateLaunchInfo } from '@shared/protocol';
import { describeLoss } from '@shared/unsaved-summary';
import type { BrowserWindow } from 'electron';
import { app, dialog, ipcMain, shell } from 'electron';
import electronUpdater, { type UpdateInfo, type ProgressInfo } from 'electron-updater';
import { installTargets, repointAppImageWrappers } from './cli-install';
import {
  backupAppImage,
  leaveAppImageSymlink,
  pruneAppImageBackups,
  pruneDanglingAppImageLinks,
  restoreAppImage,
} from './linux-appimage';
import { logger } from './logger';
import {
  type StagedUpdate,
  buildHelperScript,
  downloadVerified,
  findAppBundle,
  launchHelper,
  macInstallEligibility,
  pickMacZip,
  probeBundleWritable,
  probeWritability,
  readBundleInfo,
  removePendingDownloads,
  removeStages,
  stageUpdate,
} from './mac-self-update';
import { type MacSignatureKind, classifyMacAppSignature } from './mac-signature';
import {
  SITE_DOWNLOAD_URL,
  debDownloadUrlFromManifest,
  macDownloadUrl,
  macDownloadUrlFromManifest,
  parseFeedBaseUrl,
} from './update-feed';
import {
  type UpdateTrust,
  type WindowRef,
  installPlan,
  platformInstaller,
  readPublisherName,
  resolveWindow,
  updatePolicy,
} from './update-policy';
import {
  type RestartMarker,
  clearRestartMarker,
  evaluateRestartMarker,
  readRestartMarker,
  writeRestartMarker,
} from './update-restart';
import {
  type FeedVerification,
  type ParsedManifest,
  checkDownloadedFile,
  checkDownloadedFileSync,
  manifestNameFor,
  sha512OfFile,
  verifyFeed,
} from './update-signing';
import { SIGNED_UPDATES_REQUIRED_FROM, UPDATE_SIGNING_PUBLIC_KEY } from './update-signing-key';
import { isSafeExternalUrl } from './web-security';

const { autoUpdater } = electronUpdater;

/**
 * Auto-update wiring: the new version downloads in the background and one
 * click ("Restart to update") quits, installs without installer windows and
 * reopens Plasma where the user left off.
 *
 * Integrity (SC-01, docs/release.md): every manifest is ed25519-signed
 * (`<manifest>.sig`, key embedded in `update-signing-key.ts`). Nothing is
 * downloaded or offered until that signature verifies and agrees with what
 * electron-updater parsed, and the downloaded file is re-hashed against the
 * signed sha512 before it can be installed (again at the moment of the click).
 * That is what allows silent installs for builds that have no OS code signing
 * (`update-policy.ts`). A missing `.sig` is tolerated (with a warning, and
 * never for a silent install) only below `SIGNED_UPDATES_REQUIRED_FROM`.
 *
 * Per platform, who installs:
 *  - Windows NSIS: electron-updater runs the installer silently, then relaunches.
 *    Portable EXE cannot replace itself: "Download".
 *  - Linux AppImage: electron-updater swaps the file in place (with a backup
 *    link, `linux-appimage.ts`) and starts the new one. `.deb`: "Download"
 *    (see `platformInstaller`).
 *  - macOS with a Developer ID (`certificate`): Squirrel.Mac, as before.
 *  - macOS without one: our own installer (`mac-self-update.ts`), because
 *    Squirrel rejects unsigned updates (docs/mac-auto-update.md). Not possible
 *    from a translocated or read-only copy: "Move Plasma to Applications".
 *
 * Before the restart main asks the renderer to flush the tab strip, writes a
 * restart marker (`update-restart.ts`: connection and workspace to bring back,
 * version expected), shuts the workers down and only then hands over. The next
 * launch reads the marker, restores the session whatever the "restore on
 * launch" settings say, and reports success or failure.
 *
 * Status flow surfaced to the renderer:
 *
 *   idle → checking → available → downloading (with progress) → downloaded
 *                              → not-available
 *                              → error
 *                              → available-manual (cannot self-install)
 *   downloaded → restarting → (process exits)
 */

export type UpdateStatus = import('@shared/protocol').UpdateStatus;

let lastStatus: UpdateStatus = { kind: 'idle' };
let pollTimer: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;

const POLL_AFTER_LAUNCH_MS = 30_000; // first auto-check 30s after window open
const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6h while running
const PREPARE_TIMEOUT_MS = 3_000;
/** Time for `flushStorageData` to reach the disk before the workers stop. */
const FLUSH_SETTLE_MS = 200;

/**
 * C33: the updater outlives any one window (macOS reopen creates a new
 * one), so it asks for the current main window on every broadcast
 * instead of keeping the first one it was given.
 */
export type WindowSource = WindowRef<BrowserWindow>;

/** What the updater needs from the rest of the app (`index.ts`). */
export interface UpdaterHost {
  /** What would be lost on a restart right now. */
  getUnsaved(): AppUnsavedState;
  /** Saved connection that is live, if any. */
  getActiveConnectionId(): string | null;
  /** Open team workspace folder, if any. */
  getWorkspaceRoot(): string | null;
  /** Re-open a workspace the user approved before the restart. */
  reopenWorkspace(root: string): void;
  /**
   * Release the quit guard and stop everything that talks to a database:
   * disconnect the worker session, close tunnels and the local store.
   */
  shutdownForUpdate(): Promise<void>;
  /** The installer did not start after the shutdown: bring Plasma back. */
  relaunchAfterFailedInstall(): void;
}

const noopHost: UpdaterHost = {
  getUnsaved: () => ({ openTransaction: false, pendingEdits: 0 }),
  getActiveConnectionId: () => null,
  getWorkspaceRoot: () => null,
  reopenWorkspace: () => undefined,
  shutdownForUpdate: async () => undefined,
  relaunchAfterFailedInstall: () => undefined,
};

let windowSource: () => BrowserWindow | null = () => null;
let host: UpdaterHost = noopHost;

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
let trust: UpdateTrust = 'pending';
/** The installer file electron-updater downloaded and we verified (Windows / Linux). */
let readyFile: { path: string | null; version: string } | null = null;
/** The unpacked and checked bundle (macOS self-install). */
let macStaged: { staged: StagedUpdate; version: string } | null = null;
let installing = false;
/** After the workers are gone, an installer error must bring Plasma back. */
let handoverStarted = false;
let launchInfo: UpdateLaunchInfo = emptyLaunchInfo();
let beforeQuitHandler: (() => void) | null = null;
let preparedResolver: ((info: { connectionId: string | null } | null) => void) | null = null;

function emptyLaunchInfo(): UpdateLaunchInfo {
  return {
    resume: false,
    connectionId: null,
    outcome: 'none',
    version: null,
    logPath: null,
    downloadUrl: null,
  };
}

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
  readyFile = null;
  macStaged = null;
  autoUpdater.autoInstallOnAppQuit = false;
  broadcast({ kind: 'error', message: `Update refused: ${reason}` });
}

/**
 * Feed base URL out of the packaged `app-update.yml` — the bucket this build
 * was published to, and therefore where its installers sit. Read once, lazily;
 * a build whose manifest is unreadable falls back to the download page.
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

function releaseNotesOf(info: UpdateInfo): string | null {
  return typeof info.releaseNotes === 'string'
    ? info.releaseNotes
    : Array.isArray(info.releaseNotes)
      ? info.releaseNotes.map((n) => n.note ?? '').join('\n')
      : null;
}

/** Who installs on this machine, decided once per launch. */
type Installer =
  | { kind: 'nsis' | 'appimage' | 'squirrel' | 'mac-self' }
  | { kind: 'manual'; reason?: string };

function packageType(): string | null {
  try {
    return readFileSync(join(process.resourcesPath, 'package-type'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function macBundlePath(): string | null {
  return findAppBundle(process.execPath);
}

function chooseInstaller(macSignature: MacSignatureKind | null, signing: boolean): Installer {
  if (process.platform === 'darwin') {
    if (macSignature === 'certificate') return { kind: 'squirrel' };
    const bundle = macBundlePath();
    const eligibility = macInstallEligibility({
      bundlePath: bundle,
      writability: bundle == null ? 'denied' : probeWritability(join(bundle, '..')),
      bundleWritable: bundle == null ? false : probeBundleWritable(bundle),
    });
    if (!eligibility.ok) return { kind: 'manual', reason: eligibility.reason };
    if (!signing) {
      return { kind: 'manual', reason: 'This build does not verify update signatures.' };
    }
    return { kind: 'mac-self' };
  }
  const chosen = platformInstaller({
    platform: process.platform,
    env: process.env,
    packageType: packageType(),
    resourcesPath: process.resourcesPath,
    execPath: process.execPath,
  });
  return chosen.kind === 'manual' ? { kind: 'manual', reason: chosen.reason } : chosen;
}

/** The place everything of ours lives while an update is pending (macOS). */
function pendingRoot(): string {
  return join(app.getPath('userData'), 'pending-update');
}

function helperLogPath(): string {
  return join(app.getPath('userData'), 'logs', 'update-helper.log');
}

export function initUpdater(window: WindowSource, updaterHost: UpdaterHost = noopHost): void {
  windowSource = resolveWindow(window);
  host = updaterHost;
  installing = false;
  handoverStarted = false;
  launchInfo = emptyLaunchInfo();

  // The renderer's hooks must exist in every mode, or its `useUpdate` / launch
  // routine fails with "No handler registered".
  ipcMain.handle('plasma:update:status', () => lastStatus);
  ipcMain.handle('plasma:update:launchInfo', () => {
    const info = launchInfo;
    launchInfo = emptyLaunchInfo();
    return info;
  });
  ipcMain.handle('plasma:update:prepared', (_e, raw: unknown) => {
    const r = (raw ?? {}) as { connectionId?: unknown };
    const id =
      typeof r.connectionId === 'string' && r.connectionId.length < 4096 ? r.connectionId : null;
    preparedResolver?.({ connectionId: id });
    preparedResolver = null;
  });

  // Packaged E2E / agent runs must not hit the R2 updater feed.
  if (process.env.PLASMA_DISABLE_UPDATER === '1') {
    logger.info('[updater] skipped — PLASMA_DISABLE_UPDATER=1');
    ipcMain.handle('plasma:update:check', async () => lastStatus);
    ipcMain.handle('plasma:update:install', () => {
      // no-op when updater disabled
    });
    return;
  }

  // Dev builds don't have a real signed installer — `electron-updater`
  // throws on missing dev-app-update.yml otherwise. Skip the live polling
  // path but still register stub IPC handlers.
  if (!app.isPackaged) {
    logger.info('[updater] skipped — dev build');
    ipcMain.handle('plasma:update:check', async () => lastStatus);
    ipcMain.handle('plasma:update:install', () => {
      // no-op in dev
    });
    return;
  }

  const policy = updatePolicy(process.platform, packagedPublisherName());
  const macSignature: MacSignatureKind | null =
    process.platform === 'darwin' ? classifyMacAppSignature(app.getPath('exe')) : null;
  const signing = UPDATE_SIGNING_PUBLIC_KEY != null;
  const installer = chooseInstaller(macSignature, signing);
  if (installer.kind === 'manual') {
    logger.warn(`[updater] this install cannot update itself (${installer.reason ?? 'manual'})`);
  } else if (installer.kind === 'mac-self') {
    logger.info(`[updater] macOS bundle signature=${macSignature} — using Plasma's own installer`);
  }
  trust = signing ? 'pending' : 'unconfigured';

  const selfInstalling = installer.kind !== 'manual' && installer.kind !== 'mac-self';
  // Downloads: electron-updater downloads for nsis / appimage / squirrel. Our own macOS
  // installer downloads itself, and manual installs never download.
  const wantsDownload = policy.autoDownload && selfInstalling;
  // With signed manifests the download starts only after the manifest has been verified
  // (see `update-available`), and install-on-quit is armed only once the downloaded file
  // has been re-hashed. Without a key, behave as before.
  autoUpdater.autoDownload = wantsDownload && !signing;
  autoUpdater.autoInstallOnAppQuit = policy.autoInstallOnAppQuit && selfInstalling && !signing;
  if (!signing) {
    logger.warn(
      '[updater] no update-signing public key embedded (src/main/update-signing-key.ts) — update manifests are NOT verified',
    );
  }
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;

  autoUpdater.logger = {
    info: (msg) => logger.info('[updater]', msg),
    warn: (msg) => logger.warn('[updater]', msg),
    error: (msg) => logger.error('[updater]', msg),
    debug: (msg) => logger.info('[updater:debug]', msg),
  } as typeof autoUpdater.logger;

  concludeLastRestart(installer.kind === 'appimage');

  autoUpdater.on('checking-for-update', () => {
    broadcast({ kind: 'checking' });
  });

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    broadcast({ kind: 'not-available', version: info.version, checkedAt: Date.now() });
  });

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    // A newer download must never be installed on quit before it has been verified.
    if (signing) autoUpdater.autoInstallOnAppQuit = false;
    readyFile = null;
    macStaged = null;
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
        const signed = verdict.status === 'verified' ? verdict.manifest : null;
        beginUpdate(info, signed, token);
      });
      return;
    }
    beginUpdate(info, null, verifyToken);
  });

  /** The manifest check is done (or there is none): offer the update and start fetching it. */
  function beginUpdate(info: UpdateInfo, signed: ParsedManifest | null, token: number): void {
    if (installer.kind === 'manual') {
      broadcast(manualStatus(info, signed, installer.reason));
      return;
    }
    if (installer.kind === 'mac-self') {
      if (signed == null) {
        broadcast(
          manualStatus(
            info,
            signed,
            'This update has no signed manifest, so it cannot install itself.',
          ),
        );
        return;
      }
      broadcast({ kind: 'available', version: info.version, releaseNotes: releaseNotesOf(info) });
      void macDownload(info, signed, token);
      return;
    }
    broadcast({ kind: 'available', version: info.version, releaseNotes: releaseNotesOf(info) });
    if (wantsDownload && signing) {
      autoUpdater.downloadUpdate().catch((err: unknown) => {
        logger.warn('[updater] download failed', err);
      });
    }
  }

  function manualStatus(
    info: UpdateInfo,
    signed: ParsedManifest | null,
    reason?: string,
  ): UpdateStatus {
    let downloadUrl: string;
    if (process.platform === 'darwin') {
      downloadUrl = signed
        ? macDownloadUrlFromManifest(feedBaseUrl(), signed.files, info.version, process.arch)
        : macDownloadUrl(feedBaseUrl(), info.version, process.arch);
    } else if (process.platform === 'linux' && signed) {
      downloadUrl = debDownloadUrlFromManifest(feedBaseUrl(), signed.files);
    } else {
      downloadUrl = SITE_DOWNLOAD_URL;
    }
    return {
      kind: 'available-manual',
      version: info.version,
      downloadUrl,
      ...(reason ? { reason } : {}),
    };
  }

  // ── macOS: download + unpack with our own installer ────────────────
  async function macDownload(
    info: UpdateInfo,
    signed: ParsedManifest,
    token: number,
  ): Promise<void> {
    const base = feedBaseUrl();
    const file = pickMacZip(signed.files, info.version, process.arch);
    if (base == null || file == null) {
      broadcast(manualStatus(info, signed, 'This release has no update package for your Mac.'));
      return;
    }
    const root = pendingRoot();
    const zipPath = join(root, file.url);
    try {
      let reuse = false;
      if (existsSync(zipPath)) {
        reuse = (await sha512OfFile(zipPath).catch(() => '')) === file.sha512;
      }
      if (!reuse) {
        await downloadVerified({
          url: `${base}/${encodeURIComponent(file.url)}`,
          dest: zipPath,
          sha512: file.sha512,
          ...(file.size ? { size: file.size } : {}),
          onProgress: (p) => {
            if (token === verifyToken) broadcast({ kind: 'downloading', ...p });
          },
        });
      }
    } catch (err) {
      if (token !== verifyToken) return;
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('[updater] macOS update download failed', err);
      if (/sha512/.test(message)) return refuse(message);
      broadcast({ kind: 'error', message: `The update could not be downloaded: ${message}` });
      return;
    }
    if (token !== verifyToken) return;
    try {
      const bundle = macBundlePath();
      const own = bundle ? await readBundleInfo(bundle) : null;
      if (own?.identifier == null) throw new Error("could not read this app's own identifier");
      // One staged copy at a time (~300 MB each), and no zips of older versions.
      removePendingDownloads(root, file.url);
      const staged = await stageUpdate({
        zipPath,
        stageRoot: root,
        version: info.version,
        expectedIdentifier: own.identifier,
      });
      if (token !== verifyToken) return;
      macStaged = { staged, version: info.version };
      logger.info(`[updater] macOS update ${info.version} staged at ${staged.bundle}`);
      broadcast({ kind: 'downloaded', version: info.version, releaseNotes: releaseNotesOf(info) });
    } catch (err) {
      if (token !== verifyToken) return;
      logger.warn('[updater] macOS update could not be staged', err);
      const message = err instanceof Error ? err.message : String(err);
      broadcast(manualStatus(info, signed, `Automatic install is not possible: ${message}.`));
    }
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
        armInstall(info);
        announceDownloaded(info);
      });
      return;
    }
    if (signing) {
      // Unsigned-but-allowed legacy update: download completes, install stays manual.
      logger.warn('[updater] downloaded an update whose manifest was not signed (legacy feed)');
    }
    readyFile = { path: info.downloadedFile ?? null, version: info.version };
    announceDownloaded(info);
  });

  /** The file matches the signed sha512: install-on-quit may be armed, the AppImage gets a backup. */
  function armInstall(info: UpdateInfo & { downloadedFile?: string }): void {
    readyFile = { path: info.downloadedFile ?? null, version: info.version };
    const plan = installPlan({
      osSignatureVerified: policy.signatureVerified,
      trust,
      fileVerified: true,
    });
    if (installer.kind === 'appimage' && process.env.APPIMAGE) {
      const backup = backupAppImage(process.env.APPIMAGE, app.getVersion());
      if (backup == null)
        logger.warn('[updater] no backup link for the AppImage (unsupported folder)');
    }
    autoUpdater.autoInstallOnAppQuit = plan.installOnQuit;
    // electron-updater only registers its quit handler when the flag is already true as the
    // download ends, which is before this check. Register it now; it re-reads the flag at quit.
    if (plan.installOnQuit) {
      (autoUpdater as unknown as { addQuitHandler?: () => void }).addQuitHandler?.();
    }
  }

  function announceDownloaded(info: UpdateInfo): void {
    broadcast({ kind: 'downloaded', version: info.version, releaseNotes: releaseNotesOf(info) });
  }

  // electron-updater names the new AppImage after the download and deletes the old name.
  // Keep the installed `plasma` command and any shortcut to the old name working.
  (autoUpdater as unknown as { on(e: string, h: (p: string) => void): void }).on(
    'appimage-filename-updated',
    (newPath) => {
      const old = process.env.APPIMAGE;
      if (installer.kind !== 'appimage' || !old || typeof newPath !== 'string') return;
      try {
        const linked = leaveAppImageSymlink(old, newPath);
        const wrappers = repointAppImageWrappers(
          installTargets(homedir()).map((t) => t.dir),
          old,
          newPath,
        );
        logger.info(
          `[updater] AppImage renamed to ${newPath}; symlink=${linked}, wrappers=${wrappers.length}`,
        );
      } catch (err) {
        logger.warn('[updater] could not repoint the old AppImage name', err);
      }
    },
  );

  // Install-on-quit runs a file hours after its only hash check, inside electron-updater's own
  // synchronous quit handler. Re-hash it here, just before, and disarm on any doubt.
  beforeQuitHandler = () => {
    if (installing || !autoUpdater.autoInstallOnAppQuit || !signing) return;
    const path = readyFile?.path;
    const problem =
      trust === 'signed' && verifiedManifest != null && path
        ? checkDownloadedFileSync(path, verifiedManifest)
        : 'the downloaded update is no longer verified';
    if (problem != null) refuse(problem);
  };
  app.on('before-quit', beforeQuitHandler);

  autoUpdater.on('error', (err) => {
    // electron-updater unlinks the AppImage before it moves the new one in: if that failed
    // (also on a plain quit) put the old one back.
    if (installer.kind === 'appimage' && process.env.APPIMAGE) {
      if (restoreAppImage(process.env.APPIMAGE, app.getVersion())) {
        logger.warn('[updater] the AppImage swap failed; the previous AppImage was restored');
      }
    }
    if (handoverStarted) {
      // The workers are gone and the installer did not take over: do not leave a dead window.
      logger.error('[updater] the installer failed after shutdown', err);
      handoverStarted = false;
      host.relaunchAfterFailedInstall();
      return;
    }
    broadcast({ kind: 'error', message: err?.message ?? String(err) });
  });

  // ── IPC ────────────────────────────────────────────────────────────
  const busy = () =>
    lastStatus.kind === 'downloading' ||
    lastStatus.kind === 'downloaded' ||
    lastStatus.kind === 'restarting';

  ipcMain.handle('plasma:update:check', async () => {
    // Do not hide a ready update behind a new check.
    if (busy()) return lastStatus;
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
    // Nothing the app can install itself: hand the user the download.
    if (lastStatus.kind === 'available-manual') {
      if (isSafeExternalUrl(lastStatus.downloadUrl))
        await shell.openExternal(lastStatus.downloadUrl);
      return;
    }
    if (lastStatus.kind !== 'downloaded') {
      logger.warn(`[updater] install requested with status=${lastStatus.kind} — ignored`);
      return;
    }
    if (installing) return;
    installing = true;
    try {
      await restartToUpdate(lastStatus);
    } catch (err) {
      logger.error('[updater] restart to update failed', err);
      if (handoverStarted) {
        handoverStarted = false;
        host.relaunchAfterFailedInstall();
        return;
      }
      installing = false;
      broadcast({
        kind: 'error',
        message: `Could not restart to update: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  async function restartToUpdate(
    ready: Extract<UpdateStatus, { kind: 'downloaded' }>,
  ): Promise<void> {
    // 1. What would be lost? Ask once; with nothing at stake go straight on.
    const loss = describeLoss(AppUnsavedState.parse(host.getUnsaved()));
    if (loss.length > 0 && !(await confirmDiscard(loss))) {
      installing = false;
      return;
    }

    // 2. Re-check the bytes we are about to run, right before running them.
    let fileVerified = false;
    if (installer.kind === 'mac-self') {
      if (macStaged == null || macStaged.version !== ready.version) {
        throw new Error('the update is no longer staged');
      }
    } else if (signing && trust === 'signed' && verifiedManifest != null) {
      const path = readyFile?.path ?? null;
      if (path != null) {
        const problem = await checkDownloadedFile(path, verifiedManifest).catch(
          (e: unknown) =>
            `could not read the downloaded file (${e instanceof Error ? e.message : String(e)})`,
        );
        if (problem != null) {
          installing = false;
          refuse(problem);
          return;
        }
        fileVerified = true;
      }
    }
    const plan = installPlan({
      osSignatureVerified: policy.signatureVerified,
      trust,
      fileVerified,
    });

    // macOS: the app may have been moved since the check.
    let macPlan: { oldBundle: string; staged: StagedUpdate } | null = null;
    if (installer.kind === 'mac-self' && macStaged != null) {
      const oldBundle = macBundlePath();
      const eligibility = macInstallEligibility({
        bundlePath: oldBundle,
        writability: oldBundle == null ? 'denied' : probeWritability(join(oldBundle, '..')),
        bundleWritable: oldBundle == null ? false : probeBundleWritable(oldBundle),
      });
      if (!eligibility.ok || oldBundle == null) {
        installing = false;
        broadcast({
          kind: 'available-manual',
          version: ready.version,
          downloadUrl: macDownloadUrl(feedBaseUrl(), ready.version, process.arch),
          reason: eligibility.ok ? undefined : eligibility.reason,
        });
        return;
      }
      macPlan = { oldBundle, staged: macStaged.staged };
    }

    // 3. Let the renderer write the tab strip down, then remember what to bring back.
    broadcast({ kind: 'restarting', version: ready.version });
    const prepared = await prepareRenderer();
    const marker: RestartMarker = {
      v: 1,
      platform: process.platform,
      fromVersion: app.getVersion(),
      expectedVersion: ready.version,
      at: Date.now(),
      connectionId: prepared?.connectionId ?? host.getActiveConnectionId(),
      workspaceRoot: host.getWorkspaceRoot(),
      logPath: macPlan ? helperLogPath() : null,
    };
    writeRestartMarker(app.getPath('userData'), marker);

    // 4. Stop the workers cleanly, then hand over. From here a failure must relaunch.
    handoverStarted = true;
    await host.shutdownForUpdate();
    if (macPlan) {
      const script = buildHelperScript({
        pid: process.pid,
        oldBundle: macPlan.oldBundle,
        newBundle: macPlan.staged.bundle,
        stageDir: macPlan.staged.stageDir,
        stageRoot: pendingRoot(),
        id: `${Date.now()}${randomBytes(2).toString('hex')}`,
      });
      launchHelper({
        script,
        stageDir: macPlan.staged.stageDir,
        logPath: helperLogPath(),
        onError: (err) => logger.error('[updater] the update helper failed to run', err),
      });
      logger.info('[updater] update helper started; quitting');
      app.quit();
      return;
    }
    // Last look at the bytes we are about to run, after the flush and the shutdown, with
    // nothing awaited in between. A failure throws into the relaunch path.
    if (signing && trust === 'signed' && verifiedManifest != null && readyFile?.path) {
      const problem = checkDownloadedFileSync(readyFile.path, verifiedManifest);
      if (problem != null) {
        refuse(problem);
        throw new Error(problem);
      }
    }
    logger.info(`[updater] quitAndInstall(silent=${plan.silent}) for ${ready.version}`);
    autoUpdater.quitAndInstall(plan.silent, true);
  }

  async function confirmDiscard(loss: string[]): Promise<boolean> {
    const win = windowSource();
    const options = {
      type: 'warning' as const,
      buttons: ['Cancel', 'Restart and discard'],
      defaultId: 0,
      cancelId: 0,
      message: 'Restart now?',
      detail: `Restarting will discard:\n${loss.map((l) => `• ${l}`).join('\n')}\n\nYour open SQL tabs are saved and come back after the restart.`,
    };
    const r =
      win && !win.isDestroyed()
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options);
    return r.response === 1;
  }

  /** Ask the renderer to flush its tab strip; null when it does not answer in time. */
  function prepareRenderer(): Promise<{ connectionId: string | null } | null> {
    const win = windowSource();
    if (!win || win.isDestroyed()) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        preparedResolver = null;
        resolve(null);
      }, PREPARE_TIMEOUT_MS);
      preparedResolver = (info) => {
        clearTimeout(timer);
        // Chromium writes localStorage lazily and the installer may kill this process soon.
        try {
          win.webContents.session?.flushStorageData?.();
        } catch (err) {
          logger.warn('[updater] flushStorageData failed', err);
        }
        setTimeout(() => resolve(info), FLUSH_SETTLE_MS);
      };
      win.webContents.send('plasma:update:prepare');
    });
  }

  // ── Auto-poll schedule ───────────────────────────────────────────
  const poll = (what: string) => () => {
    if (busy() || installing) return; // never replace a ready update's button with a new check
    autoUpdater.checkForUpdates().catch((err) => {
      logger.warn(`[updater] ${what} check failed`, err);
    });
  };
  initialTimer = setTimeout(poll('initial'), POLL_AFTER_LAUNCH_MS);
  pollTimer = setInterval(poll('poll'), POLL_INTERVAL_MS);
}

/**
 * First thing after a launch: what did the last update restart come to?
 * Restores the session hints for the renderer, tells it how the update went and
 * removes what the installer left behind.
 */
function concludeLastRestart(appImageActive: boolean): void {
  const userData = app.getPath('userData');
  const marker = readRestartMarker(userData);
  const running = app.getVersion();
  const verdict = evaluateRestartMarker(marker, running, Date.now());
  if (marker != null) clearRestartMarker(userData);
  if (marker != null && verdict.resume) {
    launchInfo = {
      resume: true,
      connectionId: marker.connectionId,
      outcome: verdict.outcome === 'none' ? 'none' : verdict.outcome,
      version: verdict.outcome === 'failed' ? verdict.expectedVersion : running,
      logPath: verdict.outcome === 'failed' ? marker.logPath : null,
      downloadUrl: verdict.outcome === 'failed' ? SITE_DOWNLOAD_URL : null,
    };
    if (marker.workspaceRoot) {
      try {
        host.reopenWorkspace(marker.workspaceRoot);
      } catch (err) {
        logger.warn('[updater] could not reopen the workspace after the update', err);
      }
    }
    if (verdict.outcome === 'failed') {
      logger.error(
        `[updater] the update to ${verdict.expectedVersion} was not installed; still on ${running}`,
      );
      lastStatus = {
        kind: 'error',
        message: `The update to ${verdict.expectedVersion} could not be installed.${marker.logPath ? ` Log: ${marker.logPath}.` : ''} Download it from ${SITE_DOWNLOAD_URL}.`,
      };
    } else {
      logger.info(`[updater] updated from ${marker.fromVersion} to ${running}`);
    }
  }
  try {
    if (process.platform === 'darwin') {
      // After an update attempt everything is spent; otherwise keep the verified zip for the next check.
      if (verdict.resume) removePendingDownloads(pendingRoot());
      else removeStages(pendingRoot());
    }
    if (appImageActive && process.env.APPIMAGE) {
      pruneAppImageBackups(process.env.APPIMAGE, running);
      pruneDanglingAppImageLinks(process.env.APPIMAGE);
    }
  } catch (err) {
    logger.warn('[updater] cleanup after the last update failed', err);
  }
}

export function disposeUpdater(): void {
  if (beforeQuitHandler) {
    app.off('before-quit', beforeQuitHandler);
    beforeQuitHandler = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  ipcMain.removeHandler('plasma:update:check');
  ipcMain.removeHandler('plasma:update:install');
  ipcMain.removeHandler('plasma:update:status');
  ipcMain.removeHandler('plasma:update:launchInfo');
  ipcMain.removeHandler('plasma:update:prepared');
}
