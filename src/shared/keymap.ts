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
  | 'cancelQuery'
  | 'history'
  | 'newTab'
  | 'closeTab'
  | 'exportCsv'
  | 'formatSql'
  | 'askAi'
  | 'codegen'
  | 'notebook'
  | 'schemaDiff';

export interface Chord {
  /** Letter, digit, or special: Enter | Escape | . | / */
  key: string;
  /** Cmd on macOS / Ctrl elsewhere */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export interface KeyBinding {
  id: KeyId;
  chord: Chord;
  /** Human label shown in the cheat-sheet and menus */
  label: string;
  category: 'General' | 'Query' | 'Editor' | 'View';
  /**
   * Where the binding is active.
   * - global: document / native menu
   * - editor: Monaco (and listed in the cheat-sheet under Editor)
   */
  scope: 'global' | 'editor';
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
    category: 'Query',
    scope: 'global',
    menuChannel: 'plasma:menu:newTab',
  },
  {
    id: 'closeTab',
    chord: { key: 'w', mod: true },
    label: 'Close tab',
    category: 'Query',
    scope: 'global',
    menuChannel: 'plasma:menu:closeTab',
  },
  {
    id: 'runQuery',
    chord: { key: 'Enter', mod: true },
    label: 'Run query',
    category: 'Query',
    scope: 'global',
    menuChannel: 'plasma:menu:runQuery',
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
    chord: { key: 'h', mod: true },
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
    id: 'formatSql',
    chord: { key: 'f', mod: true, shift: true },
    label: 'Format SQL',
    category: 'Editor',
    scope: 'editor',
  },
  {
    id: 'askAi',
    chord: { key: 'i', mod: true },
    label: 'Ask AI about selection',
    category: 'Editor',
    scope: 'editor',
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
  if (key.length === 1) return key.toUpperCase();
  return key;
}

/**
 * Platform-aware display form for a chord.
 * mac: ⌘⇧F / ⌘K / ⌘/
 * win/linux: Ctrl+Shift+F
 */
export function formatChord(chord: Chord, isMac: boolean): string {
  const keyGlyph = displayKey(chord.key);
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
  return formatChord(binding(id).chord, isMac);
}

function displayKey(key: string): string {
  if (key === 'Enter') return '⏎';
  if (key === 'Escape') return 'Esc';
  if (key.length === 1 && /[a-z]/.test(key)) return key.toUpperCase();
  return key;
}

/** Minimal keyboard-event shape so Node tests don't need DOM libs. */
export interface KeyEventLike {
  key: string;
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
  return normalizeEventKey(e.key) === normalizeChordKey(chord.key);
}

export function matchesBinding(e: KeyEventLike, id: KeyId): boolean {
  return matchesChord(e, binding(id).chord);
}

/**
 * Resolve which global binding (if any) a keydown matches.
 * Editor-scoped chords are excluded — Monaco owns those.
 */
export function matchGlobalBinding(e: KeyEventLike): KeyBinding | undefined {
  return KEYMAP.find((b) => b.scope === 'global' && matchesChord(e, b.chord));
}

function normalizeEventKey(key: string): string {
  if (key === 'Return') return 'enter';
  return key.length === 1 ? key.toLowerCase() : key.toLowerCase();
}

function normalizeChordKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key.toLowerCase();
}

/** Cheat-sheet rows grouped by category, derived from KEYMAP (no drift). */
export function cheatSheetSections(): { category: KeyBinding['category']; items: KeyBinding[] }[] {
  const order: KeyBinding['category'][] = ['General', 'Query', 'View', 'Editor'];
  return order
    .map((category) => ({
      category,
      items: KEYMAP.filter((b) => b.category === category),
    }))
    .filter((s) => s.items.length > 0);
}

/**
 * Map a chord to a Monaco `addCommand` keybinding bitfield.
 * Accepts the monaco namespace so this module stays free of monaco types.
 */
/** Structural monaco namespace — avoids importing monaco types into shared/. */
export interface MonacoKeyNs {
  KeyMod: { CtrlCmd: number; Shift: number; Alt: number };
  KeyCode: {
    Enter: number;
    Escape: number;
    Period: number;
    Slash: number;
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
  if (key.length === 1 && /[a-z]/i.test(key)) {
    const name = `Key${key.toUpperCase()}` as keyof MonacoKeyNs['KeyCode'];
    const code = KeyCode[name];
    if (typeof code !== 'number') throw new Error(`monaco KeyCode missing: ${name}`);
    return code;
  }
  throw new Error(`unsupported monaco key: ${key}`);
}
