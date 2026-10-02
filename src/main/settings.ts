import type { Settings } from '@shared/protocol';
import { SettingsShape } from '@shared/protocol';
import { z } from 'zod';
import { getDb } from './db';
import {
  deleteSecret,
  deleteSshSecrets,
  putSecret,
  redactSettingsForRenderer,
  setSshSecrets,
} from './vault';
import { canReuseStoredSshSecrets } from './vault-secrets-plan';

/**
 * Key-value settings store backed by SQLite.
 * Values are JSON-serialized strings; callers get/set typed values.
 *
 * Secret fields (API keys, SSH password/privateKey/passphrase) live in
 * the vault `secrets` table (safeStorage). SettingsGet never returns
 * plaintext secrets — use getPublicSettings / applySettingsPatch.
 */

const RESPONSE_ONLY_KEYS = new Set(['hasOpenrouterApiKey', 'hasClaudeApiKey']);

export function getSetting<T>(key: string, fallback: T): T {
  const row = getDb()
    .prepare<[string], { value: string }>('SELECT value FROM settings WHERE key = ?')
    .get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function setSetting<T>(key: string, value: T): void {
  setSettings({ [key]: value });
}

/**
 * Persist one or more settings keys in a single SQLite transaction,
 * reusing one prepared UPSERT. No-op when `entries` is empty.
 */
export function setSettings(entries: Record<string, unknown>): void {
  const keys = Object.keys(entries);
  if (keys.length === 0) return;

  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  const tx = db.transaction((pairs: Array<[string, string]>) => {
    for (const [key, serialized] of pairs) {
      stmt.run(key, serialized);
    }
  });
  tx(keys.map((key) => [key, JSON.stringify(entries[key])] as [string, string]));
}

export function getAllSettings(): Record<string, unknown> {
  const rows = getDb()
    .prepare<[], { key: string; value: string }>('SELECT key, value FROM settings')
    .all();
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      out[row.key] = row.value;
    }
  }
  return out;
}

/** Settings for the renderer — secrets redacted, presence flags set. */
export function getPublicSettings(): Settings {
  const parsed = SettingsShape.parse(getAllSettings());
  return redactSettingsForRenderer(parsed);
}

/** Secrets of an SSH entry that a patch may clear individually (SC-08). */
const SshSecretField = z.enum(['password', 'privateKey', 'passphrase']);
const ClearSshSecrets = z.record(z.string(), z.array(SshSecretField)).catch({});

/**
 * Apply a settings patch. Secret fields are routed to the vault:
 * - non-empty API key / SSH secret → encrypt + store
 * - empty secret string → keep existing vault value (leave blank to keep)
 * - removed connectionSsh entry → delete that connection's SSH secrets
 * - `clearSshSecrets: { [id]: ['password'|'privateKey'|'passphrase'] }` →
 *   delete exactly those stored secrets (blank alone can never do that)
 * - an entry whose host / port / user changed never inherits the old
 *   bastion's secrets: they are dropped unless the patch supplies new ones
 *
 * Ordinary settings are merged and written; secret plaintext is never
 * persisted into the settings table. Everything is validated first and then
 * written in ONE SQLite transaction, so a patch with one invalid field
 * leaves both settings and vault untouched (SC-25).
 */
export function applySettingsPatch(patch: unknown): Settings {
  const rawPatch = (patch ?? {}) as Record<string, unknown>;
  const prevRaw = SettingsShape.parse(getAllSettings());

  // ── Validate everything before touching storage ──
  const incomingSsh =
    'connectionSsh' in rawPatch
      ? SettingsShape.shape.connectionSsh.parse(rawPatch.connectionSsh)
      : null;
  let nextSshPublic = prevRaw.connectionSsh ?? {};
  const sshWrites: Array<{ id: string; dropOld: boolean; secrets: SshSecrets }> = [];
  const sshDeletes: string[] = [];
  if (incomingSsh) {
    const prevMap = prevRaw.connectionSsh ?? {};
    const nextIds = new Set(Object.keys(incomingSsh));
    for (const id of Object.keys(prevMap)) {
      if (!nextIds.has(id)) sshDeletes.push(id);
    }
    const publicMap: Settings['connectionSsh'] = {};
    for (const [id, ssh] of Object.entries(incomingSsh)) {
      publicMap[id] = {
        host: ssh.host,
        port: ssh.port,
        user: ssh.user,
        password: '',
        privateKey: '',
        passphrase: '',
        privateKeyPath: ssh.privateKeyPath ?? '',
        useAgent: ssh.useAgent ?? false,
      };
      const prev = prevMap[id];
      sshWrites.push({
        id,
        // SC-08: blank means "keep" only for the same bastion + login.
        dropOld: Boolean(prev && !canReuseStoredSshSecrets(prev, ssh)),
        secrets: { password: ssh.password, privateKey: ssh.privateKey, passphrase: ssh.passphrase },
      });
    }
    nextSshPublic = publicMap;
  }
  const sshClears = ClearSshSecrets.parse(rawPatch.clearSshSecrets ?? {});

  // ── Merge non-secret keys ──
  const STRIPPED_PATCH_KEYS = new Set<string>([
    'openrouterApiKey',
    'claudeApiKey',
    'connectionSsh',
    'clearSshSecrets',
    // Host-key trust is changed only by the host-key prompt flow in main
    // (SC-28): a compromised renderer must not pre-approve a MITM key.
    'sshKnownHosts',
    ...RESPONSE_ONLY_KEYS,
    // Also strip has* flags if any slipped in
    'hasOpenrouterApiKey',
    'hasClaudeApiKey',
  ]);
  const mergedPatch: Record<string, unknown> = Object.fromEntries(
    Object.entries(rawPatch).filter(([k]) => !STRIPPED_PATCH_KEYS.has(k)),
  );

  const merged = SettingsShape.parse({
    ...prevRaw,
    ...mergedPatch,
    connectionSsh: nextSshPublic,
    // Never persist plaintext API keys in the settings table
    openrouterApiKey: '',
    claudeApiKey: '',
  });

  const settingsToWrite: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(merged)) {
    if (RESPONSE_ONLY_KEYS.has(k)) continue;
    if (k === 'hasOpenrouterApiKey' || k === 'hasClaudeApiKey') continue;
    if (k === 'connectionSsh') {
      if (incomingSsh) settingsToWrite[k] = stripSshSecrets(v as Settings['connectionSsh']);
      continue;
    }
    if (k === 'openrouterApiKey' || k === 'claudeApiKey') {
      settingsToWrite[k] = '';
      continue;
    }
    settingsToWrite[k] = v;
  }

  // ── Apply, atomically ──
  const db = getDb();
  db.transaction(() => {
    if (typeof rawPatch.openrouterApiKey === 'string' && rawPatch.openrouterApiKey.length > 0) {
      putSecret('setting:openrouterApiKey', rawPatch.openrouterApiKey, db);
    }
    if (typeof rawPatch.claudeApiKey === 'string' && rawPatch.claudeApiKey.length > 0) {
      putSecret('setting:claudeApiKey', rawPatch.claudeApiKey, db);
    }
    for (const id of sshDeletes) deleteSshSecrets(id, db);
    for (const w of sshWrites) {
      if (w.dropOld) deleteSshSecrets(w.id, db);
      setSshSecrets(w.id, w.secrets, db);
    }
    for (const [id, fields] of Object.entries(sshClears)) {
      for (const field of fields) {
        // A secret supplied in the same patch wins over a clear request.
        const supplied = sshWrites.find((w) => w.id === id)?.secrets[field];
        if (!supplied) deleteSecret(`ssh:${id}:${field}`, db);
      }
    }
    setSettings(settingsToWrite);
  })();

  return getPublicSettings();
}

type SshSecrets = { password: string; privateKey: string; passphrase: string };

function stripSshSecrets(
  map: Settings['connectionSsh'],
): Record<
  string,
  { host: string; port: number; user: string; privateKeyPath: string; useAgent: boolean }
> {
  const out: Record<
    string,
    { host: string; port: number; user: string; privateKeyPath: string; useAgent: boolean }
  > = {};
  for (const [id, ssh] of Object.entries(map ?? {})) {
    out[id] = {
      host: ssh.host,
      port: ssh.port,
      user: ssh.user,
      privateKeyPath: ssh.privateKeyPath ?? '',
      useAgent: ssh.useAgent ?? false,
    };
  }
  return out;
}

export { changedSettings, settingsValueEqual } from './settings-changed';
