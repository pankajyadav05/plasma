import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type PreviousExit,
  type RecoveryJournal,
  type RecoveryLaunchInfo,
  type SessionMarker,
  ingestJournal,
  journalHasContent,
  judgePreviousExit,
  mayReloadAfterCrash,
  parseJournal,
} from '@shared/recovery';

/**
 * Crash recovery on the main side (B2). Three small files under userData:
 *
 *   session-marker.json        written at start, removed on a clean quit;
 *                              left behind = the last run did not end cleanly
 *   recovery/journal.json      the live snapshot, rewritten by the renderer
 *   recovery/pending/<hash>    snapshots set aside after a crash, waiting for
 *                              the user's connection to come back; one per
 *                              connection, removed only once restored or discarded
 *
 * Everything is written atomically (temp file, fsync, rename), so a kill in the
 * middle of a write leaves the previous complete file. A journal is moved to
 * `pending` (never copied over live data) the moment a crash is detected, so the
 * new session's own journal can never overwrite what was not yet restored.
 */

export const MARKER_FILE = 'session-marker.json';
const RECOVERY_DIR = 'recovery';
const JOURNAL_FILE = 'journal.json';
const PENDING_DIR = 'pending';

const recoveryDir = (userData: string) => join(userData, RECOVERY_DIR);
const journalPath = (userData: string) => join(recoveryDir(userData), JOURNAL_FILE);
const pendingDir = (userData: string) => join(recoveryDir(userData), PENDING_DIR);
const pendingPath = (userData: string, connectionId: string) =>
  join(
    pendingDir(userData),
    `${createHash('sha256').update(connectionId).digest('hex').slice(0, 32)}.json`,
  );

/** Write `text` to `path` so a reader (or a crash) only ever sees a complete file. */
export function writeFileAtomic(path: string, text: string): void {
  const dir = join(path, '..');
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  // Make the rename itself durable. Not possible on every platform; best effort.
  try {
    const dfd = openSync(dir, 'r');
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    // Windows cannot open a directory for fsync.
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Set a file that cannot be read as a journal aside so it stops being re-read. */
function quarantine(path: string): void {
  try {
    renameSync(path, `${path}.corrupt`);
  } catch {
    // Nothing more to do; the next read ignores it again.
  }
}

// ─── Session marker ──────────────────────────────────────────────────

export interface SessionStart {
  previous: PreviousExit;
}

/**
 * Called once at start-up (after the single-instance lock): reports how the
 * last run ended and writes this run's marker. `updateRestart` is true while a
 * fresh update-restart marker exists.
 */
export function beginSession(
  userData: string,
  info: { version: string; now: number; pid: number; updateRestart: boolean },
): SessionStart {
  const previous = judgePreviousExit(readText(join(userData, MARKER_FILE)), info.updateRestart);
  const marker: SessionMarker = {
    v: 1,
    pid: info.pid,
    startedAt: info.now,
    version: info.version,
  };
  try {
    writeFileAtomic(join(userData, MARKER_FILE), JSON.stringify(marker));
  } catch {
    // Without a marker a crash goes unnoticed; that must not stop the app.
  }
  return { previous };
}

/** A clean quit: nothing to recover, so the marker and the live journal go. */
export function endSession(userData: string): void {
  rmSync(join(userData, MARKER_FILE), { force: true });
  rmSync(journalPath(userData), { force: true });
}

// ─── Journal ─────────────────────────────────────────────────────────

/** Write `text` to `path` atomically without blocking the event loop. `durable` adds the fsyncs. */
export async function writeFileAtomicAsync(
  path: string,
  text: string,
  durable: boolean,
): Promise<void> {
  const dir = join(path, '..');
  await mkdir(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const fh = await open(tmp, 'w', 0o600);
  try {
    await fh.writeFile(text);
    if (durable) await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, path);
  if (durable) {
    try {
      const dfd = await open(dir, 'r');
      try {
        await dfd.sync();
      } finally {
        await dfd.close();
      }
    } catch {
      // Windows cannot open a directory for fsync.
    }
  }
}

/**
 * Keeps the live snapshot current without ever blocking main: writes are async
 * and coalesced (while one is in flight only the newest request is kept), and
 * each file is still replaced atomically. `durable` requests (blur, hide, a
 * flush before a commit) also fsync; the debounced ones skip it, since a
 * process kill cannot lose a completed rename. Anything not storable is left
 * out part by part (`ingestJournal`), never refused whole.
 */
export class JournalWriter {
  private latest: { raw: unknown; durable: boolean; waiters: Array<(ok: boolean) => void> } | null =
    null;
  private running: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly userData: string,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  /** Queue a snapshot (null clears). Resolves once it is on disk (or refused). */
  save(raw: unknown, durable = false): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    return new Promise((resolve) => {
      const waiters = this.latest?.waiters ?? [];
      waiters.push(resolve);
      this.latest = { raw, durable: durable || (this.latest?.durable ?? false), waiters };
      this.running ??= this.drain();
    });
  }

  private async drain(): Promise<void> {
    while (this.latest) {
      const job = this.latest;
      this.latest = null;
      let ok = false;
      try {
        ok = await this.write(job.raw, job.durable);
      } catch (err) {
        this.log(`could not write the recovery snapshot: ${String(err)}`);
      }
      for (const w of job.waiters) w(ok);
    }
    this.running = null;
  }

  private async write(raw: unknown, durable: boolean): Promise<boolean> {
    const path = journalPath(this.userData);
    if (raw === null) {
      await rm(path, { force: true });
      return true;
    }
    const ingested = ingestJournal(raw);
    if (!ingested) {
      this.log('refused a recovery snapshot that is not a journal; the previous one stays');
      return false;
    }
    if (ingested.dropped.length > 0) {
      this.log(`recovery snapshot saved without: ${ingested.dropped.join('; ')}`);
    }
    await writeFileAtomicAsync(path, JSON.stringify(ingested.journal), durable);
    if (this.closed) await rm(path, { force: true });
    return true;
  }

  /** The app is quitting cleanly: nothing may be written (or recreated) after this. */
  close(): void {
    this.closed = true;
    this.latest = null;
  }
}

/** Synchronous variant for tests and one-off use: ingest, then replace the live snapshot. */
export function saveJournal(userData: string, raw: unknown): boolean {
  if (raw === null) {
    rmSync(journalPath(userData), { force: true });
    return true;
  }
  const ingested = ingestJournal(raw);
  if (!ingested) return false;
  try {
    writeFileAtomic(journalPath(userData), JSON.stringify(ingested.journal));
    return true;
  } catch {
    return false;
  }
}

/**
 * A crash was detected: move the live journal into `pending` so the new
 * session's own writes cannot overwrite it. A journal with nothing in it never
 * replaces a pending one for the same connection.
 */
export function stageJournal(userData: string): RecoveryJournal | null {
  const path = journalPath(userData);
  const text = readText(path);
  if (text === null) return null;
  const journal = parseJournal(text);
  if (!journal) {
    quarantine(path);
    return null;
  }
  const target = pendingPath(userData, journal.connectionId);
  const existing = parseJournal(readText(target));
  if (!journalHasContent(journal) && existing && journalHasContent(existing)) {
    rmSync(path, { force: true });
    return existing;
  }
  try {
    writeFileAtomic(target, JSON.stringify(journal));
    rmSync(path, { force: true });
  } catch {
    return journal;
  }
  return journal;
}

/** A snapshot nobody restored or discarded for this long is let go. */
export const PENDING_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Every snapshot waiting to be restored, newest first. Unreadable files are set
 * aside; snapshots older than `PENDING_MAX_AGE_MS` (and restored ones older than a
 * week) are removed.
 */
export function readPending(userData: string, now = Date.now()): RecoveryJournal[] {
  const dir = pendingDir(userData);
  if (!existsSync(dir)) return [];
  const out: RecoveryJournal[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name.endsWith('.restored')) {
      try {
        if (now - statSync(path).mtimeMs > 7 * 24 * 60 * 60 * 1000) rmSync(path, { force: true });
      } catch {
        // gone already
      }
      continue;
    }
    if (!name.endsWith('.json')) continue;
    const journal = parseJournal(readText(path));
    if (!journal) {
      quarantine(path);
      continue;
    }
    if (now - journal.savedAt > PENDING_MAX_AGE_MS) {
      rmSync(path, { force: true });
      continue;
    }
    out.push(journal);
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

/** Remember that a snapshot was announced, so a later launch does not announce it again. */
export function markOffered(userData: string, connectionId: string): void {
  const path = pendingPath(userData, connectionId);
  const journal = parseJournal(readText(path));
  if (!journal || journal.offered) return;
  try {
    writeFileAtomic(path, JSON.stringify({ ...journal, offered: true }));
  } catch {
    // Offered twice is better than not at all.
  }
}

/**
 * Restored or discarded: forget the pending snapshot of one connection (all when
 * omitted). `keepAsRestored` sets it aside instead of deleting it, for the case
 * where the restored state could not be written down yet: it is never restored a
 * second time, but nothing is destroyed.
 */
export function resolvePending(
  userData: string,
  connectionId?: string,
  keepAsRestored = false,
): void {
  if (connectionId === undefined) {
    rmSync(pendingDir(userData), { recursive: true, force: true });
    return;
  }
  const path = pendingPath(userData, connectionId);
  if (keepAsRestored && existsSync(path)) {
    try {
      renameSync(path, `${path.replace(/\.json$/, '')}.restored`);
      return;
    } catch {
      // fall through to delete
    }
  }
  rmSync(path, { force: true });
}

// ─── Runtime ─────────────────────────────────────────────────────────

/**
 * The per-process state around the files above: why a recovery is on offer
 * (`cause`), and how often the window has crashed lately. Plain class, no
 * Electron, so the decisions are testable; `index.ts` only wires it to IPC.
 */
export class RecoveryRuntime {
  /** Set only by a crash: the marker of a run that never ended, or a dead window. */
  cause: 'exit' | 'renderer' | null = null;
  private reloads: number[] = [];
  private readonly writer: JournalWriter;

  constructor(
    private readonly userData: string,
    log: (message: string) => void = () => undefined,
  ) {
    this.writer = new JournalWriter(userData, log);
  }

  /** Start-up: judge the last run, set a crashed run's snapshot aside, write this run's marker. */
  start(info: {
    version: string;
    now: number;
    pid: number;
    updateRestart: boolean;
  }): PreviousExit {
    const { previous } = beginSession(this.userData, info);
    if (previous.kind === 'unclean') {
      stageJournal(this.userData);
      this.cause = 'exit';
    }
    return previous;
  }

  /**
   * The window process died while the app stayed up. Sets its snapshot aside
   * and says whether to reload (not when it keeps crashing).
   */
  rendererGone(now: number): { reload: boolean } {
    stageJournal(this.userData);
    this.cause = 'renderer';
    const gate = mayReloadAfterCrash(this.reloads, now);
    this.reloads = gate.history;
    return { reload: gate.reload };
  }

  /**
   * What the renderer needs to know on load. `unclean` / `cause` come only from a
   * crash. Snapshots left over (not restored, not discarded) are offered once
   * each, whatever the cause, and never mark a launch as a crash.
   */
  launchInfo(hasLog: boolean): RecoveryLaunchInfo {
    const journals = readPending(this.userData);
    const announce = journals
      .filter((j) => this.cause !== null || !j.offered)
      .map((j) => j.connectionId);
    for (const id of announce) markOffered(this.userData, id);
    return { unclean: this.cause !== null, cause: this.cause, journals, announce, hasLog };
  }

  /** One connection's snapshot (or all) was restored or discarded. */
  resolve(connectionId?: string, keepAsRestored = false): void {
    resolvePending(this.userData, connectionId, keepAsRestored);
    if (readPending(this.userData).length === 0) this.cause = null;
  }

  /** Queue the live snapshot (null clears). Never blocks main. */
  save(raw: unknown, durable = false): Promise<boolean> {
    return this.writer.save(raw, durable);
  }

  /** Clean quit (or an update restart that ends this process on purpose). */
  end(): void {
    this.writer.close();
    endSession(this.userData);
  }
}
