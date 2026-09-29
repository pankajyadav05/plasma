import { describe, expect, it } from 'vitest';
import { SETTINGS_SECTIONS, sectionMatches } from './SettingsBody';

describe('settings sections (SS1)', () => {
  it('lists the TablePlus-style sections in order', () => {
    expect(SETTINGS_SECTIONS.map((s) => s.label)).toEqual([
      'General',
      'Editor',
      'Table & grid',
      'Fonts & themes',
      'Security',
      'AI',
      'Keymap',
      'Advanced',
    ]);
  });
  it('filters sections by label and keywords', () => {
    expect(sectionMatches('security', '')).toBe(true);
    expect(sectionMatches('security', 'timeout')).toBe(true);
    expect(sectionMatches('table', 'CSV')).toBe(true);
    expect(sectionMatches('ai', 'csv')).toBe(false);
  });
});
