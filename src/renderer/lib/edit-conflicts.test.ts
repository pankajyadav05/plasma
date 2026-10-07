import type { PendingEdit } from '@/stores/session-types';
import { describe, expect, it } from 'vitest';
import {
  type EditConflict,
  type TheirsLookup,
  type WorkerConflict,
  buildConflicts,
  canKeepMine,
  conflictSummary,
  keepMine,
  takeTheirs,
} from './edit-conflicts';

function edit(over: Partial<PendingEdit>): PendingEdit {
  return {
    id: 'e',
    tabId: 't',
    schema: 'public',
    table: 'users',
    kind: 'update',
    pkValues: { id: '1' },
    rowKey: '[["id","1"]]',
    column: 'name',
    oldValue: 'ada',
    oldType: 'text',
    newValue: 'mine',
    rowIndex: 0,
    columnIndex: 1,
    ...over,
  };
}

const theirsRow = [
  { column: 'id', value: '1', type: 'int4' },
  { column: 'name', value: 'theirs', type: 'text' },
  { column: 'age', value: '40', type: 'int4' },
];

function one(
  edits: PendingEdit[],
  lookup: TheirsLookup | undefined,
  reason: WorkerConflict['reason'] = 'no-match',
) {
  return buildConflicts({
    edits,
    batch: { editIds: [edits.map((e) => e.id)], updates: [{ kind: edits[0]?.kind }] },
    conflicts: [{ index: 0, reason }],
    theirs: new Map(lookup ? [[0, lookup]] : []),
  });
}

describe('buildConflicts', () => {
  it('shows original, mine and theirs per edited column', () => {
    const [c] = one([edit({ id: 'a' })], { found: true, row: theirsRow });
    expect(c).toMatchObject({
      kind: 'changed',
      op: 'update',
      rowLabel: 'id=1',
      editIds: ['a'],
      columns: [
        { column: 'name', original: 'ada', mine: 'mine', theirs: 'theirs', changedByOther: true },
      ],
    });
  });

  it('a row that no longer exists is "gone"', () => {
    const [c] = one([edit({ id: 'a' })], { found: false });
    expect(c?.kind).toBe('gone');
    expect(c?.theirsRow).toBeUndefined();
    expect(canKeepMine(c as EditConflict)).toBe(false);
  });

  it('an unreadable row is "unknown" and cannot be kept', () => {
    const [c] = one([edit({ id: 'a' })], { error: 'boom' });
    expect(c?.kind).toBe('unknown');
    expect(canKeepMine(c as EditConflict)).toBe(false);
    expect(one([edit({ id: 'a' })], undefined)[0]?.kind).toBe('unknown');
  });

  it('a delete lists only the columns that moved', () => {
    const del = edit({
      id: 'd',
      kind: 'delete',
      column: '',
      oldValue: null,
      newValue: null,
      originalRow: [
        { column: 'id', value: '1' },
        { column: 'name', value: 'ada' },
        { column: 'age', value: '40' },
      ],
    });
    const [c] = one([del], { found: true, row: theirsRow });
    expect(c?.op).toBe('delete');
    expect(c?.columns.map((x) => x.column)).toEqual(['name']);
  });

  it('a duplicate INSERT lists the values it would add', () => {
    const ins = edit({
      id: 'i',
      kind: 'insert',
      pkValues: {},
      column: '',
      values: { id: '1', name: 'x' },
    });
    const [c] = one([ins], undefined, 'duplicate');
    expect(c).toMatchObject({ kind: 'duplicate', op: 'insert', rowLabel: 'new row' });
    expect(c?.columns.map((x) => x.mine)).toEqual(['1', 'x']);
  });

  it('every flagged statement becomes one item', () => {
    const e1 = edit({ id: 'a' });
    const e2 = edit({ id: 'b', pkValues: { id: '2' }, rowKey: '[["id","2"]]' });
    const out = buildConflicts({
      edits: [e1, e2],
      batch: { editIds: [['a'], ['b']], updates: [{ kind: 'update' }, { kind: 'update' }] },
      conflicts: [
        { index: 0, reason: 'no-match' },
        { index: 1, reason: 'no-match' },
      ],
      theirs: new Map<number, TheirsLookup>([
        [0, { found: true, row: theirsRow }],
        [1, { found: false }],
      ]),
    });
    expect(out.map((c) => c.kind)).toEqual(['changed', 'gone']);
    expect(new Set(out.map((c) => c.id)).size).toBe(2);
  });
});

describe('resolving', () => {
  const e = edit({ id: 'a' });
  const other = edit({ id: 'z', pkValues: { id: '9' }, rowKey: '[["id","9"]]' });
  const conflict = (): EditConflict => one([e], { found: true, row: theirsRow })[0] as EditConflict;

  it('keep mine re-stages against the server values and leaves other rows alone', () => {
    const next = keepMine([e, other], conflict());
    expect(next[0]).toMatchObject({ id: 'a', oldValue: 'theirs', newValue: 'mine' });
    expect(next[0]?.unguarded).toBeUndefined();
    expect(next[1]).toBe(other);
  });

  it('keep mine over a difference the guard cannot explain stops comparing that edit', () => {
    const same = { column: 'name', value: 'ada', type: 'text' };
    const c = one([e], { found: true, row: [theirsRow[0] as (typeof theirsRow)[0], same] })[0];
    expect(keepMine([e], c as EditConflict)[0]?.unguarded).toBe(true);
  });

  it('keep mine on a delete takes the server row as the new original', () => {
    const del = edit({
      id: 'd',
      kind: 'delete',
      column: '',
      originalRow: [
        { column: 'id', value: '1' },
        { column: 'name', value: 'ada' },
      ],
    });
    const c = one([del], { found: true, row: theirsRow })[0] as EditConflict;
    const next = keepMine([del], c)[0];
    expect(next?.originalRow?.map((x) => x.value)).toEqual(['1', 'theirs', '40']);
  });

  it('keep mine is refused for a gone row (nothing to update)', () => {
    const c = one([e], { found: false })[0] as EditConflict;
    expect(keepMine([e], c)).toEqual([e]);
  });

  it('take theirs drops that row’s edits only', () => {
    expect(takeTheirs([e, other], conflict())).toEqual([other]);
  });
});

describe('conflictSummary', () => {
  it('says what happened and what to do', () => {
    const base: Omit<EditConflict, 'id' | 'kind'> = {
      op: 'update',
      schema: 's',
      table: 't',
      rowLabel: '',
      editIds: [],
      columns: [],
    };
    const text = conflictSummary([
      { ...base, id: '1', kind: 'changed' },
      { ...base, id: '2', kind: 'changed' },
      { ...base, id: '3', kind: 'gone' },
      { ...base, id: '4', kind: 'duplicate' },
    ]);
    expect(text).toBe(
      '2 rows were changed by someone else; 1 row was deleted; 1 new row uses a key that already exists. Review them to continue.',
    );
  });
});
