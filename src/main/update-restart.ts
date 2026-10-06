import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { compareVersions } from './update-signing';

/**
 * The restart marker. Written just before Plasma quits for an update, read
 * once by the next launch. It carries two things:
 *
 * - what to bring back (the connection that was live, the open workspace),
 *   because this restart was not the user's choice to close and must not
 *   depend on "Restore tabs on launch" / "Connect on launch";
 * - which version the restart was meant to produce, so a launch that is
 *   still on the old version can say "The update could not be installed".
 */

export const RESTART_MARKER_FILE = 'update-restart.json';

export interface RestartMarker {
  v: 1;
  platform: string;
  fromVersion: string;
  expectedVersion: string;
  /** Epoch ms when the restart began. */
  at: number;
  connectionId: string | null;
  workspaceRoot: string | null;
  /** Installer log, when the installer keeps one (macOS helper). */
  logPath: string | null;
}

/** A restart older than this is history, not a failure worth announcing. */
export const MARKER_MAX_AGE_MS = 30 * 60 * 1000;
/** While a marker is this fresh, a second instance waits for the lock instead of quitting. */
export const INSTALL_HANDOVER_MS = 2 * 60 * 1000;

export function markerPath(userDataDir: string): string {
  return join(userDataDir, RESTART_MARKER_FILE);
}

export function writeRestartMarker(userDataDir: string, marker: RestartMarker): void {
  const path = markerPath(userDataDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(marker), { mode: 0o600 });
  renameSync(tmp, path);
}

export function parseRestartMarker(raw: unknown): RestartMarker | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<RestartMarker>;
  if (r.v !== 1) return null;
  if (typeof r.platform !== 'string') return null;
  if (typeof r.fromVersion !== 'string' || typeof r.expectedVersion !== 'string') return null;
  if (typeof r.at !== 'number' || !Number.isFinite(r.at)) return null;
  const str = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length < 4096 ? v : null);
  return {
    v: 1,
    platform: r.platform,
    fromVersion: r.fromVersion,
    expectedVersion: r.expectedVersion,
    at: r.at,
    connectionId: str(r.connectionId),
    workspaceRoot: str(r.workspaceRoot),
    logPath: str(r.logPath),
  };
}

/** The marker, or null when absent or unreadable. Does not remove it. */
export function readRestartMarker(userDataDir: string): RestartMarker | null {
  try {
    return parseRestartMarker(JSON.parse(readFileSync(markerPath(userDataDir), 'utf8')));
  } catch {
    return null;
  }
}

export function clearRestartMarker(userDataDir: string): void {
  rmSync(markerPath(userDataDir), { force: true });
}

export type MarkerVerdict =
  | { outcome: 'none'; resume: boolean }
  | { outcome: 'updated'; resume: true; version: string }
  | { outcome: 'failed'; resume: true; expectedVersion: string };

/**
 * What a launch makes of a marker. `resume` is true whenever the restart was
 * ours (even a failed one: the user's session should still come back, on the
 * old version). A marker older than `MARKER_MAX_AGE_MS`, or from the future,
 * is ignored entirely.
 */
export function evaluateRestartMarker(
  marker: RestartMarker | null,
  runningVersion: string,
  now: number,
): MarkerVerdict {
  if (marker == null) return { outcome: 'none', resume: false };
  const age = now - marker.at;
  if (age < 0 || age > MARKER_MAX_AGE_MS) return { outcome: 'none', resume: false };
  if (compareVersions(runningVersion, marker.expectedVersion) >= 0) {
    return { outcome: 'updated', resume: true, version: runningVersion };
  }
  return { outcome: 'failed', resume: true, expectedVersion: marker.expectedVersion };
}

/** True while a restart for an update is in flight (a new instance may start before the old one is gone). */
export function isInstallHandover(marker: RestartMarker | null, now: number): boolean {
  return marker != null && now - marker.at >= 0 && now - marker.at < INSTALL_HANDOVER_MS;
}

/** Synchronous lookup for the very top of `index.ts`, before the single-instance lock. */
export function installHandoverPending(userDataDir: string, now: number): boolean {
  return (
    existsSync(markerPath(userDataDir)) && isInstallHandover(readRestartMarker(userDataDir), now)
  );
}
