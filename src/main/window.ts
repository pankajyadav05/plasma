import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, app } from 'electron';
import { getSetting, setSetting } from './settings';
import type { RendererEntry } from './web-security';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Resolve the path to the rasterized app icon. The build script
 * (`scripts/build-icons.mjs`) generates `resources/icon.png` at
 * `pnpm install` time via the `prepare` npm lifecycle hook.
 *
 * At runtime __dirname is `out/main/` (electron-vite dev output) or
 * `app.asar/out/main/` (packaged build), so both `../../resources/`
 * (source tree) and `../../../resources/` (asar parent) are searched.
 * Returns undefined if none are found — Electron falls back to default.
 */
export function resolveIconPath(): string | undefined {
  const candidates = [
    join(__dirname, '../../resources/icon.png'),
    join(__dirname, '../../../resources/icon.png'),
    // When packaged, extraResources usually lands next to app.asar
    join(process.resourcesPath ?? '', 'icon.png'),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      console.log('[plasma] window icon:', candidate);
      return candidate;
    }
  }
  console.warn(
    '[plasma] window icon not found. Run ' +
      '`pnpm build:icons --force` to generate resources/icon.png. Tried:',
    candidates,
  );
  return undefined;
}

interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

type Theme = 'light' | 'dark';

/**
 * Read the persisted theme and compute the native window background
 * color. Called at window creation and (via `applyThemeToWindow`)
 * whenever the renderer flips theme in settings.
 */
export function themeColors(theme: Theme) {
  if (theme === 'dark') {
    return { background: '#1a1a1a' };
  }
  return { background: '#e9e9e9' };
}

/**
 * macOS gets a native vibrancy material behind the window chrome
 * (toolbar, rails, sidebars read through it; the editor and grid stay
 * opaque). The window background must then be fully transparent or the
 * material is painted over. Other platforms keep a solid background.
 */
export const USES_VIBRANCY = process.platform === 'darwin';
const TRANSPARENT = '#00000000';

export function applyThemeToWindow(win: BrowserWindow, theme: Theme): void {
  if (USES_VIBRANCY) {
    win.setBackgroundColor(TRANSPARENT);
    return;
  }
  const colors = themeColors(theme);
  win.setBackgroundColor(colors.background);
}

/** Where the renderer is served from — the only page windows may show. */
export function rendererEntry(): RendererEntry {
  return {
    devUrl: app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL,
    file: join(__dirname, '../renderer/index.html'),
  };
}

export function createMainWindow(): BrowserWindow {
  const isMac = process.platform === 'darwin';
  const saved = getSetting<WindowBounds | null>('windowBounds', null);
  const theme = getSetting<Theme>('theme', 'light');
  const colors = themeColors(theme);

  const iconPath = resolveIconPath();

  const win = new BrowserWindow({
    width: saved?.width ?? 1440,
    height: saved?.height ?? 900,
    x: saved?.x,
    y: saved?.y,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: false,
    backgroundColor: USES_VIBRANCY ? TRANSPARENT : colors.background,
    ...(USES_VIBRANCY
      ? { vibrancy: 'under-window' as const, visualEffectState: 'followWindow' as const }
      : {}),
    // Taskbar / Alt-Tab / window chrome icon. On macOS the dock icon
    // comes from app.dock.setIcon() — see main/index.ts.
    icon: iconPath,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    // Centred on the 52px toolbar.
    ...(isMac ? { trafficLightPosition: { x: 18, y: 19 } } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      // The preload only uses contextBridge + ipcRenderer (zod is bundled
      // into it), so it runs in the OS sandbox (C19).
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      // No DevTools in shipped builds; `pnpm dev` keeps them.
      devTools: !app.isPackaged,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  // Persist window bounds on resize/move (debounced)
  let saveTimer: NodeJS.Timeout | null = null;
  const persistBounds = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
      try {
        const bounds = win.getBounds();
        setSetting<WindowBounds>('windowBounds', bounds);
      } catch {
        /* ignore */
      }
    }, 500);
  };
  win.on('resize', persistBounds);
  win.on('move', persistBounds);

  // Notify renderer when maximize state changes so the custom titlebar
  // can swap the maximize/restore icon. Double-clicking the drag region
  // and Win+Up/Down shortcuts both go through these events.
  const sendMaximized = (value: boolean) => {
    if (win.isDestroyed()) return;
    win.webContents.send('plasma:window:maximizedChanged', value);
  };
  win.on('maximize', () => sendMaximized(true));
  win.on('unmaximize', () => sendMaximized(false));

  // window.open / target=_blank and navigation are guarded for every
  // webContents in web-security.ts (http/https/mailto only, via the OS).

  const entry = rendererEntry();
  if (entry.devUrl) {
    win.loadURL(entry.devUrl);
  } else {
    win.loadFile(entry.file);
  }

  return win;
}
