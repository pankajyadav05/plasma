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
