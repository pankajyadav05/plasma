import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  backupAppImage,
  backupPathFor,
  leaveAppImageSymlink,
  pruneAppImageBackups,
  pruneDanglingAppImageLinks,
  restoreAppImage,
} from './linux-appimage';

let dir: string;
let image: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plasma-appimage-'));
  image = join(dir, 'Plasma-3.2.0-x86_64.AppImage');
  writeFileSync(image, 'old build');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('AppImage backup link', () => {
  it('survives the unlink that electron-updater does first, and restores the app', () => {
    const backup = backupAppImage(image, '3.2.0');
    expect(backup).toBe(backupPathFor(image, '3.2.0'));
    unlinkSync(image); // AppImageUpdater.doInstall
    expect(existsSync(image)).toBe(false);

    expect(restoreAppImage(image, '3.2.0')).toBe(true);
    expect(readFileSync(image, 'utf8')).toBe('old build');
  });

  it('does not restore over a file that is there', () => {
    backupAppImage(image, '3.2.0');
    writeFileSync(image, 'new build');
    expect(restoreAppImage(image, '3.2.0')).toBe(false);
    expect(readFileSync(image, 'utf8')).toBe('new build');
  });

  it('reuses an existing backup and reports a missing source without throwing', () => {
    expect(backupAppImage(image, '3.2.0')).not.toBeNull();
    expect(backupAppImage(image, '3.2.0')).not.toBeNull();
    expect(backupAppImage(join(dir, 'missing.AppImage'), '3.2.0')).toBeNull();
    expect(restoreAppImage(join(dir, 'missing.AppImage'), '3.2.0')).toBe(false);
  });
});

describe('pruneAppImageBackups', () => {
  it('removes backups of older versions only, and nothing else in the folder', () => {
    writeFileSync(join(dir, 'Plasma-3.1.0-x86_64.AppImage.plasma-prev-3.1.0'), 'a');
    writeFileSync(join(dir, 'Plasma-3.2.0-x86_64.AppImage.plasma-prev-3.2.0'), 'b');
    writeFileSync(join(dir, 'notes.txt'), 'keep');
    writeFileSync(join(dir, 'Other.AppImage'), 'keep');

    const removed = pruneAppImageBackups(join(dir, 'Plasma-3.2.2-x86_64.AppImage'), '3.2.2');

    expect(removed.sort()).toEqual([
      'Plasma-3.1.0-x86_64.AppImage.plasma-prev-3.1.0',
      'Plasma-3.2.0-x86_64.AppImage.plasma-prev-3.2.0',
    ]);
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true);
    expect(existsSync(join(dir, 'Other.AppImage'))).toBe(true);
  });

  it('keeps the backup that belongs to the running version', () => {
    writeFileSync(join(dir, 'Plasma-3.2.0-x86_64.AppImage.plasma-prev-3.2.0'), 'b');
    expect(pruneAppImageBackups(image, '3.2.0')).toEqual([]);
  });
});

describe('AppImage renamed by the update', () => {
  it('leaves a symlink under the old name that follows to the new file', () => {
    const next = join(dir, 'Plasma-3.2.2-x86_64.AppImage');
    writeFileSync(next, 'new build');
    unlinkSync(image); // electron-updater removed the old name
    expect(leaveAppImageSymlink(image, next)).toBe(true);
    expect(readlinkSync(image)).toBe(next);
    expect(readFileSync(image, 'utf8')).toBe('new build');
  });

  it('never replaces a file that is there, and ignores a same-name install', () => {
    const next = join(dir, 'Plasma-3.2.2-x86_64.AppImage');
    writeFileSync(next, 'new build');
    expect(leaveAppImageSymlink(image, next)).toBe(false);
    expect(readFileSync(image, 'utf8')).toBe('old build');
    expect(leaveAppImageSymlink(next, next)).toBe(false);
  });

  it('prunes dangling AppImage links left by earlier renames, and only those', () => {
    const gone = join(dir, 'Plasma-0.AppImage');
    symlinkSync(join(dir, 'vanished.AppImage'), gone);
    const live = join(dir, 'live.AppImage');
    symlinkSync(image, live);
    writeFileSync(join(dir, 'notes.txt'), 'keep');
    expect(pruneDanglingAppImageLinks(image)).toEqual(['Plasma-0.AppImage']);
    expect(() => lstatSync(gone)).toThrow();
    expect(lstatSync(live).isSymbolicLink()).toBe(true);
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true);
  });
});
