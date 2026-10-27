import type { BrowserWindow } from 'electron';
import { getSetting, setSetting } from './settings';

/**
 * Interface zoom (⌘+ / ⌘− / ⌘0, View menu): scales the whole window like a
 * browser does, not just one font. Steps follow Chrome's, from 80% to 200%. The factor is
 * persisted and re-applied on every page load.
 */
export const ZOOM_FACTORS = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;
const SETTING_KEY = 'uiZoomFactor';

/** Next factor in `direction` (+1 bigger, −1 smaller, 0 reset to 100%). */
export function stepZoom(current: number, direction: -1 | 0 | 1): number {
  if (direction === 0) return 1;
  if (direction > 0) return ZOOM_FACTORS.find((f) => f > current + 0.001) ?? current;
  return [...ZOOM_FACTORS].reverse().find((f) => f < current - 0.001) ?? current;
}

/** Saved factor snapped into range (a corrupt value falls back to 100%). */
export function savedZoom(): number {
  const v = getSetting<unknown>(SETTING_KEY, 1);
  if (typeof v !== 'number' || !Number.isFinite(v)) return 1;
  return Math.min(ZOOM_FACTORS[ZOOM_FACTORS.length - 1], Math.max(ZOOM_FACTORS[0], v));
}

/**
 * Set the factor and keep the macOS window buttons lined up with the scaled
 * toolbar: the toolbar's left padding is divided by `--ui-zoom` (globals.css)
 * so it stays clear of the buttons, and the buttons stay vertically centred
 * on the 52px-at-100% bar (14px tall, y=19 at 100%).
 */
function applyZoom(win: BrowserWindow, factor: number): void {
  win.webContents.setZoomFactor(factor);
  void win.webContents
    .executeJavaScript(`document.documentElement.style.setProperty('--ui-zoom', '${factor}')`)
    .catch(() => {});
  if (process.platform === 'darwin') {
    win.setWindowButtonPosition?.({ x: 18, y: Math.round(26 * factor - 7) });
  }
}

export function zoomWindow(win: BrowserWindow | null | undefined, direction: -1 | 0 | 1): void {
  if (!win || win.isDestroyed()) return;
  const next = stepZoom(win.webContents.getZoomFactor(), direction);
  applyZoom(win, next);
  setSetting(SETTING_KEY, next);
}

/** Restore the saved zoom on each load and route ⌘/Ctrl + wheel through
 *  the same steps. */
export function attachZoom(win: BrowserWindow): void {
  win.webContents.on('did-finish-load', () => applyZoom(win, savedZoom()));
  win.webContents.on('zoom-changed', (_e, dir) => zoomWindow(win, dir === 'in' ? 1 : -1));
}
