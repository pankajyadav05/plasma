import { describe, expect, it } from 'vitest';
import { changedSettings, settingsValueEqual } from './settings-changed';

describe('settingsValueEqual', () => {
  it('treats identical primitives as equal', () => {
    expect(settingsValueEqual(1, 1)).toBe(true);
    expect(settingsValueEqual('a', 'a')).toBe(true);
    expect(settingsValueEqual(true, true)).toBe(true);
    expect(settingsValueEqual(null, null)).toBe(true);
  });

  it('treats distinct primitives as unequal', () => {
    expect(settingsValueEqual(1, 2)).toBe(false);
    expect(settingsValueEqual('a', 'b')).toBe(false);
    expect(settingsValueEqual(true, false)).toBe(false);
  });

  it('deep-compares plain objects via JSON', () => {
    expect(settingsValueEqual({ a: 1, b: [2] }, { a: 1, b: [2] })).toBe(true);
    expect(settingsValueEqual({ a: 1 }, { a: 2 })).toBe(false);
  });
});

describe('changedSettings', () => {
  it('returns empty when nothing changed', () => {
    const prev = { theme: 'dark', editorFontSize: 14 };
    expect(changedSettings(prev, { ...prev })).toEqual({});
  });

  it('returns only keys whose values changed', () => {
    const prev = {
      theme: 'light',
      openrouterApiKey: 'old',
      connectionTags: { a: 'prod' },
      editorFontSize: 14,
    };
    const next = {
      theme: 'light',
      openrouterApiKey: 'new',
      connectionTags: { a: 'prod' },
      editorFontSize: 16,
    };
    expect(changedSettings(prev, next)).toEqual({
      openrouterApiKey: 'new',
      editorFontSize: 16,
    });
  });

  it('detects nested object changes', () => {
    const prev = { connectionTags: { a: 'prod' as const } };
    const next = { connectionTags: { a: 'staging' as const } };
    expect(changedSettings(prev, next)).toEqual({
      connectionTags: { a: 'staging' },
    });
  });

  it('treats missing prev key as a change', () => {
    expect(changedSettings({}, { theme: 'dark' })).toEqual({ theme: 'dark' });
  });
});
