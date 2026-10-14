import { execFile } from 'node:child_process';
import { userInfo } from 'node:os';

/**
 * The login shell's environment, the way T3 Code reads it (MIT, Copyright (c) 2026
 * T3 Tools Inc.: apps/desktop/src/shell/DesktopShellEnvironment.ts and
 * packages/shared/src/shell.ts). An app opened from the Dock / launcher does not
 * get the PATH of the user's terminal, so an npm `codex` (a `#!/usr/bin/env node`
 * script) cannot find node. The login shell is asked once, lazily, and the answer
 * is cached; the values are never logged.
 */

/** PATH plus the few variables the CLIs and their runtimes read. */
export const LOGIN_SHELL_ENV_NAMES = [
  'PATH',
  'DBUS_SESSION_BUS_ADDRESS',
  'DISPLAY',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'SSH_AUTH_SOCK',
  'HOMEBREW_PREFIX',
  'HOMEBREW_CELLAR',
  'HOMEBREW_REPOSITORY',
  'XDG_CONFIG_HOME',
  'XDG_CURRENT_DESKTOP',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR',
  'XDG_SESSION_DESKTOP',
  'XDG_SESSION_TYPE',
  'WAYLAND_DISPLAY',
  // Where the CLIs keep their sign-in, when the user moved it.
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
] as const;

export const LOGIN_SHELL_TIMEOUT_MS = 5_000;
export const LAUNCHCTL_TIMEOUT_MS = 2_000;

const startMarker = (name: string) => `__PLASMA_ENV_${name}_START__`;
const endMarker = (name: string) => `__PLASMA_ENV_${name}_END__`;

const clean = (v: string | null | undefined) => v?.trim() || undefined;

/** The shell to ask, most specific first: $SHELL, the account's shell, then a platform default. */
export function listLoginShellCandidates(
  platform: NodeJS.Platform,
  shell: string | undefined,
  userShell?: string,
): string[] {
  const fallback =
    platform === 'darwin' ? '/bin/zsh' : platform === 'linux' ? '/bin/bash' : undefined;
  const out: string[] = [];
  for (const c of [clean(shell), clean(userShell), fallback]) {
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

/** `preferred` entries first, then `inherited`, each folder once. */
export function mergePathEntries(
  preferred: string | undefined,
  inherited: string | undefined,
  platform: NodeJS.Platform,
): string | undefined {
  const sep = platform === 'win32' ? ';' : ':';
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of [preferred, inherited]) {
    if (!value) continue;
    for (const raw of value.split(sep)) {
      const entry = raw.trim();
      if (!entry || seen.has(entry)) continue;
      seen.add(entry);
      out.push(entry);
    }
  }
  return out.length > 0 ? out.join(sep) : undefined;
}

/** The shell command: print every wanted variable between markers (banners and rc noise are skipped). */
export function captureCommand(names: readonly string[]): string {
  return names
    .map(
      (n) =>
        `printf '%s\\n' '${startMarker(n)}'; printenv ${n} || true; printf '%s\\n' '${endMarker(n)}'`,
    )
    .join('; ');
}

/** Values between the markers; a name without a value is left out. */
export function parseMarkedEnv(stdout: string, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const s = stdout.indexOf(startMarker(name));
    if (s < 0) continue;
    const from = s + startMarker(name).length;
    const e = stdout.indexOf(endMarker(name), from);
    if (e < 0) continue;
    const value = stdout.slice(from, e).trim();
    if (value) out[name] = value;
  }
  return out;
}

/**
 * `base` with the login shell's values: PATH merged (login entries first, deduped),
 * every other name only filled in when `base` does not have it.
 */
export function mergeLoginEnv(
  base: NodeJS.ProcessEnv,
  login: Readonly<Record<string, string>>,
  platform: NodeJS.Platform,
): Record<string, string> {
  const patch: Record<string, string> = {};
  const path = mergePathEntries(login.PATH, base.PATH ?? base.Path, platform);
  if (path) patch.PATH = path;
  for (const [name, value] of Object.entries(login)) {
    if (name === 'PATH' || base[name]) continue;
    patch[name] = value;
  }
  return patch;
}

export interface ShellEnvDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  userShell?: string;
  /** Runs `shell -ilc script`; null when it failed or timed out. */
  runShell(shell: string, script: string, timeoutMs: number): Promise<string | null>;
  /** `launchctl getenv PATH`; null when it failed. */
  launchctlPath(timeoutMs: number): Promise<string | null>;
}

/** What the login shell (or, on macOS, launchctl) knows. Empty on Windows or when nothing answers. */
export async function probeLoginShellEnv(deps: ShellEnvDeps): Promise<Record<string, string>> {
  if (deps.platform !== 'darwin' && deps.platform !== 'linux') return {};
  let found: Record<string, string> = {};
  for (const shell of listLoginShellCandidates(deps.platform, deps.env.SHELL, deps.userShell)) {
    const out = await deps.runShell(
      shell,
      captureCommand(LOGIN_SHELL_ENV_NAMES),
      LOGIN_SHELL_TIMEOUT_MS,
    );
    if (out) found = { ...found, ...parseMarkedEnv(out, LOGIN_SHELL_ENV_NAMES) };
    if (found.PATH) break;
  }
  if (!found.PATH && deps.platform === 'darwin') {
    const p = clean(await deps.launchctlPath(LAUNCHCTL_TIMEOUT_MS));
    if (p) found.PATH = p;
  }
  return found;
}

function realDeps(): ShellEnvDeps {
  let userShell: string | undefined;
  try {
    userShell = userInfo().shell ?? undefined;
  } catch {
    userShell = undefined;
  }
  const run = (file: string, args: string[], timeout: number) =>
    new Promise<string | null>((resolve) => {
      execFile(
        file,
        args,
        { timeout, windowsHide: true, maxBuffer: 256 * 1024, killSignal: 'SIGKILL' },
        (err, stdout) => resolve(err ? null : String(stdout)),
      );
    });
  return {
    platform: process.platform,
    env: process.env,
    ...(userShell ? { userShell } : {}),
    runShell: (shell, script, timeout) =>
      /^[\w/.+-]+$/.test(shell) ? run(shell, ['-ilc', script], timeout) : Promise.resolve(null),
    launchctlPath: (timeout) => run('/bin/launchctl', ['getenv', 'PATH'], timeout),
  };
}

let cached: Promise<Record<string, string>> | null = null;
let patch: Record<string, string> = {};

/** The merged patch for `deps`; never rejects. */
export function loadShellEnvPatch(deps: ShellEnvDeps): Promise<Record<string, string>> {
  return probeLoginShellEnv(deps)
    .then((login) => mergeLoginEnv(deps.env, login, deps.platform))
    .catch(() => ({}) as Record<string, string>);
}

/** Reads the login shell once; later calls share the answer. Never rejects, never blocks start-up (call it when a CLI is first needed). */
export function ensureShellEnv(): Promise<void> {
  cached ??= loadShellEnvPatch(realDeps()).then((v) => {
    patch = v;
    return v;
  });
  return cached.then(() => undefined);
}

/** The merged values once `ensureShellEnv` has finished (empty before, or when nothing answered). */
export function shellEnvPatch(): Readonly<Record<string, string>> {
  return patch;
}

/** For tests. */
export function resetShellEnvForTests(): void {
  cached = null;
  patch = {};
}
