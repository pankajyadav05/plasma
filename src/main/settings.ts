import { getDb } from './db';

/**
 * Key-value settings store backed by SQLite.
 * Values are JSON-serialized strings; callers get/set typed values.
 */

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

export { changedSettings, settingsValueEqual } from './settings-changed';
