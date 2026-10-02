/**
 * R-05: after a context-menu action the grid takes focus back — unless the
 * action opened an inline editor or a dialog, which must keep focus (a
 * blur would commit the editor straight away).
 */
export const FOCUS_OWNER_SELECTOR =
  'input, textarea, select, [contenteditable="true"], [role="dialog"]';

export function shouldRefocusGrid(active: { closest(selector: string): unknown } | null): boolean {
  return !active?.closest(FOCUS_OWNER_SELECTOR);
}
