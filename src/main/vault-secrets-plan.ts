import type { Settings } from '@shared/protocol';

/**
 * Pure U07 secret-migration / redaction helpers.
 * Kept free of Electron and better-sqlite3 so unit tests can import them
 * under plain Node (the native module is Electron-abi).
 */

/**
 * Pure planner for the v3 secrets migration. Given raw settings key→parsed
 * values (as `getAllSettings` would return), produce vault secret writes and
 * the rewritten settings values with plaintext secrets removed. Used by
 * `migratePlaintextSettingsSecrets` and unit-tested without SQLite/Electron.
 */
export function planSecretsMigration(raw: Record<string, unknown>): {
  secrets: Record<string, string>;
  settings: Record<string, unknown>;
} {
  const secrets: Record<string, string> = {};
  const settings: Record<string, unknown> = { ...raw };

  const takeApiKey = (settingKey: 'openrouterApiKey' | 'claudeApiKey') => {
    const value = raw[settingKey];
    const plaintext = typeof value === 'string' ? value : '';
    if (plaintext) {
      secrets[`setting:${settingKey}`] = plaintext;
    }
    settings[settingKey] = '';
  };
  takeApiKey('openrouterApiKey');
  takeApiKey('claudeApiKey');

  const sshRaw = raw.connectionSsh;
  if (sshRaw && typeof sshRaw === 'object' && !Array.isArray(sshRaw)) {
    const map = sshRaw as Record<string, Record<string, unknown>>;
    const publicMap: Record<string, { host: string; port: number; user: string }> = {};
    for (const [id, entry] of Object.entries(map)) {
      if (!entry || typeof entry !== 'object') continue;
      const host = typeof entry.host === 'string' ? entry.host : '';
      const user = typeof entry.user === 'string' ? entry.user : '';
      const port = typeof entry.port === 'number' ? entry.port : 22;
      if (!host || !user) continue;
      const password = typeof entry.password === 'string' ? entry.password : '';
      const privateKey = typeof entry.privateKey === 'string' ? entry.privateKey : '';
      const passphrase = typeof entry.passphrase === 'string' ? entry.passphrase : '';
      if (password) secrets[`ssh:${id}:password`] = password;
      if (privateKey) secrets[`ssh:${id}:privateKey`] = privateKey;
      if (passphrase) secrets[`ssh:${id}:passphrase`] = passphrase;
      publicMap[id] = { host, port, user };
    }
    settings.connectionSsh = publicMap;
  }

  return { secrets, settings };
}

/**
 * Build a renderer-safe settings view given a presence predicate.
 * Testable without SQLite — production passes `hasSecret`.
 */
export function redactSettingsWithPresence(
  settings: Settings,
  present: (key: string) => boolean,
): Settings {
  const connectionSsh: Settings['connectionSsh'] = {};
  for (const [id, ssh] of Object.entries(settings.connectionSsh ?? {})) {
    connectionSsh[id] = {
      host: ssh.host,
      port: ssh.port,
      user: ssh.user,
      password: '',
      privateKey: '',
      passphrase: '',
      privateKeyPath: ssh.privateKeyPath ?? '',
      useAgent: ssh.useAgent ?? false,
      hasPassword: present(`ssh:${id}:password`),
      hasPrivateKey: present(`ssh:${id}:privateKey`),
      hasPassphrase: present(`ssh:${id}:passphrase`),
    };
  }
  return {
    ...settings,
    openrouterApiKey: '',
    claudeApiKey: '',
    hasOpenrouterApiKey: present('setting:openrouterApiKey'),
    hasClaudeApiKey: present('setting:claudeApiKey'),
    connectionSsh,
  };
}

/**
 * True when raw settings rows still hold plaintext secrets — e.g. installs
 * that reached schema v3 while SettingsSet was still writing API keys / SSH
 * secrets straight into the settings table (C3). Drives the startup
 * re-migration.
 */
export function hasPlaintextSecrets(raw: Record<string, unknown>): boolean {
  return Object.keys(planSecretsMigration(raw).secrets).length > 0;
}

/**
 * Linux `safeStorage` falls back to `basic_text` (a hardcoded key) when no
 * keyring (libsecret / kwallet) is reachable — `isEncryptionAvailable()`
 * still returns true there, so check the backend explicitly (C27).
 */
export function isWeakSecretBackend(platform: string, backend: string | null | undefined): boolean {
  return platform === 'linux' && (backend === 'basic_text' || backend === 'unknown');
}

type PasswordTarget = {
  id: string;
  engine?: string;
  host: string;
  port: number;
  user?: string;
  database?: string;
};

/**
 * The Edit dialog never receives the saved password (C17): a blank field
 * means "keep the stored one". Only reuse it when the connection still
 * points at the same server + login, so a tampered or edited config can't
 * send a stored password to a different host.
 */
export function canReuseStoredPassword(saved: PasswordTarget, incoming: PasswordTarget): boolean {
  return (
    saved.id === incoming.id &&
    (saved.engine ?? 'postgres') === (incoming.engine ?? 'postgres') &&
    saved.host === incoming.host &&
    saved.port === incoming.port &&
    (saved.user ?? '') === (incoming.user ?? '')
  );
}

type SshTarget = { host: string; port: number; user: string };

/**
 * Test-connection twin of `canReuseStoredPassword` for SSH: a blank
 * secret in the dialog means "the saved one", but only while the tunnel
 * still points at the same bastion and login. Otherwise a changed host
 * would be sent the stored password / key.
 */
export function canReuseStoredSshSecrets(saved: SshTarget, incoming: SshTarget): boolean {
  return (
    saved.host.trim().toLowerCase() === incoming.host.trim().toLowerCase() &&
    saved.port === incoming.port &&
    saved.user === incoming.user
  );
}

/**
 * Fill blank SSH secrets from the saved ones when the target is unchanged
 * (see `canReuseStoredSshSecrets`); otherwise use only what the form holds.
 */
export function mergeSshSecretsForTest<
  T extends SshTarget & { password: string; privateKey: string; passphrase: string },
>(
  form: T,
  saved: (SshTarget & { password: string; privateKey: string; passphrase: string }) | null,
): T {
  if (!saved || !canReuseStoredSshSecrets(saved, form)) return form;
  return {
    ...form,
    password: form.password || saved.password,
    privateKey: form.privateKey || saved.privateKey,
    passphrase: form.passphrase || saved.passphrase,
  };
}
