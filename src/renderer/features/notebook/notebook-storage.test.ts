import { describe, expect, it } from 'vitest';
import {
  type DraftStorage,
  LEGACY_DRAFT_KEY,
  draftKey,
  hasCellContent,
  loadDraft,
  parseCells,
  saveDraft,
} from './notebook-storage';

function memStorage(
  init: Record<string, string> = {},
): DraftStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
    removeItem: (k) => {
      data.delete(k);
    },
  };
}

const cellA = { id: 'a', kind: 'sql' as const, content: 'select 1' };
const cellB = { id: 'b', kind: 'md' as const, content: '# hi' };

describe('draftKey', () => {
  it('keys per connection with a fallback', () => {
    expect(draftKey('c1')).toBe('plasma.notebook.draft:c1');
    expect(draftKey(undefined)).toBe('plasma.notebook.draft:default');
    expect(draftKey(null)).toBe('plasma.notebook.draft:default');
    expect(draftKey('c1')).not.toBe(draftKey('c2'));
  });
});

describe('parseCells', () => {
  it('drops malformed entries and runtime fields', () => {
    const raw = JSON.stringify([
      { ...cellA, result: { rows: [] }, running: true },
      { id: 1, kind: 'sql', content: 'x' },
      { id: 'z', kind: 'py', content: 'x' },
      null,
      { id: 'c', kind: 'md' },
    ]);
    expect(parseCells(raw)).toEqual([cellA, { id: 'c', kind: 'md', content: '' }]);
  });
  it('tolerates garbage', () => {
    expect(parseCells(null)).toEqual([]);
    expect(parseCells('{nope')).toEqual([]);
    expect(parseCells('{"a":1}')).toEqual([]);
  });
});

describe('loadDraft / saveDraft', () => {
  it('keeps connections separate', () => {
    const s = memStorage();
    saveDraft(s, 'c1', [cellA]);
    saveDraft(s, 'c2', [cellB]);
    expect(loadDraft(s, 'c1')).toEqual([cellA]);
    expect(loadDraft(s, 'c2')).toEqual([cellB]);
    expect(loadDraft(s, 'c3')).toEqual([]);
  });

  it('migrates the legacy global draft once, then removes it', () => {
    const s = memStorage({ [LEGACY_DRAFT_KEY]: JSON.stringify([cellA]) });
    expect(loadDraft(s, 'c1')).toEqual([cellA]);
    expect(s.data.has(LEGACY_DRAFT_KEY)).toBe(false);
    expect(parseCells(s.data.get(draftKey('c1')) ?? null)).toEqual([cellA]);
    // Another connection does not inherit it.
    expect(loadDraft(s, 'c2')).toEqual([]);
  });

  it('does not overwrite an existing per-connection draft with the legacy one', () => {
    const s = memStorage({
      [LEGACY_DRAFT_KEY]: JSON.stringify([cellA]),
      [draftKey('c1')]: JSON.stringify([cellB]),
    });
    expect(loadDraft(s, 'c1')).toEqual([cellB]);
    expect(s.data.has(LEGACY_DRAFT_KEY)).toBe(true);
  });

  it('saving an empty draft removes the key', () => {
    const s = memStorage();
    saveDraft(s, 'c1', [cellA]);
    saveDraft(s, 'c1', []);
    expect(s.data.has(draftKey('c1'))).toBe(false);
  });

  it('survives throwing storage', () => {
    const s: DraftStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadDraft(s, 'c1')).toEqual([]);
    expect(() => saveDraft(s, 'c1', [cellA])).not.toThrow();
  });
});

describe('hasCellContent', () => {
  it('ignores whitespace-only cells', () => {
    expect(hasCellContent([])).toBe(false);
    expect(hasCellContent([{ content: '  \n' }])).toBe(false);
    expect(hasCellContent([{ content: '' }, { content: 'x' }])).toBe(true);
  });
});
