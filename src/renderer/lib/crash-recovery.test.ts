import type { PendingEdit } from '@/stores/session-types';
import { type RecoveryJournal, parseJournal } from '@shared/recovery';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fromRecoveredEdit,
  onRecoveryTargetChanged,
  pickJournalToResume,
  recoveryNotice,
  resetPendingRecoveries,
  restoreEdits,
  setPendingRecoveries,
  takeRecoveryFor,
  toRecoveredEdit,
  unrestorableNotice,
} from './crash-recovery';

const rowKeyOf = (pk: Record<string, unknown>) => JSON.stringify(Object.entries(pk).sort());

function edit(over: Partial<PendingEdit> = {}): PendingEdit {
  return {
    id: 'e1',
    tabId: 'tab-a',
    schema: 'public',
    table: 'users',
    kind: 'update',
    pkValues: { id: '1' },
    rowKey: rowKeyOf({ id: '1' }),
    column: 'name',
    oldValue: 'ada',
    oldType: 'text',
    newValue: 'ADA',
    rowIndex: 3,
    columnIndex: 1,
    connectionGen: 4,
    ...over,
  };
}

describe('toRecoveredEdit / fromRecoveredEdit', () => {
  it('round-trips an update with its original value, and survives JSON', () => {
    const r = toRecoveredEdit(edit(), 2);
    const back = JSON.parse(JSON.stringify(r));
    const e = fromRecoveredEdit(back, 'tab-new', 9, 'new-id', rowKeyOf);
    expect(e).toMatchObject({
      id: 'new-id',
      tabId: 'tab-new',
      kind: 'update',
      column: 'name',
      oldValue: 'ada',
      oldType: 'text',
      newValue: 'ADA',
      pkValues: { id: '1' },
      rowKey: rowKeyOf({ id: '1' }),
      connectionGen: 9,
    });
  });

  it('keeps NULL as NULL and empty string as empty string', () => {
    const a = toRecoveredEdit(edit({ oldValue: null, newValue: '' }), 0);
    expect(a.oldValue).toBeNull();
    expect(a.newValue).toBe('');
  });

  it('a delete carries the row it was staged from as text, never the raw row', () => {
    const del = edit({
      kind: 'delete',
      column: '',
      oldValue: [1, 'ada', new Uint8Array([1, 2]), 10n] as unknown,
      newValue: null,
      originalRow: [
        { column: 'id', value: '1', type: 'int4' },
        { column: 'name', value: 'ada', type: 'text' },
      ],
    });
    const r = toRecoveredEdit(del, 0);
    expect(() => JSON.stringify(r)).not.toThrow();
    expect(r.oldValue).toBeNull();
    expect(r.originalRow).toHaveLength(2);
    const back = fromRecoveredEdit(r, 't', 1, 'i', rowKeyOf);
    expect(back.originalRow?.[1]).toEqual({ column: 'name', value: 'ada', type: 'text' });
  });

  it('an insert keeps its values and has no row key', () => {
    const ins = edit({ kind: 'insert', pkValues: {}, column: '', values: { id: '9', name: null } });
    const back = fromRecoveredEdit(toRecoveredEdit(ins, 0), 't', 1, 'i', rowKeyOf);
    expect(back.values).toEqual({ id: '9', name: null });
    expect(back.rowKey).toBeUndefined();
  });

  it('never persists "unguarded": a restored edit is always compared again', () => {
    const back = fromRecoveredEdit(
      toRecoveredEdit(edit({ unguarded: true }), 0),
      't',
      1,
      'i',
      rowKeyOf,
    );
    expect(back.unguarded).toBeUndefined();
    expect(toRecoveredEdit(edit({ unguarded: true }), 0)).not.toHaveProperty('unguarded');
  });

  it('what it writes is accepted by the journal parser', () => {
    const j = {
      v: 1,
      savedAt: 1,
      connectionId: 'c',
      txnActive: false,
      strip: { v: 1, activeIndex: 0, tabs: [{ kind: 'table', title: 'users' }] },
      edits: [toRecoveredEdit(edit(), 0), toRecoveredEdit(edit({ kind: 'delete', column: '' }), 0)],
    };
    expect(parseJournal(JSON.parse(JSON.stringify(j)))).not.toBeNull();
  });
});

describe('restoreEdits', () => {
  it('re-attaches edits to the tab their position became, stamped with the live generation', () => {
    const edits = [toRecoveredEdit(edit(), 0), toRecoveredEdit(edit({ column: 'age' }), 1)];
    let n = 0;
    const res = restoreEdits(
      edits,
      new Map([
        [0, 'A'],
        [1, 'B'],
      ]),
      7,
      () => `id-${n++}`,
      rowKeyOf,
    );
    expect(Object.keys(res.byTab).sort()).toEqual(['A', 'B']);
    expect(res.byTab.A?.[0]).toMatchObject({ id: 'id-0', tabId: 'A', connectionGen: 7 });
    expect(res.byTab.B?.[0]?.column).toBe('age');
    expect(res.restored).toBe(2);
    expect(res.orphans).toEqual([]);
  });

  it('an edit whose tab did not come back is returned, not dropped', () => {
    const res = restoreEdits(
      [toRecoveredEdit(edit(), 5)],
      new Map([[0, 'A']]),
      1,
      () => 'x',
      rowKeyOf,
    );
    expect(res.restored).toBe(0);
    expect(res.orphans).toHaveLength(1);
    expect(res.orphans[0]?.table).toBe('users');
  });
});

describe('what is said', () => {
  it('names what came back', () => {
    expect(recoveryNotice({ cause: 'exit', tabs: 4, edits: 3, txnActive: false })).toEqual({
      title: 'Plasma closed unexpectedly',
      detail:
        'Restored 4 tabs and 3 unsaved edits. Staged edits are not committed until you commit them.',
    });
  });

  it('is singular where it should be, and reports a rolled-back transaction', () => {
    const n = recoveryNotice({ cause: 'exit', tabs: 1, edits: 1, txnActive: true });
    expect(n.detail).toContain('Restored 1 tab and 1 unsaved edit.');
    expect(n.detail).toContain('open transaction was rolled back');
  });

  it('a window crash says so', () => {
    expect(recoveryNotice({ cause: 'renderer', tabs: 2, edits: 0, txnActive: false }).title).toBe(
      'The Plasma window crashed and was reloaded',
    );
  });

  it('says what could not be restored and that it is kept', () => {
    const j = {
      connectionName: 'Staging',
      edits: [{}, {}] as RecoveryJournal['edits'],
      strip: { v: 1, activeIndex: 0, tabs: [{}] } as RecoveryJournal['strip'],
    };
    const n = unrestorableNotice(j);
    expect(n.detail).toContain('1 tab and 2 unsaved edits');
    expect(n.detail).toContain('“Staging”');
    expect(n.detail).toContain('kept');
  });
});

describe('pending snapshots', () => {
  afterEach(resetPendingRecoveries);
  const j = (id: string, savedAt: number): RecoveryJournal => ({
    v: 1,
    savedAt,
    connectionId: id,
    txnActive: false,
    strip: { v: 1, activeIndex: 0, tabs: [] },
    edits: [],
  });

  it('hands a connection its snapshot once', () => {
    setPendingRecoveries({
      unclean: true,
      cause: 'exit',
      announce: [],
      journals: [j('a', 1), j('b', 2)],
      hasLog: false,
    });
    expect(takeRecoveryFor('b')?.savedAt).toBe(2);
    expect(takeRecoveryFor('b')).toBeNull();
    expect(takeRecoveryFor('zzz')).toBeNull();
    expect(takeRecoveryFor(null)).toBeNull();
    expect(takeRecoveryFor('a')?.savedAt).toBe(1);
  });

  it('resumes the newest snapshot whose connection can be reached', () => {
    const all = [j('old', 1), j('gone', 9), j('new', 5)];
    expect(pickJournalToResume(all, (id) => id !== 'gone')?.connectionId).toBe('new');
    expect(pickJournalToResume(all, () => false)).toBeNull();
  });
});

describe('more notices (P2-3, P2-1, P2-7)', () => {
  it('says edits from an interrupted commit may already be saved', () => {
    const n = recoveryNotice({
      cause: 'exit',
      tabs: 1,
      edits: 3,
      txnActive: false,
      maybeCommitted: 2,
    });
    expect(n.detail).toContain(
      '2 edits were being committed when Plasma stopped and may already be saved',
    );
    expect(n.detail).toContain('Check the data before committing');
    expect(n.detail).not.toContain('not committed until you commit');
  });

  it('names what could not be saved: edits and over-size SQL tabs', () => {
    const n = recoveryNotice({
      cause: 'exit',
      tabs: 2,
      edits: 1,
      txnActive: false,
      omitted: { tabs: ['huge.sql'], edits: 2 },
    });
    expect(n.detail).toContain('2 edits could not be saved');
    expect(n.detail).toContain('1 SQL tab (huge.sql) was too large to save');
  });

  it('a leftover snapshot restored on a clean launch is not called a crash', () => {
    expect(recoveryNotice({ cause: null, tabs: 1, edits: 0, txnActive: false }).title).toBe(
      'Restored unsaved work from an earlier session',
    );
  });

  it('maybeCommitted survives the round trip', () => {
    const r = toRecoveredEdit(edit({ maybeCommitted: true }), 0);
    expect(r.maybeCommitted).toBe(true);
    expect(fromRecoveredEdit(r, 't', 1, 'i', rowKeyOf).maybeCommitted).toBe(true);
  });
});

describe('a snapshot taken against another target (P2-6)', () => {
  afterEach(resetPendingRecoveries);
  const target = { engine: 'postgres', host: 'h', port: 5432, database: 'prod', user: 'u' };
  const j = (): RecoveryJournal => ({
    v: 1,
    savedAt: 1,
    connectionId: 'c',
    txnActive: false,
    target,
    strip: { v: 1, activeIndex: 0, tabs: [] },
    edits: [],
  });
  const info = () => ({
    unclean: true,
    cause: 'exit' as const,
    journals: [j()],
    announce: [],
    hasLog: false,
  });

  it('is applied when the connection still points at the same place', () => {
    setPendingRecoveries(info());
    expect(takeRecoveryFor('c', { ...target })).not.toBeNull();
  });

  it('is never applied when host or database changed; the shell is told instead', () => {
    const seen: RecoveryJournal[] = [];
    onRecoveryTargetChanged((x) => seen.push(x));
    setPendingRecoveries(info());
    expect(takeRecoveryFor('c', { ...target, database: 'staging' })).toBeNull();
    expect(seen).toHaveLength(1);
    onRecoveryTargetChanged(null);
  });
});
