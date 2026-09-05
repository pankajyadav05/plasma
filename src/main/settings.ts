import type { Settings } from '@shared/protocol';
import { SettingsShape } from '@shared/protocol';
import { getDb } from './db';
import {
  deleteSshSecrets,
  putSecret,
  redactSettingsForRenderer,
  setSshSecrets,
} from './vault';

/**
 * Key-value settings store backed by SQLite.
 * Values are JSON-serialized strings; callers get/set typed values.
 *
 * Secret fields (API keys, SSH password/privateKey/passphrase) live in
 * the vault `secrets` table (safeStorage). SettingsGet never returns
 * plaintext secrets — use getPublicSettings / applySettingsPatch.
 */

const RESPONSE_ONLY_KEYS = new Set([
  'hasOpenrouterApiKey',
  'hasClaudeApiKey',
]);

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
  const serialized = JSON.stringify(value);
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, serialized);
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

/**
 * Apply a settings patch. Secret fields are routed to the vault:
 * - non-empty API key / SSH secret → encrypt + store
 * - empty secret string → keep existing vault value (leave blank to keep)
 * - removed connectionSsh entry → delete that connection's SSH secrets
 *
 * Ordinary settings are merged and written; secret plaintext is never
 * persisted into the settings table.
 */
export function applySettingsPatch(patch: unknown): Settings {
  const rawPatch = (patch ?? {}) as Record<string, unknown>;
  const prevRaw = SettingsShape.parse(getAllSettings());

  // ── API keys → vault ──
  if (typeof rawPatch.openrouterApiKey === 'string' && rawPatch.openrouterApiKey.length > 0) {
    putSecret('setting:openrouterApiKey', rawPatch.openrouterApiKey);
  }
  if (typeof rawPatch.claudeApiKey === 'string' && rawPatch.claudeApiKey.length > 0) {
    putSecret('setting:claudeApiKey', rawPatch.claudeApiKey);
  }

  // ── SSH map → public metadata in settings + secrets in vault ──
  let nextSshPublic = prevRaw.connectionSsh ?? {};
  if ('connectionSsh' in rawPatch) {
    const incoming = SettingsShape.shape.connectionSsh.parse(rawPatch.connectionSsh);
    const prevIds = new Set(Object.keys(prevRaw.connectionSsh ?? {}));
    const nextIds = new Set(Object.keys(incoming));

    for (const id of prevIds) {
      if (!nextIds.has(id)) deleteSshSecrets(id);
    }

    const publicMap: Settings['connectionSsh'] = {};
    for (const [id, ssh] of Object.entries(incoming)) {
      publicMap[id] = {
        host: ssh.host,
        port: ssh.port,
        user: ssh.user,
        password: '',
        privateKey: '',
        passphrase: '',
      };
      setSshSecrets(id, {
        password: ssh.password,
        privateKey: ssh.privateKey,
        passphrase: ssh.passphrase,
      });
    }
    nextSshPublic = publicMap;
    setSetting('connectionSsh', stripSshSecrets(publicMap));
  }

  // ── Merge non-secret keys ──
  const mergedPatch: Record<string, unknown> = { ...rawPatch };
  delete mergedPatch.openrouterApiKey;
  delete mergedPatch.claudeApiKey;
  delete mergedPatch.connectionSsh;
  for (const k of RESPONSE_ONLY_KEYS) delete mergedPatch[k];
  // Also strip has* flags nested under connectionSsh if any slipped in
  delete mergedPatch.hasOpenrouterApiKey;
  delete mergedPatch.hasClaudeApiKey;

  const merged = SettingsShape.parse({
    ...prevRaw,
    ...mergedPatch,
    connectionSsh: nextSshPublic,
    // Never persist plaintext API keys in the settings table
    openrouterApiKey: '',
    claudeApiKey: '',
  });

  for (const [k, v] of Object.entries(merged)) {
    if (RESPONSE_ONLY_KEYS.has(k)) continue;
    if (k === 'hasOpenrouterApiKey' || k === 'hasClaudeApiKey') continue;
    if (k === 'connectionSsh') {
      setSetting(k, stripSshSecrets(v as Settings['connectionSsh']));
      continue;
    }
    if (k === 'openrouterApiKey' || k === 'claudeApiKey') {
      setSetting(k, '');
      continue;
    }
    setSetting(k, v);
  }

  return getPublicSettings();
}

function stripSshSecrets(
  map: Settings['connectionSsh'],
): Record<string, { host: string; port: number; user: string }> {
  const out: Record<string, { host: string; port: number; user: string }> = {};
  for (const [id, ssh] of Object.entries(map ?? {})) {
    out[id] = { host: ssh.host, port: ssh.port, user: ssh.user };
  }
  return out;
}

