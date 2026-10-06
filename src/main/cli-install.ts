import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';

/**
 * Settings → "Install command-line tool". Pure planning + filesystem steps;
 * the native confirmation lives in index.ts.
 */

export interface InstallTarget {
  dir: string;
  /** Needs elevated rights most of the time. */
  system: boolean;
}

export function installTargets(home: string): InstallTarget[] {
  return [
    { dir: join(home, '.local', 'bin'), system: false },
    { dir: '/usr/local/bin', system: true },
  ];
}

export function dirOnPath(dir: string, pathEnv: string | undefined): boolean {
  return (pathEnv ?? '').split(delimiter).some((p) => p === dir);
}

export function windowsInstructions(scriptPath: string): string {
  const dir = scriptPath.replace(/[\\/][^\\/]*$/, '');
  return [
    'Add the launcher folder to your PATH, then open a new terminal:',
    `  setx PATH "%PATH%;${dir}"`,
    'Then run:  plasma open <connection-url | file.sqlite | folder>',
  ].join('\n');
}

export const APPIMAGE_MARKER = 'PLASMA_APP="${PLASMA_APP:-}"';

/** Where `link` points, or null when it is not a symlink (or absent). */
export function linkTarget(link: string): string | null {
  try {
    return lstatSync(link).isSymbolicLink() ? readlinkSync(link) : null;
  } catch {
    return null;
  }
}

export interface InstallResult {
  installedAt: string;
  onPath: boolean;
  kind: 'symlink' | 'wrapper';
}

/**
 * Put the launcher at `<dir>/plasma`. A normal install is a symlink to the
 * script inside the app. An AppImage mounts read-only and disappears with the
 * process, so there the script is copied with `PLASMA_APP` pointing at the
 * AppImage file instead.
 */
export function installLauncher(opts: {
  script: string;
  dir: string;
  appImage?: string | null;
  pathEnv?: string;
}): InstallResult {
  const { script, dir, appImage, pathEnv } = opts;
  if (!existsSync(script)) throw new Error('The launcher script is not part of this build');
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, 'plasma');
  // Replace only our own previous install; never clobber an unrelated `plasma`.
  if (existsSync(dest) || linkTarget(dest) !== null) {
    const asLink = linkTarget(dest);
    const ours =
      asLink !== null
        ? /[\\/]bin[\\/]plasma$/.test(asLink)
        : readFileSync(dest, 'utf8').includes('command-line companion for the Plasma');
    if (!ours) throw new Error(`${dest} already exists and is not the Plasma launcher`);
    rmSync(dest, { force: true });
  }
  if (appImage) {
    const text = readFileSync(script, 'utf8');
    if (!text.includes(APPIMAGE_MARKER)) throw new Error('The launcher script is unexpected');
    const quoted = appImage.replace(/(["\\$`])/g, '\\$1');
    writeFileSync(dest, text.replace(APPIMAGE_MARKER, `PLASMA_APP="${quoted}"`), { mode: 0o755 });
    return { installedAt: dest, onPath: dirOnPath(dir, pathEnv), kind: 'wrapper' };
  }
  symlinkSync(script, dest);
  return { installedAt: dest, onPath: dirOnPath(dir, pathEnv), kind: 'symlink' };
}

const quoteForWrapper = (p: string) => p.replace(/(["\\$`])/g, '\\$1');

/**
 * After an AppImage update renamed the file, point the installed `plasma`
 * wrapper (written by `installLauncher`) at the new one. Only wrappers that
 * are ours and name `oldAppImage` are rewritten; returns the paths changed.
 */
export function repointAppImageWrappers(
  dirs: readonly string[],
  oldAppImage: string,
  newAppImage: string,
): string[] {
  const changed: string[] = [];
  const from = `PLASMA_APP="${quoteForWrapper(oldAppImage)}"`;
  const to = `PLASMA_APP="${quoteForWrapper(newAppImage)}"`;
  for (const dir of dirs) {
    const dest = join(dir, 'plasma');
    try {
      if (linkTarget(dest) !== null || !lstatSync(dest).isFile()) continue;
      const text = readFileSync(dest, 'utf8');
      if (!text.includes('command-line companion for the Plasma') || !text.includes(from)) continue;
      writeFileSync(dest, text.replace(from, to), { mode: 0o755 });
      changed.push(dest);
    } catch {
      // not installed there, or not writable (system folder): nothing to do
    }
  }
  return changed;
}
