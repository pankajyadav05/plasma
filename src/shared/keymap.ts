/**
 * Canonical keyboard map for Plasma.
 *
 * Main (native menu accelerators), renderer DOM listeners, and Monaco
 * command bindings all read from this module so a chord can only mean
 * one thing. DESIGN.md §8.2/§8.8 is the authority: ⌘K opens the command
 * palette; the AI panel is on ⌘L.
 */

export type KeyId =
  | 'palette'
  | 'toggleAi'
  | 'cheatSheet'
  | 'toggleSidebar'
  | 'toggleEditor'
  | 'runQuery'
  | 'runQueryAll'
  | 'cancelQuery'
  | 'history'
  | 'newTab'
  | 'closeTab'
  | 'exportCsv'
  | 'formatSql'
  | 'askAi'
  | 'codegen'
  | 'notebook'
  | 'schemaDiff'
  | 'nextTab'
  | 'prevTab'
  | 'selectTab'
  | 'toggleRightSidebar'
  | 'settings'
  | 'commitEdits'
  | 'saveFileAs'
  | 'openFile'
  | 'refresh'
  | 'toggleComment'
  | 'fontBigger'
  | 'fontSmaller'
  | 'fontReset'
  | 'wordWrap'
  | 'closeFullPage'
  | 'gridMove'
  | 'gridEdit'
  | 'gridCellDetail'
  | 'gridRowDetail'
  | 'gridNextCell'
  | 'gridCopy'
  | 'gridFind'
  | 'gridClear'
  | 'resultCycle'
  | 'osRun'
  | 'redisCliHistory';

export interface Chord {
  /** Letter, digit, or special: Enter | Escape | . | / */
  key: string;
  /** Cmd on macOS / Ctrl elsewhere */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export type KeyCategory = 'General' | 'Query' | 'Tabs' | 'View' | 'Editor' | 'Grid';

/**
 * Where a binding is active.
 * - global: document listener in AppShell (and the native menu)
 * - editor: Monaco commands
 * - grid / results / view: handled by that component's own listener; the
 *   entry exists so the cheat-sheet documents it (never dispatched here)
 */
export type KeyScope = 'global' | 'editor' | 'grid' | 'results' | 'view';

export interface KeyBinding {
  id: KeyId;
  chord: Chord;
  /** Extra chords that trigger the same action (not shown in hints). */
  altChords?: readonly Chord[];
  /**
   * Display override for documented multi-key entries ("↑ ↓ ← →"). Uses
   * the glyph notation of `formatKeys` so it still renders per platform.
   */
  keys?: string;
  /** Human label shown in the cheat-sheet and menus */
  label: string;
  category: KeyCategory;
  scope: KeyScope;
  /** Electron Menu accelerator channel when the menu owns this chord */
  menuChannel?: string;
}

/** Single source of truth — order here is the cheat-sheet order. */
export const KEYMAP: readonly KeyBinding[] = [
  {
    id: 'palette',
    chord: { key: 'k', mod: true },
    label: 'Command palette',
    category: 'General',
    scope: 'global',
    menuChannel: 'plasma:menu:palette',
  },
  {
    id: 'toggleAi',
    chord: { key: 'l', mod: true },
    label: 'Toggle AI panel',
    category: 'General',
    scope: 'global',
    menuChannel: 'plasma:menu:toggleAi',
  },
  {
    id: 'cheatSheet',
    chord: { key: '/', mod: true },
    label: 'Keyboard shortcuts',
    category: 'General',
    scope: 'global',
    menuChannel: 'plasma:menu:cheatSheet',
  },
  {
    id: 'newTab',
    chord: { key: 't', mod: true },
    label: 'New query tab',
    category: 'Tabs',
    scope: 'global',
    menuChannel: 'plasma:menu:newTab',
  },
  {
    id: 'closeTab',
    chord: { key: 'w', mod: true },
    label: 'Close tab',
    category: 'Tabs',
    scope: 'global',
    menuChannel: 'plasma:menu:closeTab',
  },
  {
    id: 'runQuery',
    chord: { key: 'Enter', mod: true },
    label: 'Run selection / at cursor',
    category: 'Query',
    scope: 'global',
    menuChannel: 'plasma:menu:runQuery',
  },
  {
    id: 'runQueryAll',
    chord: { key: 'Enter', mod: true, shift: true },
    label: 'Run all',
    category: 'Query',
    scope: 'global',
    menuChannel: 'plasma:menu:runQueryAll',
  },
  {
    id: 'cancelQuery',
    chord: { key: '.', mod: true },
    label: 'Cancel query',
    category: 'Query',
    scope: 'global',
    menuChannel: 'plasma:menu:cancelQuery',
  },
  {
    id: 'history',
    // ⇧⌘H: plain ⌘H is macOS "Hide Plasma" and Ctrl+H is Monaco's
    // find-and-replace on Windows/Linux (K1).
    chord: { key: 'h', mod: true, shift: true },
    label: 'Query history',
    category: 'Query',
    scope: 'global',
    menuChannel: 'plasma:menu:history',
  },
  {
    id: 'exportCsv',
    chord: { key: 'e', mod: true, shift: true },
    label: 'Export results as CSV',
    category: 'Query',
    scope: 'global',
    menuChannel: 'plasma:menu:exportCsv',
  },
  {
    id: 'toggleSidebar',
    chord: { key: 'b', mod: true },
    label: 'Toggle sidebar',
    category: 'View',
    scope: 'global',
    menuChannel: 'plasma:menu:toggleSidebar',
  },
  {
    id: 'toggleEditor',
    chord: { key: 'j', mod: true },
    label: 'Toggle query editor',
    category: 'View',
    scope: 'global',
    menuChannel: 'plasma:menu:toggleEditor',
  },
  {
    id: 'toggleRightSidebar',
    chord: { key: 'b', mod: true, shift: true },
    label: 'Toggle right sidebar (Details)',
    category: 'View',
    scope: 'global',
  },
  {
    id: 'nextTab',
    chord: { key: ']', mod: true, shift: true },
    label: 'Next tab',
    category: 'Tabs',
    scope: 'global',
  },
  {
    id: 'prevTab',
    chord: { key: '[', mod: true, shift: true },
    label: 'Previous tab',
    category: 'Tabs',
    scope: 'global',
  },
  {
    // ⌘1…⌘9 are all handled by AppShell; the table lists the first.
    id: 'selectTab',
    chord: { key: '1', mod: true },
    label: 'Go to tab 1–9',
    category: 'Tabs',
    scope: 'global',
  },
  {
    id: 'codegen',
    chord: { key: 'g', mod: true, shift: true },
    label: 'Codegen dialog',
    category: 'View',
    scope: 'global',
  },
  {
    id: 'notebook',
    chord: { key: 'n', mod: true, shift: true },
    label: 'Notebook dialog',
    category: 'View',
    scope: 'global',
  },
  {
    id: 'schemaDiff',
    chord: { key: 'd', mod: true, shift: true },
    label: 'Schema diff',
    category: 'View',
    scope: 'global',
  },
  {
    id: 'settings',
    chord: { key: ',', mod: true },
    label: 'Settings',
    category: 'General',
    scope: 'global',
    menuChannel: 'plasma:menu:settings',
  },
  {
    // Contextual save: commits pending grid edits when there are any,
    // otherwise saves the active SQL tab to its .sql file.
    id: 'commitEdits',
    chord: { key: 's', mod: true },
    label: 'Commit changes / save SQL file',
    category: 'Query',
    scope: 'global',
    menuChannel: 'plasma:menu:commitEdits',
  },
  {
    id: 'saveFileAs',
    chord: { key: 's', mod: true, shift: true },
    label: 'Save SQL as…',
    category: 'Query',
    scope: 'global',
    menuChannel: 'plasma:menu:saveFileAs',
  },
  {
    id: 'openFile',
    chord: { key: 'o', mod: true },
    label: 'Open SQL file…',
    category: 'Query',
    scope: 'global',
    menuChannel: 'plasma:menu:openFile',
  },
  {
    id: 'refresh',
    chord: { key: 'r', mod: true },
    label: 'Refresh table data',
    category: 'Query',
    scope: 'global',
    menuChannel: 'plasma:menu:refresh',
  },
  {
    id: 'formatSql',
    chord: { key: 'i', mod: true },
    altChords: [{ key: 'f', mod: true, shift: true }],
    label: 'Beautify SQL',
    category: 'Editor',
    scope: 'editor',
  },
  {
    id: 'askAi',
    chord: { key: 'l', mod: true, shift: true },
    label: 'Ask AI about selection',
    category: 'Editor',
    scope: 'editor',
  },
  {
    // Monaco's built-in line-comment action; ⌘/ outside the editor opens
    // the cheat-sheet instead.
    id: 'toggleComment',
    chord: { key: '/', mod: true },
    label: 'Toggle line comment (in editor)',
    category: 'Editor',
    scope: 'editor',
  },
  {
    id: 'fontBigger',
    chord: { key: '=', mod: true },
    label: 'Larger editor font',
    category: 'Editor',
    scope: 'editor',
  },
  {
    id: 'fontSmaller',
    chord: { key: '-', mod: true },
    label: 'Smaller editor font',
    category: 'Editor',
    scope: 'editor',
  },
  {
    id: 'fontReset',
    chord: { key: '0', mod: true },
    label: 'Reset editor font size',
    category: 'Editor',
    scope: 'editor',
  },
  {
    id: 'wordWrap',
    chord: { key: 'z', alt: true },
    label: 'Toggle word wrap',
    category: 'Editor',
    scope: 'editor',
  },
  {
    id: 'closeFullPage',
    chord: { key: 'Escape' },
    label: 'Close Settings / History / Monitor',
    category: 'View',
    scope: 'view',
  },
  {
    id: 'gridMove',
    chord: { key: 'ArrowDown' },
    keys: '↑ ↓ ← →',
    label: 'Move the cell selection',
    category: 'Grid',
    scope: 'grid',
  },
  {
    id: 'gridNextCell',
    chord: { key: 'Tab' },
    keys: 'Tab / ⇧Tab',
    label: 'Next / previous cell',
    category: 'Grid',
    scope: 'grid',
  },
  {
    id: 'gridRowDetail',
    chord: { key: 'Enter' },
    label: 'Row details',
    category: 'Grid',
    scope: 'grid',
  },
  {
    id: 'gridCellDetail',
    chord: { key: 'Space' },
    label: 'Cell value viewer',
    category: 'Grid',
    scope: 'grid',
  },
  {
    id: 'gridEdit',
    chord: { key: 'F2' },
    label: 'Edit cell (edit mode)',
    category: 'Grid',
    scope: 'grid',
  },
  {
    id: 'gridCopy',
    chord: { key: 'c', mod: true },
    label: 'Copy cell',
    category: 'Grid',
    scope: 'grid',
  },
  {
    id: 'gridFind',
    chord: { key: 'f', mod: true },
    label: 'Find in results',
    category: 'Grid',
    scope: 'grid',
  },
  {
    id: 'gridClear',
    chord: { key: 'Escape' },
    label: 'Clear selection / close find',
    category: 'Grid',
    scope: 'grid',
  },
  {
    id: 'resultCycle',
    chord: { key: 'ArrowRight', alt: true },
    keys: '⌥← / ⌥→',
    label: 'Previous / next statement result',
    category: 'Grid',
    scope: 'results',
  },
  {
    id: 'osRun',
    chord: { key: 'Enter', mod: true },
    label: 'Run search / SQL (OpenSearch)',
    category: 'Query',
    scope: 'view',
  },
  {
    id: 'redisCliHistory',
    chord: { key: 'ArrowUp' },
    keys: '↑ / ↓',
    label: 'Previous / next command (Redis CLI)',
    category: 'Query',
    scope: 'view',
  },
] as const;

const BY_ID = new Map<KeyId, KeyBinding>(KEYMAP.map((b) => [b.id, b]));

export function binding(id: KeyId): KeyBinding {
  const b = BY_ID.get(id);
  if (!b) throw new Error(`unknown keymap id: ${id}`);
  return b;
}

/** Electron MenuItem `accelerator` string (CmdOrCtrl+…). */
export function accelerator(id: KeyId): string {
  const { chord } = binding(id);
  const parts: string[] = [];
  if (chord.mod) parts.push('CmdOrCtrl');
  if (chord.alt) parts.push('Alt');
  if (chord.shift) parts.push('Shift');
  parts.push(electronKeyName(chord.key));
  return parts.join('+');
}

function electronKeyName(key: string): string {
  if (key === 'Enter') return 'Return';
  if (key === 'Escape') return 'Escape';
  if (key === '=') return 'Plus';
  if (key === 'ArrowUp') return 'Up';
  if (key === 'ArrowDown') return 'Down';
  if (key === 'ArrowLeft') return 'Left';
  if (key === 'ArrowRight') return 'Right';
  if (key.length === 1) return key.toUpperCase();
  return key;
}

/**
 * Platform-aware display form for a chord.
 * mac: ⌘⇧F / ⌘K / ⌘/ / ⌥Z
 * win/linux: Ctrl+Shift+F / Alt+Z / Ctrl+Enter
 */
export function formatChord(chord: Chord, isMac: boolean): string {
  const keyGlyph = displayKey(chord.key, isMac);
  if (isMac) {
    return `${chord.mod ? '⌘' : ''}${chord.alt ? '⌥' : ''}${chord.shift ? '⇧' : ''}${keyGlyph}`;
  }
  const parts: string[] = [];
  if (chord.mod) parts.push('Ctrl');
  if (chord.alt) parts.push('Alt');
  if (chord.shift) parts.push('Shift');
  parts.push(keyGlyph);
  return parts.join('+');
}

export function formatBinding(id: KeyId, isMac: boolean): string {
  const b = binding(id);
  return b.keys ? formatKeys(b.keys, isMac) : formatChord(b.chord, isMac);
}

const MAC_KEY_GLYPH: Record<string, string> = {
  Enter: '⏎',
  Escape: 'Esc',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
};

const OTHER_KEY_NAME: Record<string, string> = {
  Enter: 'Enter',
  '⏎': 'Enter',
  Escape: 'Esc',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
};

function displayKey(key: string, isMac = true): string {
  const table = isMac ? MAC_KEY_GLYPH : OTHER_KEY_NAME;
  if (table[key]) return table[key]!;
  if (key.length === 1 && /[a-z]/.test(key)) return key.toUpperCase();
  return key;
}

const GLYPH_MODIFIERS: Record<string, { mac: string; other: string; order: number }> = {
  '⌃': { mac: '⌃', other: 'Ctrl', order: 0 },
  '⌘': { mac: '⌘', other: 'Ctrl', order: 1 },
  '⌥': { mac: '⌥', other: 'Alt', order: 2 },
  '⇧': { mac: '⇧', other: 'Shift', order: 3 },
};

/**
 * Render a shortcut written in mac glyph notation ("⌘⇧F", "⌘⏎", "⌥←",
 * "Esc", "Tab / ⇧Tab") for the current platform. Separators (" / ", " ")
 * are preserved, so documented multi-key entries render per platform
 * too. Off mac: "Ctrl+Shift+F", "Ctrl+Enter", "Alt+←" — a lone "⇧F" is
 * "Shift+F", never "Ctrl+⇧F".
 */
export function formatKeys(keys: string, isMac: boolean): string {
  if (isMac) return keys;
  return keys
    .split(/(\s+\/\s+|\s+)/)
    .map((part) => (/^\s/.test(part) || part === '' ? part : formatKeyToken(part)))
    .join('');
}

function formatKeyToken(token: string): string {
  const mods: string[] = [];
  let i = 0;
  const chars = [...token];
  while (i < chars.length - 1 && GLYPH_MODIFIERS[chars[i]!]) {
    mods.push(chars[i]!);
    i++;
  }
  const rest = chars.slice(i).join('');
  const names = mods
    .sort((a, b) => GLYPH_MODIFIERS[a]!.order - GLYPH_MODIFIERS[b]!.order)
    .map((m) => GLYPH_MODIFIERS[m]!.other);
  return [...new Set(names), OTHER_KEY_NAME[rest] ?? rest].join('+');
}

/** Minimal keyboard-event shape so Node tests don't need DOM libs. */
export interface KeyEventLike {
  key: string;
  /** Physical key (KeyboardEvent.code) — used where Shift rewrites `key`. */
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * True when `e` matches `chord`. Letter keys compare case-insensitively;
 * modifier presence must match exactly (no extra Shift/Alt unless declared).
 */
export function matchesChord(e: KeyEventLike, chord: Chord): boolean {
  const wantMod = !!chord.mod;
  const hasMod = e.metaKey || e.ctrlKey;
  if (hasMod !== wantMod) return false;
  if (!!chord.shift !== e.shiftKey) return false;
  if (!!chord.alt !== e.altKey) return false;
  // Shift rewrites `]` into `}` and Alt rewrites letters on mac (⌥Z = Ω);
  // match those physically.
  const code =
    CODE_FOR_KEY[chord.key] ??
    (chord.alt && /^[a-z]$/i.test(chord.key) ? `Key${chord.key.toUpperCase()}` : undefined);
  if (code && e.code) return e.code === code;
  if (chord.key === '=' && (e.key === '+' || e.code === 'Equal' || e.code === 'NumpadAdd'))
    return true;
  if (chord.key === '-' && (e.code === 'Minus' || e.code === 'NumpadSubtract')) return true;
  return normalizeKey(e.key) === normalizeKey(chord.key);
}

const CODE_FOR_KEY: Record<string, string> = { '[': 'BracketLeft', ']': 'BracketRight' };

/** Primary chord or any alternate chord of the binding. */
export function matchesBinding(e: KeyEventLike, id: KeyId): boolean {
  const b = binding(id);
  return matchesChord(e, b.chord) || (b.altChords ?? []).some((c) => matchesChord(e, c));
}

/**
 * Resolve which global binding (if any) a keydown matches.
 * Editor-scoped and documentation-only chords are excluded.
 */
export function matchGlobalBinding(e: KeyEventLike): KeyBinding | undefined {
  return KEYMAP.find((b) => b.scope === 'global' && matchesBinding(e, b.id));
}

/**
 * ⌘1…⌘9: the tab index (0-based; 8 means "last tab") or null. Kept here
 * so the chord lives next to the rest of the keymap.
 */
export function selectTabIndex(e: KeyEventLike): number | null {
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return null;
  const digit = e.code?.startsWith('Digit') ? e.code.slice(5) : e.key;
  return /^[1-9]$/.test(digit) ? Number(digit) - 1 : null;
}

/**
 * Global chords that must still work while Monaco has focus. Monaco would
 * otherwise swallow them (⌘K is its chord prefix, ⌘J/⌘B/⌘L fall through
 * to a textarea the document handler ignores). Editing chords — ⌘/, ⌘F,
 * ⌘C, Esc — are deliberately absent so Monaco keeps them.
 */
export const EDITOR_PASSTHROUGH: ReadonlySet<KeyId> = new Set<KeyId>([
  'palette',
  'toggleAi',
  'toggleSidebar',
  'toggleEditor',
  'toggleRightSidebar',
  'newTab',
  'closeTab',
  'nextTab',
  'prevTab',
  'history',
  'exportCsv',
  'codegen',
  'notebook',
  'schemaDiff',
  'settings',
  'commitEdits',
  'saveFileAs',
  'openFile',
  'refresh',
  'cancelQuery',
]);

function normalizeKey(key: string): string {
  if (key === 'Return') return 'enter';
  if (key === ' ') return 'space';
  return key.toLowerCase();
}

/** Cheat-sheet rows grouped by category, derived from KEYMAP (no drift). */
export function cheatSheetSections(
  filter = '',
  isMac = true,
): { category: KeyCategory; items: KeyBinding[] }[] {
  const order: KeyCategory[] = ['General', 'Query', 'Tabs', 'View', 'Editor', 'Grid'];
  const q = filter.trim().toLowerCase();
  const hit = (b: KeyBinding) =>
    !q ||
    b.label.toLowerCase().includes(q) ||
    b.category.toLowerCase().includes(q) ||
    formatBinding(b.id, isMac).toLowerCase().includes(q);
  return order
    .map((category) => ({
      category,
      items: KEYMAP.filter((b) => b.category === category && hit(b)),
    }))
    .filter((s) => s.items.length > 0);
}

/** Structural monaco namespace — avoids importing monaco types into shared/. */
export interface MonacoKeyNs {
  KeyMod: { CtrlCmd: number; Shift: number; Alt: number };
  KeyCode: {
    Enter: number;
    Escape: number;
    Period: number;
    Slash: number;
    Comma: number;
    Equal: number;
    Minus: number;
    Digit0: number;
    KeyA: number;
    KeyB: number;
    KeyC: number;
    KeyD: number;
    KeyE: number;
    KeyF: number;
    KeyG: number;
    KeyH: number;
    KeyI: number;
    KeyJ: number;
    KeyK: number;
    KeyL: number;
    KeyM: number;
    KeyN: number;
    KeyO: number;
    KeyP: number;
    KeyQ: number;
    KeyR: number;
    KeyS: number;
    KeyT: number;
    KeyU: number;
    KeyV: number;
    KeyW: number;
    KeyX: number;
    KeyY: number;
    KeyZ: number;
  };
}

/** Map a chord to a Monaco `addCommand` keybinding bitfield. */
export function monacoKeybinding(monaco: MonacoKeyNs, chord: Chord): number {
  let kb = 0;
  if (chord.mod) kb |= monaco.KeyMod.CtrlCmd;
  if (chord.shift) kb |= monaco.KeyMod.Shift;
  if (chord.alt) kb |= monaco.KeyMod.Alt;
  kb |= monacoKeyCode(monaco.KeyCode, chord.key);
  return kb;
}

function monacoKeyCode(KeyCode: MonacoKeyNs['KeyCode'], key: string): number {
  if (key === 'Enter') return KeyCode.Enter;
  if (key === 'Escape') return KeyCode.Escape;
  if (key === '.') return KeyCode.Period;
  if (key === '/') return KeyCode.Slash;
  if (key === ',') return KeyCode.Comma;
  if (key === '=') return KeyCode.Equal;
  if (key === '-') return KeyCode.Minus;
  if (key === '0') return KeyCode.Digit0;
  if (key.length === 1 && /[a-z]/i.test(key)) {
    const name = `Key${key.toUpperCase()}` as keyof MonacoKeyNs['KeyCode'];
    const code = KeyCode[name];
    if (typeof code !== 'number') throw new Error(`monaco KeyCode missing: ${name}`);
    return code;
  }
  throw new Error(`unsupported monaco key: ${key}`);
}
