/**
 * Pure helpers for U18 — pick settings keys whose JSON-serialized value
 * changed. Kept free of Electron/SQLite imports so vitest can cover them.
 */

/** Stable JSON equality for settings values (objects, arrays, primitives). */
export function settingsValueEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Returns only the keys in `next` whose values differ from `prev`.
 * Used by SettingsSet so we UPSERT changed rows only.
 */
export function changedSettings(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(next)) {
    if (!settingsValueEqual(prev[key], value)) {
      out[key] = value;
    }
  }
  return out;
}
