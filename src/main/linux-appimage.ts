import { existsSync, linkSync, lstatSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Safety net for electron-updater's AppImage swap.
 *
 * `AppImageUpdater.doInstall` first `unlink`s the running AppImage and only
 * then `mv`s the downloaded file into place. If that move fails (cache on
 * another disk that fills up, a permission change, a crash) the user is left
 * without Plasma. So before any install we hard-link the current AppImage to
 * `<name>.plasma-prev-<version>`: it costs no disk space, survives the
 * `unlink`, and `restoreAppImage` puts it back when the install errors out.
 * The next launch on a newer version removes the stale link.
 */

const SUFFIX = '.plasma-prev-';

export function backupPathFor(appImage: string, version: string): string {
  return `${appImage}${SUFFIX}${version}`;
}

/** Creates the backup link. Returns its path, or null when it could not be made. */
export function backupAppImage(appImage: string, version: string): string | null {
  const backup = backupPathFor(appImage, version);
  try {
    if (existsSync(backup)) return backup;
    linkSync(appImage, backup);
    return backup;
  } catch {
    return null; // FUSE / FAT / read-only folder: no safety net, install goes on as before
  }
}

/** Puts the backup back as `appImage` when the install left nothing there. */
export function restoreAppImage(appImage: string, version: string): boolean {
  const backup = backupPathFor(appImage, version);
  try {
    if (existsSync(appImage) || !existsSync(backup)) return false;
    linkSync(backup, appImage);
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes backups left next to `appImage` by earlier updates. Only files named
 * `<something>.AppImage.plasma-prev-<version>` are candidates, and the one for
 * the running version is kept.
 */
export function pruneAppImageBackups(appImage: string, runningVersion: string): string[] {
  const dir = dirname(appImage);
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return removed;
  }
  for (const name of names) {
    const m = /^.+\.AppImage\.plasma-prev-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(name);
    if (!m || m[1] === runningVersion || name === basename(appImage)) continue;
    try {
      rmSync(join(dir, name), { force: true });
      removed.push(name);
    } catch {
      // leave it; harmless
    }
  }
  return removed;
}

/**
 * electron-updater names the new AppImage after the download
 * (`Plasma-3.2.2-x86_64.AppImage`) and deletes the old name, so every
 * shortcut, pinned dock icon or `.desktop` entry that pointed at the old file
 * would be dead. Leave a symlink under the old name that points at the new
 * file. Returns true when the link was made.
 */
export function leaveAppImageSymlink(oldPath: string, newPath: string): boolean {
  if (oldPath === newPath) return false;
  try {
    try {
      lstatSync(oldPath);
      return false; // something is there again (the install kept the name): never replace it
    } catch {
      // absent, as expected
    }
    symlinkSync(newPath, oldPath);
    return true;
  } catch {
    return false;
  }
}

/** Removes dangling `*.AppImage` symlinks (left by earlier renames) next to `appImage`. */
export function pruneDanglingAppImageLinks(appImage: string): string[] {
  const dir = dirname(appImage);
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!name.endsWith('.AppImage')) continue;
    const full = join(dir, name);
    try {
      if (lstatSync(full).isSymbolicLink() && !existsSync(full)) {
        rmSync(full, { force: true });
        removed.push(name);
      }
    } catch {
      // leave it
    }
  }
  return removed;
}
