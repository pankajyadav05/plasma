/**
 * Platform-aware keyboard shortcut formatting. Mac shows the cloverleaf
 * (⌘); Windows/Linux show "Ctrl". Use everywhere a shortcut is rendered
 * to the user — tooltips, palette hints, button labels.
 */
import { type KeyId, formatBinding, formatKeys } from '@shared/keymap';

export const isMac = typeof window !== 'undefined' && window.plasma?.platform === 'darwin';

/** Modifier glyph alone — "⌘" on mac, "Ctrl" elsewhere. */
export const MOD = isMac ? '⌘' : 'Ctrl';

/** Keys that are pressed on their own — never prefixed with ⌘ / Ctrl. */
const BARE_KEYS = new Set(['Esc', 'Escape', 'Enter', 'Space', 'Tab', 'F2']);

/**
 * Format a ⌘-chord from its key: `kbd("K")` → "⌘K" / "Ctrl+K",
 * `kbd("⇧F")` → "⌘⇧F" / "Ctrl+Shift+F", `kbd("⏎")` → "⌘⏎" / "Ctrl+Enter".
 * Bare keys (`kbd("Esc")`) render without a modifier.
 */
export function kbd(key: string): string {
  if (BARE_KEYS.has(key)) return formatKeys(key === 'Escape' ? 'Esc' : key, isMac);
  return formatKeys(`⌘${key}`, isMac);
}

/** Display form of a keymap binding for this platform (`@shared/keymap`). */
export function shortcut(id: KeyId): string {
  return formatBinding(id, isMac);
}
