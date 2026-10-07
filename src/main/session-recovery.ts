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
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  MAX_JOURNAL_BYTES,
  type PreviousExit,
  type RecoveryJournal,
  type RecoveryLaunchInfo,
  type SessionMarker,
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

/**
 * Store the renderer's snapshot. Anything that is not a valid journal, or is
 * too large, is refused and leaves the previous snapshot in place (a bad write
 * must never replace a good journal). `null` clears the live journal.
 */
export function saveJournal(userData: string, raw: unknown): boolean {
  if (raw === null) {
    rmSync(journalPath(userData), { force: true });
    return true;
  }
  const journal = parseJournal(raw);
  if (!journal) return false;
  const text = JSON.stringify(journal);
  if (Buffer.byteLength(text) > MAX_JOURNAL_BYTES) return false;
  try {
    writeFileAtomic(journalPath(userData), text);
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

/** Every snapshot waiting to be restored, newest first. Unreadable files are set aside. */
export function readPending(userData: string): RecoveryJournal[] {
  const dir = pendingDir(userData);
  if (!existsSync(dir)) return [];
  const out: RecoveryJournal[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    const journal = parseJournal(readText(path));
    if (journal) out.push(journal);
    else quarantine(path);
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

/** Restored or discarded: forget the pending snapshot of one connection (all when omitted). */
export function resolvePending(userData: string, connectionId?: string): void {
  if (connectionId === undefined) {
    rmSync(pendingDir(userData), { recursive: true, force: true });
    return;
  }
  rmSync(pendingPath(userData, connectionId), { force: true });
}

// ─── Runtime ─────────────────────────────────────────────────────────

/**
 * The per-process state around the files above: why a recovery is on offer
 * (`cause`), and how often the window has crashed lately. Plain class, no
 * Electron, so the decisions are testable; `index.ts` only wires it to IPC.
 */
export class RecoveryRuntime {
  /** Why the renderer should offer a restore; cleared once nothing is pending. */
  cause: 'exit' | 'renderer' | null = null;
  private reloads: number[] = [];

  constructor(private readonly userData: string) {}

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

  /** What the renderer needs to know on load. */
  launchInfo(hasLog: boolean): RecoveryLaunchInfo {
    const journals = readPending(this.userData);
    // A snapshot left behind by a clean quit that never restored it is still offered.
    const cause = this.cause ?? (journals.length > 0 ? 'exit' : null);
    return { unclean: cause !== null, cause, journals, hasLog };
  }

  /** One connection's snapshot (or all) was restored or discarded. */
  resolve(connectionId?: string): void {
    resolvePending(this.userData, connectionId);
    if (readPending(this.userData).length === 0) this.cause = null;
  }

  save(raw: unknown): boolean {
    return saveJournal(this.userData, raw);
  }

  /** Clean quit (or an update restart that ends this process on purpose). */
  end(): void {
    endSession(this.userData);
  }
}
