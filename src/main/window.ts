import { BrowserWindow, shell } from 'electron';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getSetting, setSetting } from './settings';

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
      // biome-ignore lint/suspicious/noConsole: diagnostic — useful in dev logs
      console.log('[plasma] window icon:', candidate);
      return candidate;
    }
  }
  // biome-ignore lint/suspicious/noConsole: diagnostic
  console.warn(
    '[plasma] window icon not found. Run `pnpm install` (triggers prepare script) ' +
      'or `pnpm build:icons` to generate resources/icon.png. Tried:',
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
    return { background: '#000000' };
  }
  return { background: '#FFFFFF' };
}

export function applyThemeToWindow(win: BrowserWindow, theme: Theme): void {
  const colors = themeColors(theme);
  win.setBackgroundColor(colors.background);
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
    backgroundColor: colors.background,
    // Taskbar / Alt-Tab / window chrome icon. On macOS the dock icon
    // comes from app.dock.setIcon() — see main/index.ts.
    icon: iconPath,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 16, y: 16 } } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
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

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return win;
}
