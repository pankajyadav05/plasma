import { execFile } from 'node:child_process';
import { constants, accessSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { cliBasenameOk } from '@shared/ai-cli';

/**
 * Where is the `codex` / `claude` program? A GUI app does not inherit the shell
 * PATH (macOS especially), so after PATH the user's login shell is asked, then
 * the usual install folders are tried. A path the user typed in Settings wins.
 */

export type CliName = 'codex' | 'claude';

export interface ResolveDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  /** True when `path` is a file we may run. */
  isExecutable(path: string): boolean;
  /** `$SHELL -ilc 'command -v name'` (null when it fails or times out). */
  loginShellLookup(name: string): Promise<string | null>;
}

export type Resolved = {
  path: string;
  source: 'override' | 'path' | 'login-shell' | 'common';
};

export function isExecutableFile(path: string, platform: NodeJS.Platform = process.platform) {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform === 'win32') return true;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function loginShellLookup(name: string, shell: string | undefined): Promise<string | null> {
  if (!shell || !/^[\w/.+-]+$/.test(shell)) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', `command -v ${name}`],
      { timeout: 4_000, windowsHide: true, maxBuffer: 64 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        // An interactive shell may print a banner first: the answer is the last absolute path.
        const lines = String(stdout)
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.startsWith('/'));
        resolve(lines.at(-1) ?? null);
      },
    );
  });
}

export function defaultResolveDeps(): ResolveDeps {
  return {
    platform: process.platform,
    env: process.env,
    home: homedir(),
    isExecutable: (p) => isExecutableFile(p),
    loginShellLookup: (name) => loginShellLookup(name, process.env.SHELL),
  };
}

function candidateNames(name: CliName, deps: ResolveDeps): string[] {
  if (deps.platform !== 'win32') return [name];
  return [`${name}.exe`, `${name}.cmd`, `${name}.bat`];
}

/** Folders a user commonly installs the CLIs into, besides PATH. */
export function commonDirs(deps: Pick<ResolveDeps, 'platform' | 'env' | 'home'>): string[] {
  if (deps.platform === 'win32') {
    const appData = deps.env.APPDATA ?? join(deps.home, 'AppData', 'Roaming');
    return [
      join(appData, 'npm'),
      join(deps.home, '.local', 'bin'),
      join(deps.home, '.claude', 'local'),
    ];
  }
  return [
    join(deps.home, '.local', 'bin'),
    join(deps.home, '.claude', 'local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(deps.home, '.npm-global', 'bin'),
    join(deps.home, '.bun', 'bin'),
  ];
}

export async function resolveBinary(
  name: CliName,
  override: string | undefined,
  deps: ResolveDeps = defaultResolveDeps(),
): Promise<Resolved | null> {
  const typed = override?.trim();
  if (typed) {
    // Whatever the stored path says, only a file called codex / claude runs.
    if (!cliBasenameOk(name === 'codex' ? 'codex' : 'claude-code', typed)) return null;
    return deps.isExecutable(typed) ? { path: typed, source: 'override' } : null;
  }
  const names = candidateNames(name, deps);
  const pathVar = deps.env.PATH ?? deps.env.Path ?? '';
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const p = join(dir, n);
      if (deps.isExecutable(p)) return { path: p, source: 'path' };
    }
  }
  if (deps.platform !== 'win32') {
    const found = await deps.loginShellLookup(name);
    if (found && deps.isExecutable(found)) return { path: found, source: 'login-shell' };
  }
  for (const dir of commonDirs(deps)) {
    for (const n of names) {
      const p = join(dir, n);
      if (deps.isExecutable(p)) return { path: p, source: 'common' };
    }
  }
  return null;
}

/**
 * How to start `file` with `args` without a shell. A Windows `.cmd` shim (what
 * npm installs) cannot be started directly: its target script or program is read
 * from the shim and started instead.
 */
export function launchSpec(
  file: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  readText: (p: string) => string = (p) => readFileSync(p, 'utf8'),
): { command: string; args: string[] } {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(file)) return { command: file, args };
  try {
    const text = readText(file);
    const dir = file.replace(/[\\/][^\\/]*$/, '');
    const m = /"%(?:~dp0|dp0%)\\?([^"%]+?\.(?:js|mjs|cjs|exe))"/i.exec(text);
    if (m?.[1]) {
      const target = `${dir}\\${m[1].replace(/^\\+/, '')}`;
      return /\.exe$/i.test(target)
        ? { command: target, args }
        : { command: 'node', args: [target, ...args] };
    }
  } catch {
    /* fall through */
  }
  return { command: file, args };
}
