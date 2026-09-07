import { describe, expect, it } from 'vitest';
import type { Settings } from '@shared/protocol';
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
    theme: 'light',
    themeName: 'default',
    fontSans: 'theme',
    fontMono: 'theme',
    sidebarCollapsed: false,
    sidebarWidth: 264,
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
    connectionTags: {},
    connectionSsh: {
      'conn-1': {
        host: 'bastion',
        port: 22,
        user: 'ubuntu',
        password: 'SHOULD_NOT_LEAK',
        privateKey: 'SHOULD_NOT_LEAK',
        passphrase: 'SHOULD_NOT_LEAK',
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
    });
  });
});
