import { describe, expect, it } from 'vitest';
import {
  LOGIN_SHELL_ENV_NAMES,
  type ShellEnvDeps,
  captureCommand,
  listLoginShellCandidates,
  loadShellEnvPatch,
  mergeLoginEnv,
  mergePathEntries,
  parseMarkedEnv,
  probeLoginShellEnv,
} from './shell-env';

const marked = (vars: Record<string, string>, banner = 'Welcome back\n') =>
  `${banner}${Object.entries(vars)
    .map(([k, v]) => `__PLASMA_ENV_${k}_START__\n${v}\n__PLASMA_ENV_${k}_END__\n`)
    .join('')}`;

const deps = (over: Partial<ShellEnvDeps>): ShellEnvDeps => ({
  platform: 'darwin',
  env: { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' },
  runShell: async () => null,
  launchctlPath: async () => null,
  ...over,
});

describe('PATH merge', () => {
  it('puts the login shell first and drops duplicates', () => {
    expect(
      mergePathEntries('/opt/homebrew/bin:/usr/bin', '/usr/bin:/bin:/opt/homebrew/bin', 'darwin'),
    ).toBe('/opt/homebrew/bin:/usr/bin:/bin');
    expect(mergePathEntries(undefined, ' :/a: ', 'linux')).toBe('/a');
    expect(mergePathEntries(undefined, undefined, 'linux')).toBeUndefined();
  });
});

describe('login shell candidates', () => {
  it('$SHELL, the account shell, then the platform default, once each', () => {
    expect(listLoginShellCandidates('darwin', '/bin/zsh', '/bin/zsh')).toEqual(['/bin/zsh']);
    expect(listLoginShellCandidates('darwin', '/usr/local/bin/fish', '/bin/zsh')).toEqual([
      '/usr/local/bin/fish',
      '/bin/zsh',
    ]);
    expect(listLoginShellCandidates('linux', undefined, undefined)).toEqual(['/bin/bash']);
    expect(listLoginShellCandidates('win32', undefined, undefined)).toEqual([]);
  });
});

describe('marked output', () => {
  it('reads values between markers and skips banners and empty values', () => {
    const out = marked({ PATH: '/a:/b', LANG: 'en_US.UTF-8', CODEX_HOME: '' });
    expect(parseMarkedEnv(out, LOGIN_SHELL_ENV_NAMES)).toEqual({
      PATH: '/a:/b',
      LANG: 'en_US.UTF-8',
    });
    expect(captureCommand(['PATH'])).toContain('printenv PATH');
  });

  it('allowlists CODEX_HOME and CLAUDE_CONFIG_DIR next to the T3 names, and nothing secret', () => {
    expect(LOGIN_SHELL_ENV_NAMES).toContain('CODEX_HOME');
    expect(LOGIN_SHELL_ENV_NAMES).toContain('CLAUDE_CONFIG_DIR');
    expect(LOGIN_SHELL_ENV_NAMES).toContain('SSH_AUTH_SOCK');
    expect(LOGIN_SHELL_ENV_NAMES).not.toContain('OPENAI_API_KEY');
    const out = marked({ PATH: '/a', OPENAI_API_KEY: 'sk-secretsecretsecret' });
    expect(parseMarkedEnv(out, LOGIN_SHELL_ENV_NAMES)).toEqual({ PATH: '/a' });
  });
});

describe('merging into the environment', () => {
  it('merges PATH and fills only names that are missing', () => {
    const patch = mergeLoginEnv(
      { PATH: '/usr/bin', LANG: 'C' },
      { PATH: '/opt/n/bin:/usr/bin', LANG: 'en_US.UTF-8', CODEX_HOME: '/h/.codex' },
      'darwin',
    );
    expect(patch).toEqual({ PATH: '/opt/n/bin:/usr/bin', CODEX_HOME: '/h/.codex' });
  });
});

describe('probe', () => {
  it('reads the login shell with the 5 s timeout and merges PATH', async () => {
    const calls: Array<[string, number]> = [];
    const patch = await loadShellEnvPatch(
      deps({
        runShell: async (shell, script, timeout) => {
          calls.push([shell, timeout]);
          expect(script).toContain('printenv CODEX_HOME');
          return marked({ PATH: '/opt/homebrew/bin:/usr/bin', CLAUDE_CONFIG_DIR: '/c' });
        },
      }),
    );
    expect(calls).toEqual([['/bin/zsh', 5000]]);
    expect(patch).toEqual({ PATH: '/opt/homebrew/bin:/usr/bin:/bin', CLAUDE_CONFIG_DIR: '/c' });
  });

  it('tries the next shell when the first gives no PATH, then macOS launchctl (2 s)', async () => {
    const tried: string[] = [];
    let launchctlTimeout = 0;
    const found = await probeLoginShellEnv(
      deps({
        env: { SHELL: '/usr/local/bin/fish' },
        userShell: '/bin/zsh',
        runShell: async (shell) => {
          tried.push(shell);
          return null;
        },
        launchctlPath: async (t) => {
          launchctlTimeout = t;
          return '/opt/homebrew/bin:/usr/bin\n';
        },
      }),
    );
    expect(tried).toEqual(['/usr/local/bin/fish', '/bin/zsh']);
    expect(launchctlTimeout).toBe(2000);
    expect(found).toEqual({ PATH: '/opt/homebrew/bin:/usr/bin' });
  });

  it('a timeout falls back to process.env, and a throw to an empty patch', async () => {
    const patch = await loadShellEnvPatch(deps({}));
    expect(patch).toEqual({ PATH: '/usr/bin:/bin' });
    const boom = await loadShellEnvPatch(
      deps({
        runShell: async () => {
          throw new Error('nope');
        },
      }),
    );
    expect(boom).toEqual({});
  });

  it('does nothing on Windows', async () => {
    expect(await probeLoginShellEnv(deps({ platform: 'win32' }))).toEqual({});
  });
});
