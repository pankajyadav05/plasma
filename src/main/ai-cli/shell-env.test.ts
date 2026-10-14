import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LOGIN_SHELL_ENV_NAMES,
  SHELL_ENV_RETRY_MS,
  type ShellEnvDeps,
  captureCommand,
  createShellEnvLoader,
  expandHome,
  listLoginShellCandidates,
  loadShellEnvPatch,
  mergeLoginEnv,
  mergePathEntries,
  parseMarkedEnv,
  probeLoginShellEnv,
  runDetached,
} from './shell-env';
import { alive, waitDead } from './test-util';

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
    for (const n of [
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
    ]) {
      expect(LOGIN_SHELL_ENV_NAMES).toContain(n);
    }
    // Only listed names are read, whatever else the shell prints.
    const out = marked({ PATH: '/a', GITHUB_TOKEN: 'ghp_secretsecret' });
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

describe('home folders', () => {
  it('expands a leading ~ in CODEX_HOME and CLAUDE_CONFIG_DIR only', () => {
    expect(expandHome('~/.codex', '/home/u')).toBe('/home/u/.codex');
    expect(expandHome('~', '/home/u')).toBe('/home/u');
    expect(expandHome('/x/~y', '/home/u')).toBe('/x/~y');
    expect(expandHome('~other/x', '/home/u')).toBe('~other/x');
    const patch = mergeLoginEnv(
      {},
      { CODEX_HOME: '~/.codex-alt', CLAUDE_CONFIG_DIR: '~/c', SSL_CERT_FILE: '~/ca.pem' },
      'linux',
      '/home/u',
    );
    expect(patch).toEqual({
      CODEX_HOME: '/home/u/.codex-alt',
      CLAUDE_CONFIG_DIR: '/home/u/c',
      SSL_CERT_FILE: '~/ca.pem',
    });
  });
});

describe('the loader keeps only a success', () => {
  it('a success is read once; a failure is retried at most once a minute', async () => {
    let calls = 0;
    let t = 0;
    let answer: string | null = null;
    const loader = createShellEnvLoader(
      () => ({
        platform: 'linux',
        env: { PATH: '/usr/bin' },
        runShell: async () => {
          calls++;
          return answer;
        },
        launchctlPath: async () => null,
      }),
      () => t,
    );
    await loader.ensure();
    expect(calls).toBe(1);
    await loader.ensure();
    t += SHELL_ENV_RETRY_MS - 1;
    await loader.ensure();
    expect(calls).toBe(1);
    t += 2;
    answer = marked({ PATH: '/opt/n/bin' });
    await loader.ensure();
    expect(calls).toBe(2);
    expect(loader.patch().PATH).toBe('/opt/n/bin:/usr/bin');
    await loader.ensure();
    await loader.ensure();
    expect(calls).toBe(2);
  });
});

describe('runDetached', () => {
  it('returns the output of a normal run', async () => {
    expect(await runDetached('/bin/sh', ['-c', 'echo hi'], 5_000)).toBe('hi\n');
    expect(await runDetached('/bin/sh', ['-c', 'exit 3'], 5_000)).toBeNull();
    expect(await runDetached('/definitely/not/here', [], 5_000)).toBeNull();
  });

  it('kills the whole process group on a timeout, including what the shell started', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plasma-detach-'));
    const pidFile = join(dir, 'pid');
    try {
      const started = Date.now();
      const out = await runDetached(
        '/bin/sh',
        ['-c', `sleep 30 & echo $! > '${pidFile}'; wait`],
        400,
      );
      expect(out).toBeNull();
      expect(Date.now() - started).toBeLessThan(5_000);
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      expect(pid).toBeGreaterThan(0);
      await waitDead(pid, 3_000);
      expect(alive(pid)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
