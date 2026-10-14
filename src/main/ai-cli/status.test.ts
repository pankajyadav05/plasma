import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AiCliStatus, describeCliStatus } from '@shared/ai-cli';
import { afterEach, describe, expect, it } from 'vitest';
import { createManifestStore } from './model-manifest';
import { defaultResolveDeps } from './resolve';
import {
  failureReason,
  getCliStatus,
  listAllCodexModelPages,
  listCliModels,
  parseClaudeAuth,
  parseCodexAccount,
  parseVersion,
  versionFromUserAgent,
  waitForModelsCacheRefresh,
} from './status';
import { FAKE_CLI } from './test-util';

describe('parseVersion', () => {
  it('finds the version in each CLI`s --version output', () => {
    expect(parseVersion('codex-cli 0.162.1\n')).toBe('0.162.1');
    expect(parseVersion('2.1.296 (Claude Code)')).toBe('2.1.296');
    expect(parseVersion('garbage')).toBeUndefined();
  });
});

describe('parseClaudeAuth', () => {
  it('reads plan and sign-in, ignoring the e-mail', () => {
    const r = parseClaudeAuth(
      JSON.stringify({
        loggedIn: true,
        authMethod: 'claude.ai',
        email: 'me@example.com',
        subscriptionType: 'max',
      }),
    );
    expect(r).toEqual({ signedIn: true, plan: 'Claude Max' });
    expect(JSON.stringify(r)).not.toContain('example.com');
  });
  it('knows signed out and unreadable output', () => {
    expect(parseClaudeAuth(JSON.stringify({ loggedIn: false }))).toEqual({ signedIn: false });
    expect(parseClaudeAuth('not json')).toEqual({ signedIn: false });
  });
  it('names an API key login without claiming a plan', () => {
    expect(parseClaudeAuth(JSON.stringify({ loggedIn: true, authMethod: 'api_key' }))).toEqual({
      signedIn: true,
      plan: 'API key',
    });
  });
});

describe('parseCodexAccount', () => {
  it('reads a ChatGPT login and maps the plan name', () => {
    expect(
      parseCodexAccount({
        account: { type: 'chatgpt', email: 'me@example.com', planType: 'plus' },
      }),
    ).toEqual({ signedIn: true, plan: 'ChatGPT Plus Subscription' });
    expect(parseCodexAccount({ account: { type: 'chatgpt', planType: 'prolite' } }).plan).toBe(
      'ChatGPT Pro 5x Subscription',
    );
    expect(parseCodexAccount({ account: { type: 'chatgpt', planType: 'weirdnew' } }).plan).toBe(
      'ChatGPT Weirdnew',
    );
  });
  it('knows API key, and signed out', () => {
    expect(parseCodexAccount({ account: { type: 'apiKey' } })).toEqual({
      signedIn: true,
      plan: 'API key',
    });
    expect(parseCodexAccount({ account: null })).toEqual({ signedIn: false });
    expect(parseCodexAccount(null)).toEqual({ signedIn: false });
  });
});

describe('Codex model list plumbing', () => {
  it('pages through model/list with cursor / nextCursor', async () => {
    const asked: unknown[] = [];
    const conn = {
      spawnedAtMs: 0,
      async ask(method: string, params: unknown) {
        asked.push([method, params]);
        const cursor = (params as { cursor?: string }).cursor;
        return {
          result:
            cursor === 'c2'
              ? { data: [{ model: 'b' }] }
              : { data: [{ model: 'a' }], nextCursor: 'c2' },
        };
      },
    };
    const pages = await listAllCodexModelPages(conn);
    expect(pages).toHaveLength(2);
    expect(asked).toEqual([
      ['model/list', {}],
      ['model/list', { cursor: 'c2' }],
    ]);
    expect(
      await listAllCodexModelPages({ ...conn, ask: async () => ({ error: 'nope' }) }),
    ).toBeNull();
  });

  it('waits until models_cache.json is newer than the spawn, else keeps the first answer', async () => {
    let n = 0;
    const read = async () => (++n < 3 ? 100 : 5_000);
    expect(
      await waitForModelsCacheRefresh('/x', 1_000, { pollMs: 1, timeoutMs: 1_000, read }),
    ).toBe(true);
    expect(n).toBe(3);
    expect(
      await waitForModelsCacheRefresh('/x', 1_000, {
        pollMs: 1,
        timeoutMs: 20,
        read: async () => 5,
      }),
    ).toBe(false);
    expect(
      await waitForModelsCacheRefresh('/x', 1_000, {
        pollMs: 1,
        timeoutMs: 20,
        read: async () => Number.NaN,
      }),
    ).toBe(false);
  });
});

describe('Codex account and version, the way T3 reads them', () => {
  it('signed out only for account null with requiresOpenaiAuth true', () => {
    expect(parseCodexAccount({ account: null, requiresOpenaiAuth: true }).signedIn).toBe(false);
    expect(parseCodexAccount({ account: null, requiresOpenaiAuth: false }).signedIn).toBe(true);
    expect(parseCodexAccount({ account: null })).toEqual({ signedIn: false });
  });

  it('takes the version from the userAgent', () => {
    expect(versionFromUserAgent('codex_cli_rs/0.162.1 (Mac OS 15.1; arm64) iTerm')).toBe('0.162.1');
    expect(versionFromUserAgent('Plasma/0.162.1')).toBe('0.162.1');
    expect(versionFromUserAgent('fake')).toBeUndefined();
    expect(versionFromUserAgent(undefined)).toBeUndefined();
  });

  it('words why a program did not answer, redacted', () => {
    const base = { code: null, signal: null, stderrTail: '', timedOut: false };
    expect(failureReason({ ...base, spawnError: 'ENOENT' })).toMatch(/ENOENT/);
    expect(
      failureReason({ ...base, code: 127, stderrTail: 'env: node: No such file or directory\n' }),
    ).toBe('env: node: No such file or directory');
    expect(failureReason({ ...base, code: 2, stderrTail: 'boom Bearer abcdefghijklmnop\n' })).toBe(
      'exited with code 2: boom Bearer [redacted]',
    );
    expect(failureReason({ ...base, timedOut: true })).toBe('no answer in time');
  });
});

describe('describeCliStatus', () => {
  const base = { provider: 'codex' as const };
  it('words each state for the settings row', () => {
    expect(describeCliStatus(null)).toEqual({ tone: 'idle', text: 'Checking...' });
    expect(describeCliStatus({ ...base, installed: false, signedIn: false }).text).toBe(
      'Codex is not installed',
    );
    expect(describeCliStatus({ ...base, installed: true, signedIn: false }).text).toBe(
      'Not signed in: run `codex login` in a terminal',
    );
    expect(
      describeCliStatus({ provider: 'claude-code', installed: true, signedIn: false }).text,
    ).toBe('Not signed in: run `claude` in a terminal');
    expect(
      describeCliStatus({ ...base, installed: true, signedIn: true, plan: 'ChatGPT Plus' }),
    ).toEqual({
      tone: 'ok',
      text: 'Signed in · ChatGPT Plus',
    });
  });
  it('the status shape has no place for an e-mail address', () => {
    const parsed = AiCliStatus.parse({
      provider: 'codex',
      installed: true,
      signedIn: true,
      email: 'me@example.com',
    });
    expect(Object.keys(parsed)).not.toContain('email');
  });
});

const bundledStore = (dir: string) =>
  createManifestStore({
    cachePath: join(dir, 'cache.json'),
    fetchFn: async () => {
      throw new Error('offline');
    },
  });

describe('getCliStatus with fake programs', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('reports a missing program', async () => {
    const s = await getCliStatus('claude-code', '/definitely/not/here', tmpdir());
    expect(s).toMatchObject({ provider: 'claude-code', installed: false, signedIn: false });
    expect(s.error).toMatch(/not found at the path/);
    const none = await getCliStatus('codex', '', tmpdir(), {
      ...defaultResolveDeps(),
      env: { PATH: '' },
      home: '/nonexistent-home',
      loginShellLookup: async () => null,
    });
    expect(none).toMatchObject({ installed: false, error: 'Codex is not installed.' });
  });

  it('asks a fake claude for version and sign-in, and returns no e-mail', async () => {
    dir = mkdtempSync(join(tmpdir(), 'plasma-status-'));
    const fake = join(dir, 'claude');
    writeFileSync(
      fake,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "9.9.9 (Claude Code)"; exit 0; fi
if [ "$1" = "auth" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai","email":"secret@example.com","subscriptionType":"pro"}'; exit 0; fi
`,
    );
    chmodSync(fake, 0o755);
    const s = await getCliStatus('claude-code', fake, dir);
    expect(s).toEqual({
      provider: 'claude-code',
      installed: true,
      version: '9.9.9',
      signedIn: true,
      plan: 'Claude Pro',
      path: fake,
    });
    expect(JSON.stringify(s)).not.toContain('secret@example.com');
  });

  it('asks a fake codex app-server for the account and the models', async () => {
    dir = mkdtempSync(join(tmpdir(), 'plasma-status-'));
    const fake = join(dir, 'codex');
    writeFileSync(
      fake,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 7.7.7"; exit 0; fi
exec "${process.execPath}" "${FAKE_CLI}" codex "$@"
`,
    );
    chmodSync(fake, 0o755);
    const s = await getCliStatus('codex', fake, dir);
    expect(s).toEqual({
      provider: 'codex',
      installed: true,
      version: '7.7.7',
      signedIn: true,
      plan: 'ChatGPT Plus Subscription',
      path: fake,
    });
    expect(JSON.stringify(s)).not.toContain('secret@example.com');
  });

  const fakeCodex = (body: string) => {
    dir = mkdtempSync(join(tmpdir(), 'plasma-status-'));
    const fake = join(dir, 'codex');
    writeFileSync(fake, body);
    chmodSync(fake, 0o755);
    return fake;
  };
  const viaFake = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 7.7.7"; exit 0; fi
exec "${process.execPath}" "${FAKE_CLI}" codex "$@"
`;

  it('Codex: version from the userAgent, no --version needed', async () => {
    const fake = fakeCodex(`#!/bin/sh
exec "${process.execPath}" "${FAKE_CLI}" codex "$@"
`);
    process.env.FAKE_UA = 'codex_cli_rs/0.162.1 (Linux)';
    try {
      const s = await getCliStatus('codex', fake, dir);
      expect(s).toMatchObject({ version: '0.162.1', signedIn: true });
    } finally {
      Reflect.deleteProperty(process.env, 'FAKE_UA');
    }
  });

  it('Codex: account null + requiresOpenaiAuth true is signed out; false is not', async () => {
    const fake = fakeCodex(viaFake);
    process.env.FAKE_MODE = 'signed-out';
    try {
      const out = await getCliStatus('codex', fake, dir);
      expect(out).toMatchObject({ installed: true, signedIn: false });
      expect(out.unreachable).toBeUndefined();
      expect(out.error).toMatch(/codex login/);
      process.env.FAKE_MODE = 'no-auth-needed';
      expect((await getCliStatus('codex', fake, dir)).signedIn).toBe(true);
    } finally {
      Reflect.deleteProperty(process.env, 'FAKE_MODE');
    }
  });

  it('Codex: an account/read error is "did not answer", not "not signed in"', async () => {
    const fake = fakeCodex(viaFake);
    process.env.FAKE_MODE = 'account-error';
    try {
      const s = await getCliStatus('codex', fake, dir);
      expect(s).toMatchObject({
        installed: true,
        signedIn: false,
        unreachable: true,
        version: '7.7.7',
      });
      expect(s.error).toBe('Codex did not answer: account service down');
      expect(describeCliStatus(s).text).toBe('Codex did not answer: account service down');
    } finally {
      Reflect.deleteProperty(process.env, 'FAKE_MODE');
    }
  });

  it('Codex: a program that dies at start says why', async () => {
    const fake = fakeCodex(`#!/bin/sh
echo "env: node: No such file or directory" >&2
exit 127
`);
    const s = await getCliStatus('codex', fake, dir);
    expect(s).toMatchObject({ installed: true, signedIn: false, unreachable: true });
    expect(s.error).toBe('Codex did not answer: env: node: No such file or directory');
  });

  it('Claude: a program that cannot run is not "signed out"', async () => {
    dir = mkdtempSync(join(tmpdir(), 'plasma-status-'));
    const fake = join(dir, 'claude');
    writeFileSync(fake, '#!/bin/sh\necho "env: node: No such file or directory" >&2\nexit 127\n');
    chmodSync(fake, 0o755);
    const s = await getCliStatus('claude-code', fake, dir);
    expect(s).toMatchObject({ signedIn: false, unreachable: true });
    expect(s.error).toBe('Claude Code did not answer: env: node: No such file or directory');
  });

  it('Claude: signed out (exit 1 with the JSON answer) stays "not signed in"', async () => {
    dir = mkdtempSync(join(tmpdir(), 'plasma-status-'));
    const fake = join(dir, 'claude');
    writeFileSync(
      fake,
      `#!/bin/sh
if [ "$1" = "auth" ]; then echo '{"loggedIn":false}'; exit 1; fi
echo "9.9.9"
`,
    );
    chmodSync(fake, 0o755);
    const s = await getCliStatus('claude-code', fake, dir);
    expect(s.signedIn).toBe(false);
    expect(s.unreachable).toBeUndefined();
    expect(s.error).toMatch(/Not signed in/);
  });

  it('lists the Claude models the installed version can run, from the manifest', async () => {
    dir = mkdtempSync(join(tmpdir(), 'plasma-status-'));
    const fake = join(dir, 'claude');
    writeFileSync(fake, '#!/bin/sh\necho "2.1.200 (Claude Code)"\n');
    chmodSync(fake, 0o755);
    const r = await listCliModels('claude-code', fake, dir, undefined, bundledStore(dir));
    expect(r.origin).toEqual({ kind: 'plasma-list', cliVersion: '2.1.200' });
    expect(r.models.map((m) => m.id)).not.toContain('claude-opus-5-5');
    expect(r.updateRequired?.map((m) => m.slug)).toContain('claude-opus-5-5');
  });

  it('lists the Codex models through a fake app-server', async () => {
    const fake = fakeCodex(viaFake);
    const r = await listCliModels('codex', fake, dir, undefined, bundledStore(dir), {
      cacheWaitMs: 20,
    });
    expect(r.models.map((m) => m.id)).toEqual(['gpt-fake-1']);
    expect(r.origin?.kind).toBe('codex');
  });

  it('says so when the Codex list cannot be read', async () => {
    const r = await listCliModels('codex', '/definitely/not/here', tmpdir());
    expect(r.models).toEqual([]);
    expect(r.error).toMatch(/not installed/);
  });
});
