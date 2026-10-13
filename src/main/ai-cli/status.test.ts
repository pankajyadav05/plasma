import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AiCliStatus, describeCliStatus } from '@shared/ai-cli';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultResolveDeps } from './resolve';
import {
  CLAUDE_MODELS,
  codexModelsFrom,
  getCliStatus,
  listCliModels,
  parseClaudeAuth,
  parseCodexAccount,
  parseVersion,
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
    ).toEqual({ signedIn: true, plan: 'ChatGPT Plus' });
    expect(parseCodexAccount({ account: { type: 'chatgpt', planType: 'prolite' } }).plan).toBe(
      'ChatGPT Pro',
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

describe('codexModelsFrom', () => {
  it('lists visible models by id', () => {
    const models = codexModelsFrom({
      data: [
        { id: 'a', model: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', isDefault: true },
        { id: 'b', model: 'hidden-one', hidden: true },
        { id: 'gpt-6-luna' },
        { nothing: true },
      ],
    });
    expect(models.map((m) => m.id)).toEqual(['gpt-6.1-sol', 'gpt-6-luna']);
    expect(models[0]).toMatchObject({ vendor: 'openai', name: 'GPT-6.1 Sol' });
    expect(codexModelsFrom(null)).toEqual([]);
  });
  it('Claude offers the three aliases, sonnet first', () => {
    expect(CLAUDE_MODELS.map((m) => m.id)).toEqual(['sonnet', 'opus', 'haiku']);
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
      plan: 'ChatGPT Plus',
      path: fake,
    });
    expect(JSON.stringify(s)).not.toContain('secret@example.com');
    const models = await listCliModels('codex', fake, dir);
    expect(models.models.map((m) => m.id)).toEqual(['gpt-fake-1']);
  });

  it('lists Claude models without starting anything', async () => {
    const r = await listCliModels('claude-code', '', tmpdir());
    expect(r.models.map((m) => m.id)).toEqual(['sonnet', 'opus', 'haiku']);
  });

  it('says so when the Codex list cannot be read', async () => {
    const r = await listCliModels('codex', '/definitely/not/here', tmpdir());
    expect(r.models).toEqual([]);
    expect(r.error).toMatch(/not installed/);
  });
});
