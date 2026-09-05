import { describe, expect, it } from 'vitest';
import {
  KEYMAP,
  accelerator,
  binding,
  cheatSheetSections,
  formatChord,
  matchGlobalBinding,
  matchesBinding,
  matchesChord,
} from './keymap';

function ev(partial: {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}) {
  return {
    key: partial.key,
    metaKey: partial.metaKey ?? false,
    ctrlKey: partial.ctrlKey ?? false,
    shiftKey: partial.shiftKey ?? false,
    altKey: partial.altKey ?? false,
  };
}

describe('keymap', () => {
  it('binds ⌘K to the command palette and ⌘L to the AI panel', () => {
    expect(binding('palette').chord).toEqual({ key: 'k', mod: true });
    expect(binding('toggleAi').chord).toEqual({ key: 'l', mod: true });
    expect(accelerator('palette')).toBe('CmdOrCtrl+K');
    expect(accelerator('toggleAi')).toBe('CmdOrCtrl+L');
    expect(accelerator('cheatSheet')).toBe('CmdOrCtrl+/');
  });

  it('does not let palette and AI share a chord', () => {
    const chords = KEYMAP.filter((b) => b.id === 'palette' || b.id === 'toggleAi').map(
      (b) => `${b.chord.mod}-${b.chord.shift}-${b.chord.key}`,
    );
    expect(new Set(chords).size).toBe(chords.length);
  });

  it('matches mod+key case-insensitively and rejects stray shift', () => {
    expect(matchesBinding(ev({ key: 'k', metaKey: true }), 'palette')).toBe(true);
    expect(matchesBinding(ev({ key: 'K', ctrlKey: true }), 'palette')).toBe(true);
    expect(matchesBinding(ev({ key: 'k', metaKey: true, shiftKey: true }), 'palette')).toBe(false);
    expect(matchesBinding(ev({ key: 'l', metaKey: true }), 'toggleAi')).toBe(true);
    expect(matchesBinding(ev({ key: 'k', metaKey: true }), 'toggleAi')).toBe(false);
  });

  it('matches shift chords exactly', () => {
    expect(matchesBinding(ev({ key: 'g', metaKey: true, shiftKey: true }), 'codegen')).toBe(true);
    expect(matchesBinding(ev({ key: 'g', metaKey: true }), 'codegen')).toBe(false);
  });

  it('binds ⌘⏎ to smart run and ⌘⇧⏎ to run-all', () => {
    expect(binding('runQuery').chord).toEqual({ key: 'Enter', mod: true });
    expect(binding('runQueryAll').chord).toEqual({ key: 'Enter', mod: true, shift: true });
    expect(accelerator('runQuery')).toBe('CmdOrCtrl+Return');
    expect(accelerator('runQueryAll')).toBe('CmdOrCtrl+Shift+Return');
    expect(matchesBinding(ev({ key: 'Enter', metaKey: true }), 'runQuery')).toBe(true);
    expect(matchesBinding(ev({ key: 'Enter', metaKey: true, shiftKey: true }), 'runQueryAll')).toBe(
      true,
    );
    expect(matchesBinding(ev({ key: 'Enter', metaKey: true, shiftKey: true }), 'runQuery')).toBe(
      false,
    );
  });

  it('resolves a global binding and skips editor-scoped chords', () => {
    expect(matchGlobalBinding(ev({ key: 'k', metaKey: true }))?.id).toBe('palette');
    expect(matchGlobalBinding(ev({ key: '/', metaKey: true }))?.id).toBe('cheatSheet');
    // formatSql is editor-scoped — global matcher must ignore it
    expect(matchGlobalBinding(ev({ key: 'f', metaKey: true, shiftKey: true }))).toBeUndefined();
  });

  it('formats chords for mac and non-mac', () => {
    expect(formatChord({ key: 'k', mod: true }, true)).toBe('⌘K');
    expect(formatChord({ key: 'l', mod: true }, true)).toBe('⌘L');
    expect(formatChord({ key: 'f', mod: true, shift: true }, true)).toBe('⌘⇧F');
    expect(formatChord({ key: 'f', mod: true, shift: true }, false)).toBe('Ctrl+Shift+F');
    expect(formatChord({ key: '/', mod: true }, true)).toBe('⌘/');
    expect(formatChord({ key: 'Enter', mod: true }, true)).toBe('⌘⏎');
  });

  it('builds cheat-sheet sections covering every binding without drift', () => {
    const sections = cheatSheetSections();
    const ids = sections.flatMap((s) => s.items.map((i) => i.id));
    expect(ids.sort()).toEqual([...KEYMAP.map((b) => b.id)].sort());
    expect(sections.map((s) => s.category)).toEqual(['General', 'Query', 'View', 'Editor']);
  });

  it('matchesChord requires mod when declared', () => {
    expect(matchesChord(ev({ key: 'k' }), { key: 'k', mod: true })).toBe(false);
    expect(matchesChord(ev({ key: 'Escape' }), { key: 'Escape' })).toBe(true);
  });
});
