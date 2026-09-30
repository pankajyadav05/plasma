import { type Settings, SettingsShape } from '@shared/protocol';
import { describe, expect, it } from 'vitest';
import { planSecretsMigration, redactSettingsWithPresence } from './vault-secrets-plan';

/**
 * Pure U07 helpers live in vault-secrets-plan.ts so tests do not load
 * Electron / better-sqlite3 native bindings (those are Electron-abi).
 */

describe('planSecretsMigration (U07)', () => {
  it('moves API keys and SSH secrets out of settings into a secret map', () => {
    const planned = planSecretsMigration({
      theme: 'dark',
      openrouterApiKey: 'sk-or-test-key',
      claudeApiKey: 'legacy-key',
      connectionSsh: {
        'conn-1': {
          host: 'bastion.example.com',
          port: 22,
          user: 'ubuntu',
          password: 'ssh-pass',
          privateKey: '-----BEGIN KEY-----\nabc\n-----END KEY-----',
          passphrase: 'key-pass',
        },
      },
    });

    expect(planned.secrets).toEqual({
      'setting:openrouterApiKey': 'sk-or-test-key',
      'setting:claudeApiKey': 'legacy-key',
      'ssh:conn-1:password': 'ssh-pass',
      'ssh:conn-1:privateKey': '-----BEGIN KEY-----\nabc\n-----END KEY-----',
      'ssh:conn-1:passphrase': 'key-pass',
    });
    expect(planned.settings.openrouterApiKey).toBe('');
    expect(planned.settings.claudeApiKey).toBe('');
    expect(planned.settings.theme).toBe('dark');
    expect(planned.settings.connectionSsh).toEqual({
      'conn-1': { host: 'bastion.example.com', port: 22, user: 'ubuntu' },
    });
    const ssh = planned.settings.connectionSsh as Record<string, Record<string, unknown>>;
    expect(ssh['conn-1'].password).toBeUndefined();
    expect(ssh['conn-1'].privateKey).toBeUndefined();
    expect(ssh['conn-1'].passphrase).toBeUndefined();
  });

  it('is a no-op for already-scrubbed settings', () => {
    const planned = planSecretsMigration({
      openrouterApiKey: '',
      claudeApiKey: '',
      connectionSsh: {
        'conn-1': { host: 'bastion', port: 22, user: 'ubuntu' },
      },
    });
    expect(planned.secrets).toEqual({});
    expect(planned.settings.connectionSsh).toEqual({
      'conn-1': { host: 'bastion', port: 22, user: 'ubuntu' },
    });
  });
});

describe('redactSettingsWithPresence (U07)', () => {
  const base: Settings = {
    ...SettingsShape.parse({}),
    theme: 'light',
    themeName: 'default',
    fontSans: 'theme',
    fontMono: 'theme',
    sidebarCollapsed: false,
    sidebarWidth: 264,
    rightSidebarWidth: 300,
    editorExpanded: false,
    editorFontSize: 14,
    editorHeightPx: 280,
    defaultPageSize: 50,
    queryTimeoutMs: 0,
    telemetryEnabled: false,
    openrouterApiKey: 'SHOULD_NOT_LEAK',
    openrouterModel: 'anthropic/claude-sonnet-4.5',
    claudeApiKey: 'SHOULD_NOT_LEAK',
    transactionMode: false,
    autoConnectOnLaunch: true,
    autoReconnect: true,
    lastConnectionId: null,
    connectionTags: {},
    connectionSsh: {
      'conn-1': {
        host: 'bastion',
        port: 22,
        user: 'ubuntu',
        password: 'SHOULD_NOT_LEAK',
        privateKey: 'SHOULD_NOT_LEAK',
        passphrase: 'SHOULD_NOT_LEAK',
        privateKeyPath: '/home/u/.ssh/id_ed25519',
        useAgent: true,
      },
    },
    schemaSnapshots: [],
    favoriteSchemas: {},
    favoriteTables: {},
    tableColumnState: {},
    savedQueries: {},
    windowBounds: null,
  };

  it('never returns secret plaintext and sets presence flags', () => {
    const present = new Set([
      'setting:openrouterApiKey',
      'ssh:conn-1:password',
      'ssh:conn-1:passphrase',
    ]);
    const redacted = redactSettingsWithPresence(base, (k) => present.has(k));

    expect(redacted.openrouterApiKey).toBe('');
    expect(redacted.claudeApiKey).toBe('');
    expect(redacted.hasOpenrouterApiKey).toBe(true);
    expect(redacted.hasClaudeApiKey).toBe(false);
    expect(redacted.connectionSsh['conn-1']).toMatchObject({
      host: 'bastion',
      port: 22,
      user: 'ubuntu',
      password: '',
      privateKey: '',
      passphrase: '',
      hasPassword: true,
      hasPrivateKey: false,
      hasPassphrase: true,
      privateKeyPath: '/home/u/.ssh/id_ed25519',
      useAgent: true,
    });
  });
});

describe('C3/C17/C27 vault helpers', () => {
  it('hasPlaintextSecrets detects lingering keys and SSH secrets', async () => {
    const { hasPlaintextSecrets } = await import('./vault-secrets-plan');
    expect(hasPlaintextSecrets({ openrouterApiKey: 'sk-or-1' })).toBe(true);
    expect(
      hasPlaintextSecrets({
        connectionSsh: { a: { host: 'h', user: 'u', port: 22, privateKey: 'k' } },
      }),
    ).toBe(true);
    expect(
      hasPlaintextSecrets({
        openrouterApiKey: '',
        connectionSsh: { a: { host: 'h', user: 'u', port: 22 } },
      }),
    ).toBe(false);
  });

  it('isWeakSecretBackend flags Linux basic_text only', async () => {
    const { isWeakSecretBackend } = await import('./vault-secrets-plan');
    expect(isWeakSecretBackend('linux', 'basic_text')).toBe(true);
    expect(isWeakSecretBackend('linux', 'gnome_libsecret')).toBe(false);
    expect(isWeakSecretBackend('darwin', null)).toBe(false);
  });

  it('canReuseStoredPassword requires the same server and login', async () => {
    const { canReuseStoredPassword } = await import('./vault-secrets-plan');
    const saved = { id: 'c', engine: 'postgres', host: 'db', port: 5432, user: 'app' };
    expect(canReuseStoredPassword(saved, { ...saved })).toBe(true);
    expect(canReuseStoredPassword(saved, { ...saved, host: 'evil' })).toBe(false);
    expect(canReuseStoredPassword(saved, { ...saved, port: 6543 })).toBe(false);
    expect(canReuseStoredPassword(saved, { ...saved, user: 'root' })).toBe(false);
    expect(canReuseStoredPassword(saved, { ...saved, id: 'other' })).toBe(false);
  });

  it('mergeSshSecretsForTest reuses saved SSH secrets only for the same bastion + login', async () => {
    const { mergeSshSecretsForTest } = await import('./vault-secrets-plan');
    const saved = {
      host: 'bastion',
      port: 22,
      user: 'ops',
      password: 'pw',
      privateKey: 'KEY',
      passphrase: 'pp',
    };
    const blank = {
      host: 'bastion',
      port: 22,
      user: 'ops',
      password: '',
      privateKey: '',
      passphrase: '',
    };
    expect(mergeSshSecretsForTest(blank, saved)).toMatchObject({
      password: 'pw',
      privateKey: 'KEY',
      passphrase: 'pp',
    });
    expect(mergeSshSecretsForTest({ ...blank, host: 'BASTION ' }, saved).password).toBe('pw');
    expect(mergeSshSecretsForTest({ ...blank, password: 'new' }, saved).password).toBe('new');
    for (const changed of [{ host: 'evil' }, { port: 2222 }, { user: 'root' }]) {
      const out = mergeSshSecretsForTest({ ...blank, ...changed }, saved);
      expect(out).toMatchObject({ password: '', privateKey: '', passphrase: '' });
    }
    expect(mergeSshSecretsForTest(blank, null)).toEqual(blank);
  });
});
