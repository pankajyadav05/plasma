/**
 * Platform-aware keyboard shortcut formatting. Mac shows the cloverleaf
 * (⌘); Windows/Linux show "Ctrl". Use everywhere a shortcut is rendered
 * to the user — tooltips, palette hints, button labels.
 */

const isMac = typeof window !== 'undefined' && window.plasma?.platform === 'darwin';

/** Modifier glyph alone — "⌘" on mac, "Ctrl" elsewhere. */
export const MOD = isMac ? '⌘' : 'Ctrl';

/**
 * Format a shortcut like `kbd("K")` → "⌘K" on mac, "Ctrl+K" on win/linux.
 * Pass the bare key (letter, "⏎", ".", etc).
 */
export function kbd(key: string): string {
  return isMac ? `${MOD}${key}` : `${MOD}+${key}`;
}
