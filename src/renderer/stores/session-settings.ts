/**
 * Settings slice: the persisted `Settings` mirror, theme + font application,
 * sidebar sizes, favourites and connection tags.
 */
import { ipc } from '@/lib/ipc';
import type { Settings } from '@shared/protocol';
import type { SliceCreator } from './session-types';

const THEME_NAMES = [
  'default',
  'catppuccin',
  'claude',
  'claymorphism',
  'neo-brutalism',
  'quantum-rose',
  'forest-canopy',
  'cyberpunk',
  'arctic',
] as const;

const FONT_SANS_STACKS: Record<string, string> = {
  geist: "'Geist Variable', 'Geist', ui-sans-serif, system-ui, -apple-system, sans-serif",
  inter: "'Inter Variable', 'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif",
  outfit: "'Outfit Variable', 'Outfit', ui-sans-serif, system-ui, -apple-system, sans-serif",
  'plus-jakarta':
    "'Plus Jakarta Sans Variable', 'Plus Jakarta Sans', ui-sans-serif, system-ui, -apple-system, sans-serif",
  'ibm-plex':
    "'IBM Plex Sans Variable', 'IBM Plex Sans', ui-sans-serif, system-ui, -apple-system, sans-serif",
  system:
    "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
};

const FONT_MONO_STACKS: Record<string, string> = {
  'jetbrains-mono':
    "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  'geist-mono':
    "'Geist Mono Variable', 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  'ibm-plex-mono': "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  system: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
};

function applyTheme(mode: 'light' | 'dark', name: string) {
  const root = document.documentElement;
  root.classList.toggle('dark', mode === 'dark');
  for (const n of THEME_NAMES) root.classList.remove(`theme-${n}`);
  if (name && name !== 'default') root.classList.add(`theme-${name}`);
  // Notify non-CSS consumers (Monaco, future canvases) that live vars changed.
  window.dispatchEvent(new CustomEvent('plasma:theme-changed', { detail: { mode, name } }));
}

// Inline `--font-*` overrides on <html>. Beats theme-class vars by source
// order + specificity (inline style wins over any class rule). When the
// user resets to 'theme', we removeProperty so the theme's choice
// resurfaces cleanly.
function applyFonts(sans: string, mono: string) {
  const root = document.documentElement;
  if (sans === 'theme' || !FONT_SANS_STACKS[sans]) {
    root.style.removeProperty('--font-sans');
  } else {
    root.style.setProperty('--font-sans', FONT_SANS_STACKS[sans]);
  }
  if (mono === 'theme' || !FONT_MONO_STACKS[mono]) {
    root.style.removeProperty('--font-mono');
  } else {
    root.style.setProperty('--font-mono', FONT_MONO_STACKS[mono]);
  }
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'light',
  themeName: 'default',
  fontSans: 'theme',
  fontMono: 'theme',
  sidebarCollapsed: false,
  sidebarWidth: 264,
  rightSidebarWidth: 300,
  editorExpanded: false,
  editorFontSize: 13,
  editorHeightPx: 280,
  defaultPageSize: 50,
  queryTimeoutMs: 0,
  restoreWorkspace: true,
  safeModeDefault: 'confirm-dangerous',
  connectionSafeMode: {},
  connectionAlwaysSafeRun: {},
  safeRunRowThreshold: 1000,
  safeRunTimeoutSec: 300,
  csvExport: { delimiter: ',', header: true, quote: '"', nullAs: 'empty', lineEnding: 'lf' },
  gridAlternatingRows: true,
  estimatedCountThreshold: 100_000,
  openrouterApiKey: '',
  openrouterModel: 'anthropic/claude-sonnet-4.5',
  claudeApiKey: '',
  transactionMode: false,
  pgBinDir: '',
  autoConnectOnLaunch: true,
  autoReconnect: true,
  lastConnectionId: null,
  connectionTags: {},
  connectionSsh: {},
  schemaSnapshots: [],
  favoriteSchemas: {},
  favoriteTables: {},
  tableColumnState: {},
  savedQueries: {},
  snippets: [],
  variableHistory: {},
  windowBounds: null,
};

/** Fill any keys missing from a settings payload with renderer defaults. */
export function withDefaults(settings: Partial<Settings>): Settings {
  const merged = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
  for (const [k, v] of Object.entries(settings)) if (v !== undefined) merged[k] = v;
  return merged as Settings;
}

/**
 * Merge a settings write's response into the live mirror: only the keys the
 * write touched, plus server-derived `has…` flags (API-key presence), come
 * from the response; everything else keeps its current (possibly optimistic)
 * value.
 */
export function mergeResponse(
  current: Settings,
  response: Settings,
  touched: readonly string[],
): Settings {
  const out = { ...current } as Record<string, unknown>;
  const src = response as unknown as Record<string, unknown>;
  for (const k of Object.keys(src)) {
    if (touched.includes(k) || /^has[A-Z]/.test(k)) out[k] = src[k];
  }
  for (const k of touched) if (!(k in src)) delete out[k];
  return out as unknown as Settings;
}

export interface SettingsSlice {
  // ── settings ──
  settings: Settings;
  loadSettings(): Promise<void>;
  updateSettings(patch: Partial<Settings>): Promise<void>;
  /** Settings → AI: delete the saved API key from the vault. */
  clearAiApiKey(): Promise<void>;
  toggleSidebar(): Promise<void>;
  toggleTheme(): Promise<void>;
  toggleFavoriteSchema(connectionId: string, schemaName: string): Promise<void>;
  toggleFavoriteTable(connectionId: string, schemaName: string, tableName: string): Promise<void>;
  /** Update sidebar width (optimistic). Persistence is caller's responsibility. */
  setSidebarWidth(width: number): void;
  setRightSidebarWidth(width: number): void;
  setConnectionTag(
    connectionId: string,
    tag: 'prod' | 'staging' | 'dev' | 'local' | null,
  ): Promise<void>;
}

export const createSettingsSlice: SliceCreator<SettingsSlice> = (set, get) => ({
  settings: DEFAULT_SETTINGS,

  setSidebarWidth(width) {
    // Optimistic, no IPC. The caller (resizer pointerup) persists once.
    if (!Number.isFinite(width)) return;
    const clamped = Math.max(200, Math.min(520, Math.round(width)));
    set({ settings: { ...get().settings, sidebarWidth: clamped } });
  },

  setRightSidebarWidth(width) {
    // Same contract as setSidebarWidth: optimistic here, persisted on drop.
    if (!Number.isFinite(width)) return;
    const clamped = Math.max(240, Math.min(720, Math.round(width)));
    set({ settings: { ...get().settings, rightSidebarWidth: clamped } });
  },

  async loadSettings() {
    try {
      // Merge over renderer defaults: a main process built before a
      // setting existed (e.g. `pnpm dev` hot-reloads the renderer but not
      // main) returns objects without the new keys, and undefined widths /
      // flags would silently break the features that read them.
      const settings = withDefaults(await ipc.settings.get());
      set({ settings });
      // Apply theme + font overrides immediately on boot
      applyTheme(settings.theme, settings.themeName);
      applyFonts(settings.fontSans, settings.fontMono);
    } catch (err) {
      console.error('[plasma] settings.get failed', err);
    }
  },

  async updateSettings(patch) {
    try {
      const response = withDefaults(await ipc.settings.set(patch));
      // R-17: take only what this write touched (plus server-derived flags)
      // from the response. Optimistic writers (saved queries, sidebar width,
      // favourites…) may have changed other keys while this one was in
      // flight; replacing the whole mirror would roll those back.
      const next = mergeResponse(get().settings, response, Object.keys(patch));
      set({ settings: next });
      applyTheme(next.theme, next.themeName);
      applyFonts(next.fontSans, next.fontMono);
    } catch (err) {
      console.error('[plasma] settings.set failed', err);
    }
  },

  async clearAiApiKey() {
    try {
      set({ settings: withDefaults(await ipc.settings.clearApiKey()) });
    } catch (err) {
      console.error('[plasma] settings.clearApiKey failed', err);
    }
  },

  async toggleSidebar() {
    // Optimistic UI update first so the panel flips instantly.
    // Persistence to SQLite is fire-and-forget — any failure is logged
    // but never blocks the interaction.
    const next = !get().settings.sidebarCollapsed;
    set({ settings: { ...get().settings, sidebarCollapsed: next } });
    try {
      await ipc.settings.set({ sidebarCollapsed: next });
    } catch (err) {
      console.error('[plasma] persist sidebarCollapsed failed', err);
    }
  },

  async toggleTheme() {
    // Optimistic theme flip — apply CSS immediately, persist in background.
    const next = get().settings.theme === 'light' ? 'dark' : 'light';
    set({ settings: { ...get().settings, theme: next } });
    applyTheme(next, get().settings.themeName);
    try {
      await ipc.settings.set({ theme: next });
    } catch (err) {
      console.error('[plasma] persist theme failed', err);
    }
  },

  async toggleFavoriteSchema(connectionId: string, schemaName: string) {
    const current = get().settings.favoriteSchemas ?? {};
    const forConn = new Set(current[connectionId] ?? []);
    if (forConn.has(schemaName)) forConn.delete(schemaName);
    else forConn.add(schemaName);
    const nextMap = {
      ...current,
      [connectionId]: Array.from(forConn).sort(),
    };
    // Optimistic
    set({ settings: { ...get().settings, favoriteSchemas: nextMap } });
    try {
      await ipc.settings.set({ favoriteSchemas: nextMap });
    } catch (err) {
      console.error('[plasma] persist favoriteSchemas failed', err);
    }
  },

  async toggleFavoriteTable(connectionId, schemaName, tableName) {
    const current = get().settings.favoriteTables ?? {};
    const key = `${schemaName}.${tableName}`;
    const forConn = new Set(current[connectionId] ?? []);
    if (forConn.has(key)) forConn.delete(key);
    else forConn.add(key);
    const nextMap = {
      ...current,
      [connectionId]: Array.from(forConn).sort(),
    };
    set({ settings: { ...get().settings, favoriteTables: nextMap } });
    try {
      await ipc.settings.set({ favoriteTables: nextMap });
    } catch (err) {
      console.error('[plasma] persist favoriteTables failed', err);
    }
  },

  async setConnectionTag(connectionId, tag) {
    const current = get().settings.connectionTags ?? {};
    const next: Record<string, 'prod' | 'staging' | 'dev' | 'local'> = { ...current };
    if (tag === null) {
      delete next[connectionId];
    } else {
      next[connectionId] = tag;
    }
    set({ settings: { ...get().settings, connectionTags: next } });
    try {
      await ipc.settings.set({ connectionTags: next });
    } catch (err) {
      console.error('[plasma] persist connectionTags failed', err);
    }
  },
});
