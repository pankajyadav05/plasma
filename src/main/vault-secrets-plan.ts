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
