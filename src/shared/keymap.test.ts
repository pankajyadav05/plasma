import { describe, expect, it } from 'vitest';
import {
  KEYMAP,
  accelerator,
  binding,
  cheatSheetSections,
  formatBinding,
  formatChord,
  formatKeys,
  matchGlobalBinding,
  matchesBinding,
  matchesChord,
  selectTabIndex,
} from './keymap';

function ev(partial: {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}) {
  return {
    key: partial.key,
    code: partial.code,
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
    expect(sections.map((s) => s.category)).toEqual([
      'General',
      'Query',
      'Tabs',
      'View',
      'Editor',
      'Grid',
    ]);
  });

  it('filters the cheat-sheet by label or keys', () => {
    const ids = cheatSheetSections('wrap').flatMap((s) => s.items.map((i) => i.id));
    expect(ids).toEqual(['wordWrap']);
    expect(cheatSheetSections('zzz-nothing')).toEqual([]);
  });

  it('matchesChord requires mod when declared', () => {
    expect(matchesChord(ev({ key: 'k' }), { key: 'k', mod: true })).toBe(false);
    expect(matchesChord(ev({ key: 'Escape' }), { key: 'Escape' })).toBe(true);
  });

  it('matches shifted bracket chords by physical key', () => {
    // US layout: ⇧] reports key "}" — the code is what identifies it.
    expect(
      matchesBinding(
        ev({ key: '}', code: 'BracketRight', metaKey: true, shiftKey: true }),
        'nextTab',
      ),
    ).toBe(true);
    expect(
      matchesBinding(
        ev({ key: '{', code: 'BracketLeft', ctrlKey: true, shiftKey: true }),
        'prevTab',
      ),
    ).toBe(true);
    expect(matchesBinding(ev({ key: '}', code: 'BracketRight', metaKey: true }), 'nextTab')).toBe(
      false,
    );
    expect(matchGlobalBinding(ev({ key: 'B', metaKey: true, shiftKey: true }))?.id).toBe(
      'toggleRightSidebar',
    );
  });

  it('formats glyph strings per platform (K5)', () => {
    expect(formatKeys('⌘⇧F', true)).toBe('⌘⇧F');
    expect(formatKeys('⌘⇧F', false)).toBe('Ctrl+Shift+F');
    expect(formatKeys('⇧F', false)).toBe('Shift+F');
    expect(formatKeys('⌘⏎', false)).toBe('Ctrl+Enter');
    expect(formatKeys('Esc', false)).toBe('Esc');
    expect(formatKeys('⌥← / ⌥→', false)).toBe('Alt+← / Alt+→');
    expect(formatKeys('Tab / ⇧Tab', false)).toBe('Tab / Shift+Tab');
    expect(formatChord({ key: 'Enter', mod: true }, false)).toBe('Ctrl+Enter');
    expect(formatChord({ key: 'z', alt: true }, true)).toBe('⌥Z');
    expect(formatBinding('gridMove', false)).toBe('↑ ↓ ← →');
    expect(formatBinding('settings', true)).toBe('⌘,');
  });

  it('adds the standard shortcuts (K3) as global bindings', () => {
    expect(matchGlobalBinding(ev({ key: ',', metaKey: true }))?.id).toBe('settings');
    expect(matchGlobalBinding(ev({ key: 's', ctrlKey: true }))?.id).toBe('commitEdits');
    expect(matchGlobalBinding(ev({ key: 'S', ctrlKey: true, shiftKey: true }))?.id).toBe(
      'saveFileAs',
    );
    expect(matchGlobalBinding(ev({ key: 'r', metaKey: true }))?.id).toBe('refresh');
    expect(matchGlobalBinding(ev({ key: 'w', metaKey: true }))?.id).toBe('closeTab');
    // Documentation-only grid keys are never dispatched globally.
    expect(matchGlobalBinding(ev({ key: 'c', metaKey: true }))).toBeUndefined();
    expect(matchGlobalBinding(ev({ key: 'Escape' }))).toBeUndefined();
  });

  it('accepts alternate chords and physical keys for alt letters', () => {
    expect(matchesBinding(ev({ key: 'i', metaKey: true }), 'formatSql')).toBe(true);
    expect(matchesBinding(ev({ key: 'F', ctrlKey: true, shiftKey: true }), 'formatSql')).toBe(true);
    expect(matchesBinding(ev({ key: 'Ω', code: 'KeyZ', altKey: true }), 'wordWrap')).toBe(true);
  });

  it('resolves ⌘1…⌘9 to a tab index', () => {
    expect(selectTabIndex(ev({ key: '1', metaKey: true }))).toBe(0);
    expect(selectTabIndex(ev({ key: '9', ctrlKey: true }))).toBe(8);
    expect(
      selectTabIndex(ev({ key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true })),
    ).toBeNull();
    expect(selectTabIndex(ev({ key: '1' }))).toBeNull();
  });

  it('never gives two dispatched bindings the same chord', () => {
    const seen = new Map<string, string>();
    for (const b of KEYMAP.filter((k) => k.scope === 'global' || k.scope === 'editor')) {
      for (const c of [b.chord, ...(b.altChords ?? [])]) {
        const key = `${b.scope === 'global' ? 'g' : 'e'}:${!!c.mod}${!!c.shift}${!!c.alt}${c.key.toLowerCase()}`;
        expect(seen.get(key), `${b.id} vs ${seen.get(key)}`).toBeUndefined();
        seen.set(key, b.id);
      }
    }
  });
});
