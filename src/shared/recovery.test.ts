import { describe, expect, it } from 'vitest';
import {
  type RecoveryJournal,
  journalHasContent,
  judgePreviousExit,
  mayReloadAfterCrash,
  migrateJournal,
  parseJournal,
} from './recovery';

const journal = (over: Partial<RecoveryJournal> = {}): RecoveryJournal => ({
  v: 1,
  savedAt: 1_000,
  connectionId: 'c1',
  connectionName: 'Local',
  txnActive: false,
  strip: {
    v: 1,
    activeIndex: 0,
    tabs: [{ kind: 'sql', title: 'query-1.sql', sql: 'select 1' }],
  },
  edits: [],
  ...over,
});

describe('parseJournal', () => {
  it('reads what it wrote, from text or from a parsed value', () => {
    const j = journal({
      edits: [
        {
          tabIndex: 0,
          kind: 'update',
          schema: 'public',
          table: 'users',
          pkValues: { id: '1' },
          column: 'name',
          oldValue: 'ada',
          newValue: 'ADA',
        },
      ],
    });
    expect(parseJournal(JSON.stringify(j))).toEqual(j);
    expect(parseJournal(j)).toEqual(j);
  });

  it('ignores bad JSON, empty and non-object input', () => {
    for (const raw of ['', '{', 'null', '[]', '"x"', '42', null, undefined, 7]) {
      expect(parseJournal(raw)).toBeNull();
    }
  });

  it('ignores a truncated file (what a kill mid-write would leave without atomic rename)', () => {
    const text = JSON.stringify(journal());
    expect(parseJournal(text.slice(0, text.length - 7))).toBeNull();
  });

  it('ignores a format it does not know (newer, or none)', () => {
    expect(parseJournal({ ...journal(), v: 2 })).toBeNull();
    expect(parseJournal({ ...journal(), v: undefined })).toBeNull();
    expect(migrateJournal({ v: 99 })).toBeNull();
    expect(migrateJournal(journal())).toEqual(journal());
  });

  it('refuses a journal missing what restoring needs', () => {
    expect(parseJournal({ ...journal(), connectionId: '' })).toBeNull();
    expect(parseJournal({ ...journal(), strip: undefined })).toBeNull();
    expect(parseJournal({ ...journal(), edits: 'x' })).toBeNull();
    expect(parseJournal({ ...journal(), txnActive: 'no' })).toBeNull();
  });

  it('refuses an edit that is not plain text values (nothing executable gets in)', () => {
    const bad = journal({
      edits: [
        {
          tabIndex: 0,
          kind: 'update',
          schema: 's',
          table: 't',
          pkValues: { id: 1 as unknown as string },
          column: 'c',
          oldValue: null,
          newValue: 'x',
        },
      ],
    });
    expect(parseJournal(bad)).toBeNull();
    const badKind = journal({
      edits: [
        {
          tabIndex: 0,
          kind: 'truncate' as never,
          schema: 's',
          table: 't',
          pkValues: {},
          column: '',
          oldValue: null,
          newValue: null,
        },
      ],
    });
    expect(parseJournal(badKind)).toBeNull();
  });

  it('strips fields it does not know', () => {
    const parsed = parseJournal({ ...journal(), extra: 'x', sqlToRun: 'drop table users' });
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty('sqlToRun');
  });
});

describe('journalHasContent', () => {
  it('is false for one empty scratch tab', () => {
    expect(
      journalHasContent(
        journal({
          strip: { v: 1, activeIndex: 0, tabs: [{ kind: 'sql', title: 'q', sql: '  \n' }] },
        }),
      ),
    ).toBe(false);
  });
  it('is true with text, a table tab or a staged edit', () => {
    expect(journalHasContent(journal())).toBe(true);
    expect(
      journalHasContent(
        journal({
          strip: {
            v: 1,
            activeIndex: 0,
            tabs: [{ kind: 'table', title: 't', tableSchema: 'public', tableName: 't' }],
          },
        }),
      ),
    ).toBe(true);
  });
});

describe('judgePreviousExit', () => {
  const marker = JSON.stringify({ v: 1, pid: 10, startedAt: 5_000, version: '3.2.1' });

  it('no marker: the last run quit cleanly (or this is the first run)', () => {
    expect(judgePreviousExit(null, false)).toEqual({ kind: 'clean' });
  });

  it('a leftover marker is a crash, kill or power loss', () => {
    expect(judgePreviousExit(marker, false)).toEqual({
      kind: 'unclean',
      startedAt: 5_000,
      version: '3.2.1',
    });
  });

  it('an unreadable marker is still unclean (that is what a kill mid-write leaves)', () => {
    expect(judgePreviousExit('{"v":', false)).toEqual({
      kind: 'unclean',
      startedAt: null,
      version: null,
    });
    expect(judgePreviousExit('', false).kind).toBe('unclean');
  });

  it('an update restart is not a crash', () => {
    expect(judgePreviousExit(marker, true)).toEqual({ kind: 'update' });
  });
});

describe('mayReloadAfterCrash', () => {
  it('reloads the first few times, then stops', () => {
    let history: number[] = [];
    const out: boolean[] = [];
    for (const t of [0, 1_000, 2_000, 3_000]) {
      const r = mayReloadAfterCrash(history, t);
      history = r.history;
      out.push(r.reload);
    }
    expect(out).toEqual([true, true, true, false]);
  });

  it('forgives crashes older than the window', () => {
    const r = mayReloadAfterCrash([0, 1_000, 2_000], 120_000);
    expect(r.reload).toBe(true);
    expect(r.history).toEqual([120_000]);
  });
});
