import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  constants,
  accessSync,
  chmodSync,
  closeSync,
  createWriteStream,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { ManifestFile } from './update-signing';

/**
 * Plasma's own self-update for macOS builds that are not certificate-signed.
 *
 * Squirrel.Mac refuses any update that does not satisfy the *installed* app's
 * designated requirement, which an unsigned or ad-hoc build can never meet
 * (docs/mac-auto-update.md). What replaces it here:
 *
 *   1. download the arm64 .zip listed in the signed manifest, hashing while
 *      it streams, and keep it only if the sha512 matches the signed one;
 *   2. unpack it with `ditto` into a staging folder and check the bundle
 *      (identifier, version, `codesign --verify`);
 *   3. at "Restart to update", quit and let a detached `/bin/sh` helper swap
 *      the bundle and reopen it (`buildHelperScript`).
 *
 * The integrity basis is the ed25519 signed manifest (`update-signing.ts`),
 * not Apple code signing. Everything that touches the OS is injected
 * (`RunCommand`, `fetch`) so the logic is unit-tested without a Mac.
 */

// ── Where the running app lives ───────────────────────────────────────

/** `…/Plasma.app` out of `…/Plasma.app/Contents/MacOS/Plasma`, or null. */
export function findAppBundle(execPath: string): string | null {
  const parts = execPath.split('/');
  const idx = parts.findIndex((p) => p.endsWith('.app') && p.length > '.app'.length);
  if (idx <= 0) return null;
  return parts.slice(0, idx + 1).join('/') || null;
}

export type Writability = 'writable' | 'read-only' | 'denied';

/** Can this user create and rename entries in `dir`? Read-only volumes report EROFS. */
export function probeWritability(dir: string): Writability {
  try {
    accessSync(dir, constants.W_OK);
    return 'writable';
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EROFS' ? 'read-only' : 'denied';
  }
}

/**
 * Can this user delete the installed bundle? A copy installed with sudo or by
 * MDM has root-owned contents: the rename would work but the old copy could
 * never be removed, leaving a second app in Applications.
 */
export function probeBundleWritable(bundle: string): boolean {
  try {
    accessSync(bundle, constants.W_OK);
    accessSync(join(bundle, 'Contents'), constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export type MacInstallEligibility = { ok: true } | { ok: false; reason: string };

export const MOVE_TO_APPLICATIONS = 'Move Plasma to Applications to get automatic updates.';

/**
 * Can this running bundle replace itself? Not when macOS runs it from an
 * App Translocation sandbox (a quarantined app opened from Downloads), from a
 * mounted dmg (read-only volume), or when its parent folder is not writable
 * by the user.
 */
export function macInstallEligibility(input: {
  bundlePath: string | null;
  writability: Writability;
  /** `probeBundleWritable`; defaults to true. */
  bundleWritable?: boolean;
}): MacInstallEligibility {
  const { bundlePath, writability } = input;
  if (bundlePath == null) return { ok: false, reason: MOVE_TO_APPLICATIONS };
  if (bundlePath.includes('/AppTranslocation/')) return { ok: false, reason: MOVE_TO_APPLICATIONS };
  if (writability === 'read-only') return { ok: false, reason: MOVE_TO_APPLICATIONS };
  if (writability === 'denied') {
    return {
      ok: false,
      reason: `Plasma's folder (${dirname(bundlePath)}) is not writable by you. ${MOVE_TO_APPLICATIONS}`,
    };
  }
  if (input.bundleWritable === false) {
    return {
      ok: false,
      reason: `Plasma's files are owned by another user. ${MOVE_TO_APPLICATIONS}`,
    };
  }
  return { ok: true };
}

// ── Choosing and downloading the file ─────────────────────────────────

/**
 * The arm64 zip of this release in the signed manifest. Plain file names only,
 * and the version must be in the name, so a manifest cannot point at some
 * other path or release.
 */
export function pickMacZip(
  files: readonly ManifestFile[],
  version: string,
  arch: string,
): ManifestFile | null {
  if (arch !== 'arm64') return null;
  return (
    files.find(
      (f) =>
        /^[\w.-]+\.zip$/.test(f.url) &&
        f.url.endsWith(`-${arch}.zip`) &&
        f.url.includes(`-${version}-`),
    ) ?? null
  );
}

export type DownloadProgress = {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
};

export type FetchBody = {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body: AsyncIterable<Uint8Array> | null;
};

/** Hard ceiling when the manifest has no size: the real zip is ~110 MB. */
export const MAX_ZIP_BYTES = 600 * 1024 * 1024;

/**
 * Streams `url` to `dest`, hashing as it goes. The bytes only become `dest`
 * when the sha512 equals the signed one; anything else is deleted and throws.
 * https only. A partial or tampered download never has the final name.
 */
export async function downloadVerified(opts: {
  url: string;
  dest: string;
  sha512: string;
  size?: number;
  fetchImpl?: (url: string, signal: AbortSignal) => Promise<FetchBody>;
  onProgress?: (p: DownloadProgress) => void;
  now?: () => number;
  /** Abort when no byte arrives for this long. Default 60 s. */
  idleTimeoutMs?: number;
}): Promise<void> {
  const { url, dest, sha512 } = opts;
  const now = opts.now ?? Date.now;
  if (!url.startsWith('https://')) throw new Error('the update URL is not https');
  const fetchImpl =
    opts.fetchImpl ??
    ((u: string, signal: AbortSignal) =>
      fetch(u, { redirect: 'follow', signal }) as unknown as Promise<FetchBody>);
  const controller = new AbortController();
  const idleMs = opts.idleTimeoutMs ?? 60_000;
  let idle: ReturnType<typeof setTimeout> | null = null;
  let stalled = false;
  const bump = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, idleMs);
  };
  const stopIdle = () => {
    if (idle) clearTimeout(idle);
    idle = null;
  };
  const limit = opts.size && opts.size > 0 ? opts.size : MAX_ZIP_BYTES;

  bump();
  let res: FetchBody;
  try {
    res = await fetchImpl(url, controller.signal);
  } catch (err) {
    stopIdle();
    throw stalled ? new Error('the download stalled (no data for a minute)') : err;
  }
  if (!res.ok || res.body == null) {
    stopIdle();
    throw new Error(`download failed (HTTP ${res.status})`);
  }
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > limit) {
    stopIdle();
    throw new Error('the download is larger than the signed size');
  }

  // A name of its own: two overlapping downloads must never write the same file.
  const part = `${dest}.${randomBytes(4).toString('hex')}.part`;
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  const out = createWriteStream(part, { mode: 0o600 });
  let streamError: Error | null = null;
  out.on('error', (e) => {
    streamError = e;
  });
  const discard = async () => {
    if (!out.closed) await new Promise<void>((r) => out.once('close', () => r()).destroy());
    rmSync(part, { force: true });
  };
  try {
    await new Promise<void>((resolve, reject) => {
      out.once('open', () => resolve());
      out.once('error', reject);
    });
  } catch (err) {
    stopIdle();
    await discard();
    throw err;
  }
  const hash = createHash('sha512');
  const total = opts.size && opts.size > 0 ? opts.size : Number.isFinite(declared) ? declared : 0;
  const started = now();
  let transferred = 0;
  let lastEmit = 0;
  try {
    for await (const chunk of res.body) {
      bump();
      transferred += chunk.byteLength;
      if (streamError) throw streamError;
      if (transferred > limit) throw new Error('the download is larger than the signed size');
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', r));
      const t = now();
      if (opts.onProgress && t - lastEmit >= 250) {
        lastEmit = t;
        opts.onProgress({
          percent: total > 0 ? Math.min(100, (transferred / total) * 100) : 0,
          bytesPerSecond: transferred / Math.max(0.001, (t - started) / 1000),
          transferred,
          total,
        });
      }
    }
    await new Promise<void>((resolve, reject) => {
      out.once('error', reject);
      out.end(resolve);
    });
  } catch (err) {
    stopIdle();
    await discard();
    if (stalled) throw new Error('the download stalled (no data for a minute)');
    throw err instanceof Error ? err : new Error(String(err));
  }
  stopIdle();
  if (hash.digest('base64') !== sha512) {
    await discard();
    throw new Error('the downloaded file does not match the signed sha512');
  }
  renameSync(part, dest);
  opts.onProgress?.({ percent: 100, bytesPerSecond: 0, transferred, total: total || transferred });
}

// ── Unpacking and checking the bundle ─────────────────────────────────

export type CommandResult = { code: number; stdout: string; stderr: string };
export type RunCommand = (cmd: string, args: string[]) => Promise<CommandResult>;

/** execFile without a shell; never rejects, a spawn failure is `code: -1`. */
export const runCommand: RunCommand = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const raw = (err as { code?: unknown } | null)?.code;
      const code = err == null ? 0 : typeof raw === 'number' ? raw : -1;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

export type BundleInfo = { identifier: string | null; version: string | null };

/** Reads the two Info.plist keys through `plutil` (handles binary plists too). */
export async function readBundleInfo(
  bundle: string,
  run: RunCommand = runCommand,
): Promise<BundleInfo | null> {
  const res = await run('/usr/bin/plutil', [
    '-convert',
    'json',
    '-o',
    '-',
    join(bundle, 'Contents', 'Info.plist'),
  ]);
  if (res.code !== 0) return null;
  try {
    const json = JSON.parse(res.stdout) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' ? v : null);
    return {
      identifier: str(json.CFBundleIdentifier),
      version: str(json.CFBundleShortVersionString),
    };
  } catch {
    return null;
  }
}

/** Why an unpacked bundle is not the update we expect, or null when it is. */
export function checkBundleInfo(
  info: BundleInfo | null,
  expected: { identifier: string; version: string },
): string | null {
  if (info == null) return 'the update bundle has no readable Info.plist';
  if (info.identifier !== expected.identifier) {
    return `the update bundle is ${info.identifier ?? 'unidentified'}, not ${expected.identifier}`;
  }
  if (info.version !== expected.version) {
    return `the update bundle is version ${info.version ?? 'unknown'}, expected ${expected.version}`;
  }
  return null;
}

/** Name of the file that marks a folder as one this module created. */
export const STAGE_MARKER = '.plasma-stage';

export type StagedUpdate = { stageDir: string; bundle: string };

/**
 * Unpacks the verified zip into `<stageRoot>/stage-<version>-<id>/` and checks
 * the bundle. On any problem the staging folder is removed and the reason thrown.
 */
export async function stageUpdate(opts: {
  zipPath: string;
  stageRoot: string;
  version: string;
  expectedIdentifier: string;
  run?: RunCommand;
}): Promise<StagedUpdate> {
  const run = opts.run ?? runCommand;
  const stageDir = join(opts.stageRoot, `stage-${opts.version}-${randomBytes(4).toString('hex')}`);
  mkdirSync(stageDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(stageDir, STAGE_MARKER), `${opts.version}\n`);
  const abort = (reason: string): never => {
    rmSync(stageDir, { recursive: true, force: true });
    throw new Error(reason);
  };

  const unzip = await run('/usr/bin/ditto', ['-x', '-k', opts.zipPath, stageDir]);
  if (unzip.code !== 0) abort(`could not unpack the update (ditto exit ${unzip.code})`);

  const apps = readdirSync(stageDir, { withFileTypes: true }).filter(
    (e) => e.isDirectory() && e.name.endsWith('.app'),
  );
  if (apps.length !== 1) abort('the update archive does not hold exactly one app bundle');
  const bundle = join(stageDir, (apps[0] as { name: string }).name);

  const problem = checkBundleInfo(await readBundleInfo(bundle, run), {
    identifier: opts.expectedIdentifier,
    version: opts.version,
  });
  if (problem != null) abort(problem);

  const sig = await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  if (sig.code !== 0) {
    const detail = sig.stderr.trim().slice(0, 200) || `exit ${sig.code}`;
    abort(`the update bundle failed codesign verification: ${detail}`);
  }
  return { stageDir, bundle };
}

// ── The swap helper ───────────────────────────────────────────────────

/** POSIX single-quote escaping: safe for any path, spaces and quotes included. */
export function shQuote(value: string): string {
  if (value.includes('\0')) throw new Error('NUL in a shell argument');
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export type HelperPlan = {
  /** Process to wait for: the app that is about to quit. */
  pid: number;
  /** The installed bundle, e.g. /Applications/Plasma.app. */
  oldBundle: string;
  /** The verified bundle inside `stageDir`. */
  newBundle: string;
  /** Folder this module created for this update; holds `STAGE_MARKER`. */
  stageDir: string;
  /** The folder that holds all staging folders (`<userData>/pending-update`). */
  stageRoot: string;
  /** Unique suffix for the backup / temporary names. */
  id: string;
  /** How long to wait for `pid`, in half seconds. Default 3600 (30 min, waiting quietly). */
  waitHalfSeconds?: number;
  tools?: Partial<Record<'open' | 'xattr' | 'ditto', string>>;
};

/**
 * The helper. It runs after the app has quit and must be safe to run blind:
 *
 *  - every path is a single-quoted literal (no interpolation, no eval);
 *  - the new bundle is first copied next to the old one (same volume), the old
 *    one is only renamed once that worked, and every later failure puts the old
 *    bundle back and reopens it;
 *  - `rm -rf` only ever touches names it created: `<old>.old-<id>`,
 *    `<old>.new-<id>`, `<old>.bad-<id>` and the staging folder (only if it
 *    holds `STAGE_MARKER` and sits inside `stageRoot`). Anything else is refused.
 */
export function buildHelperScript(plan: HelperPlan): string {
  const tools = {
    open: '/usr/bin/open',
    xattr: '/usr/bin/xattr',
    ditto: '/usr/bin/ditto',
    ...plan.tools,
  };
  if (!Number.isInteger(plan.pid) || plan.pid <= 1) throw new Error('invalid pid');
  if (!/^[0-9A-Za-z._-]+$/.test(plan.id)) throw new Error('invalid helper id');
  const backup = `${plan.oldBundle}.old-${plan.id}`;
  const fresh = `${plan.oldBundle}.new-${plan.id}`;
  const bad = `${plan.oldBundle}.bad-${plan.id}`;
  const q = shQuote;
  return `#!/bin/sh
# Plasma update helper (generated by src/main/mac-self-update.ts). Runs after Plasma quit.
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
PID=${q(String(plan.pid))}
OLD=${q(plan.oldBundle)}
NEW=${q(plan.newBundle)}
BACKUP=${q(backup)}
FRESH=${q(fresh)}
BAD=${q(bad)}
PARENT=${q(dirname(plan.oldBundle))}
STAGE=${q(plan.stageDir)}
STAGE_ROOT=${q(plan.stageRoot)}
STAGE_MARKER=${q(STAGE_MARKER)}
OPEN=${q(tools.open)}
XATTR=${q(tools.xattr)}
DITTO=${q(tools.ditto)}
WAIT=${plan.waitHalfSeconds ?? 3600}

log() { printf '%s %s\\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*"; }

# Remove a path this script created. $1 = path, $2 = the folder it must sit in.
safe_rm() {
  case "$1" in
    ''|/|../*|*/../*|*/..) log "refusing to remove '$1'"; return 1 ;;
  esac
  case "$1" in
    "$2"/*) ;;
    *) log "refusing to remove '$1' (outside '$2')"; return 1 ;;
  esac
  [ -e "$1" ] || [ -L "$1" ] || return 0
  rm -rf -- "$1"
}

relaunch_old() { "$OPEN" -n "$OLD" || log "could not reopen the old app"; }

log "update helper started for pid $PID: $OLD"
i=0
while kill -0 "$PID" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -eq 120 ]; then log "Plasma is still running after 60 s; waiting quietly"; fi
  if [ "$i" -ge "$WAIT" ]; then
    log "Plasma did not quit in time; nothing was changed"
    exit 1
  fi
  sleep 0.5
done

# Plasma may have been reopened by hand since it quit: never swap a running bundle.
running_from_old() {
  ps -axo command= 2>/dev/null | grep -F -- "$OLD/Contents/MacOS/" | grep -v -F 'grep -F' | grep -q .
}
if running_from_old; then log "Plasma is running again; nothing was changed"; exit 1; fi

if [ ! -d "$OLD" ]; then log "the installed app is missing; nothing was changed"; exit 1; fi
if [ ! -d "$NEW" ]; then log "the new app is missing; reopening the old one"; relaunch_old; exit 1; fi

# 1. Put the new bundle next to the old one (same volume), leaving the old one alone.
if ! mv "$NEW" "$FRESH"; then
  log "mv failed; copying with ditto"
  safe_rm "$FRESH" "$PARENT"
  if ! "$DITTO" "$NEW" "$FRESH"; then
    log "copy failed; the old app is untouched"
    safe_rm "$FRESH" "$PARENT"
    relaunch_old
    exit 1
  fi
fi

# 2. Swap. The old bundle is only renamed, never deleted, until the new one opens.
if ! mv "$OLD" "$BACKUP"; then
  log "could not move the old app aside; the old app is untouched"
  safe_rm "$FRESH" "$PARENT"
  relaunch_old
  exit 1
fi
if ! mv "$FRESH" "$OLD"; then
  log "could not move the new app into place; restoring the old one"
  mv "$BACKUP" "$OLD" || log "RESTORE FAILED: the old app is at $BACKUP"
  safe_rm "$FRESH" "$PARENT"
  relaunch_old
  exit 1
fi

# 3. Our own process wrote these files, so there is no quarantine flag; clear it anyway.
"$XATTR" -dr com.apple.quarantine "$OLD" 2>/dev/null

# 4. Start the new version. If macOS cannot, go back.
if ! "$OPEN" -n "$OLD"; then
  log "the new app did not open; restoring the old one"
  if mv "$OLD" "$BAD"; then
    if mv "$BACKUP" "$OLD"; then
      safe_rm "$BAD" "$PARENT"
    else
      log "RESTORE FAILED: the old app is at $BACKUP, the new one at $BAD"
      exit 1
    fi
  fi
  relaunch_old
  exit 1
fi

# 5. Done: remove what this script created or renamed.
log "the new app was opened; cleaning up"
# The old copy goes into our staging folder first, so a leftover (for example root-owned
# files that cannot be deleted) never stays in the Applications folder.
if [ -f "$STAGE/$STAGE_MARKER" ] && mv "$BACKUP" "$STAGE/previous-app"; then :; else safe_rm "$BACKUP" "$PARENT"; fi
if [ -f "$STAGE/$STAGE_MARKER" ]; then safe_rm "$STAGE" "$STAGE_ROOT"; fi
if [ -e "$BACKUP" ]; then log "the old app could not be removed: $BACKUP"; fi
log "update finished"
exit 0
`;
}

/**
 * Writes the helper into its staging folder and starts it detached, logging to
 * `logPath`. Throws when it did not start, so the caller can stay running.
 */
export function launchHelper(opts: {
  script: string;
  stageDir: string;
  logPath: string;
  onError?: (err: Error) => void;
}): number {
  const scriptPath = join(opts.stageDir, 'update-helper.sh');
  writeFileSync(scriptPath, opts.script, { mode: 0o700 });
  chmodSync(scriptPath, 0o700);
  mkdirSync(dirname(opts.logPath), { recursive: true });
  const fd = openSync(opts.logPath, 'a', 0o600);
  try {
    const child = spawn('/bin/sh', [scriptPath], { detached: true, stdio: ['ignore', fd, fd] });
    // An async spawn failure must not become an uncaught exception in main.
    child.once('error', (err) => opts.onError?.(err));
    child.unref();
    if (child.pid == null) throw new Error('the update helper could not be started');
    return child.pid;
  } finally {
    closeSync(fd);
  }
}

// ── Housekeeping ──────────────────────────────────────────────────────

const ZIP_NAME = /^Plasma-[\w.-]+-arm64\.zip(\.[0-9a-f]{8})?(\.part)?$/;
const STAGE_NAME = /^stage-[\w.-]+-[0-9a-f]{8}$/;

function listDir(root: string): string[] {
  try {
    return statSync(root).isDirectory() ? readdirSync(root) : [];
  } catch {
    return [];
  }
}

/** Removes staging folders this module created (by exact name shape). Zips stay. */
export function removeStages(stageRoot: string): void {
  for (const name of listDir(stageRoot)) {
    if (STAGE_NAME.test(name)) rmSync(join(stageRoot, name), { recursive: true, force: true });
  }
}

/**
 * Removes downloads and staging folders this module created, by exact name
 * shape, except the zip called `keepZip`. Nothing else in the folder is touched.
 */
export function removePendingDownloads(stageRoot: string, keepZip?: string): void {
  removeStages(stageRoot);
  for (const name of listDir(stageRoot)) {
    if (ZIP_NAME.test(name) && name !== keepZip) {
      rmSync(join(stageRoot, name), { recursive: true, force: true });
    }
  }
}
