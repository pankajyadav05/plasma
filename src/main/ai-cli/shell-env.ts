import { type ChildProcess, spawn } from 'node:child_process';
import { homedir, userInfo } from 'node:os';

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
  // How the CLIs sign in and reach their service (an API key, Bedrock, Vertex, a gateway, a proxy).
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'CLOUD_ML_REGION',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'OPENAI_API_KEY',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
] as const;

/** Names whose value is a folder that a shell may have written with a leading "~". */
const HOME_RELATIVE_NAMES = new Set(['CODEX_HOME', 'CLAUDE_CONFIG_DIR']);

/** "~" and "~/x" -> the home folder; anything else unchanged. */
export function expandHome(value: string, home: string): string {
  if (value === '~') return home;
  return value.startsWith('~/') ? `${home}${value.slice(1)}` : value;
}

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
  home: string = homedir(),
): Record<string, string> {
  const patch: Record<string, string> = {};
  const path = mergePathEntries(login.PATH, base.PATH ?? base.Path, platform);
  if (path) patch.PATH = path;
  for (const [name, value] of Object.entries(login)) {
    if (name === 'PATH' || base[name]) continue;
    patch[name] = HOME_RELATIVE_NAMES.has(name) ? expandHome(value, home) : value;
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

const POSIX = (platform: NodeJS.Platform) => platform === 'darwin' || platform === 'linux';

/**
 * Runs `file args` the way VS Code reads a shell environment: in its own process group
 * with no stdin (an rc file that prompts cannot hang on a terminal), and on a timeout the
 * whole group is killed, so nothing the rc file started outlives it and the app's own
 * foreground group is never touched.
 */
export function runDetached(
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const killGroup = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      killGroup();
      finish(null);
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString('utf8');
      if (out.length > 256 * 1024) {
        killGroup();
        finish(null);
      }
    });
    child.stderr?.resume();
    child.once('error', () => finish(null));
    child.once('close', (code) => finish(code === 0 ? out : null));
  });
}

function realDeps(): ShellEnvDeps {
  let userShell: string | undefined;
  try {
    userShell = userInfo().shell ?? undefined;
  } catch {
    userShell = undefined;
  }
  return {
    platform: process.platform,
    env: process.env,
    ...(userShell ? { userShell } : {}),
    runShell: (shell, script, timeout) =>
      /^[\w/.+-]+$/.test(shell)
        ? runDetached(shell, ['-ilc', script], timeout)
        : Promise.resolve(null),
    launchctlPath: (timeout) => runDetached('/bin/launchctl', ['getenv', 'PATH'], timeout),
  };
}

/** The merged patch for `deps` and whether the shell (or launchctl) answered with a PATH. Never rejects. */
export async function loadShellEnvChecked(
  deps: ShellEnvDeps,
): Promise<{ patch: Record<string, string>; ok: boolean }> {
  try {
    const login = await probeLoginShellEnv(deps);
    return {
      patch: mergeLoginEnv(deps.env, login, deps.platform),
      ok: !POSIX(deps.platform) || Boolean(login.PATH),
    };
  } catch {
    return { patch: {}, ok: false };
  }
}

/** The merged patch for `deps`; never rejects. */
export async function loadShellEnvPatch(deps: ShellEnvDeps): Promise<Record<string, string>> {
  return (await loadShellEnvChecked(deps)).patch;
}

export const SHELL_ENV_RETRY_MS = 60_000;

/**
 * A loader that reads the login shell once: only a success is kept. After a failure the
 * next call tries again, but not more than once a minute. Calls share one run in flight.
 */
export function createShellEnvLoader(getDeps: () => ShellEnvDeps, now: () => number = Date.now) {
  let patch: Record<string, string> = {};
  let done = false;
  let failedAt: number | null = null;
  let inflight: Promise<void> | null = null;
  return {
    ensure(): Promise<void> {
      if (done) return Promise.resolve();
      if (inflight) return inflight;
      if (failedAt !== null && now() - failedAt < SHELL_ENV_RETRY_MS) return Promise.resolve();
      inflight = loadShellEnvChecked(getDeps())
        .then((r) => {
          patch = r.patch;
          if (r.ok) done = true;
          else failedAt = now();
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
    patch: (): Readonly<Record<string, string>> => patch,
    reset() {
      patch = {};
      done = false;
      failedAt = null;
      inflight = null;
    },
  };
}

const loader = createShellEnvLoader(realDeps);

/** Reads the login shell once (lazily; never at start-up). Never rejects. */
export const ensureShellEnv = (): Promise<void> => loader.ensure();

/** The merged values once `ensureShellEnv` has finished (empty before, or when nothing answered). */
export const shellEnvPatch = (): Readonly<Record<string, string>> => loader.patch();

/** For tests. */
export const resetShellEnvForTests = (): void => loader.reset();
