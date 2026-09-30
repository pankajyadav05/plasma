import { describe, expect, it } from 'vitest';
import {
  type ColumnState,
  EMPTY_MODEL,
  changeCount,
  diffToChanges,
  effectiveColumns,
  isEmptyModel,
  setColumnEdit,
  usingHint,
  withSchema,
} from './structure-edits';

const col = (over: Partial<ColumnState> & { name: string }): ColumnState => ({
  type: 'text',
  nullable: true,
  default: '',
  comment: '',
  primaryKey: false,
  ...over,
});
const original = [
  col({ name: 'id', type: 'integer', nullable: false, primaryKey: true }),
  col({ name: 'age', type: 'text', default: "'0'::text" }),
  col({ name: 'note' }),
];

describe('setColumnEdit', () => {
  it('records a change and clears it when reverted', () => {
    let m = setColumnEdit(EMPTY_MODEL, original[1] as ColumnState, 'nullable', false);
    expect(m.columnEdits.age).toEqual({ nullable: false });
    m = setColumnEdit(m, original[1] as ColumnState, 'nullable', true);
    expect(m.columnEdits).toEqual({});
    expect(isEmptyModel(m)).toBe(true);
  });
  it('drops a USING expression when the type edit is reverted', () => {
    let m = setColumnEdit(EMPTY_MODEL, original[1] as ColumnState, 'type', 'integer');
    m = setColumnEdit(m, original[1] as ColumnState, 'using', 'age::integer');
    expect(m.columnEdits.age).toEqual({ type: 'integer', using: 'age::integer' });
    m = setColumnEdit(m, original[1] as ColumnState, 'type', 'text');
    expect(m.columnEdits).toEqual({});
  });
});

describe('diffToChanges', () => {
  it('orders drops, adds, alters, renames, then constraints and indexes', () => {
    let m = EMPTY_MODEL;
    m = {
      ...m,
      droppedColumns: ['note'],
      droppedIndexes: ['old_idx'],
      droppedConstraints: ['old_fk'],
    };
    m = { ...m, addedColumns: [{ name: 'x', type: 'int', nullable: true }] };
    m = setColumnEdit(m, original[0] as ColumnState, 'name', 'pk');
    m = setColumnEdit(m, original[0] as ColumnState, 'comment', 'the key');
    m = {
      ...m,
      addedIndexes: [{ columns: ['pk'] }],
      addedConstraints: [{ type: 'unique', columns: ['x'] }],
    };
    const kinds = diffToChanges(original, m).map((c) => c.kind);
    expect(kinds).toEqual([
      'dropConstraint',
      'dropIndex',
      'dropColumn',
      'addColumn',
      'setComment',
      'renameColumn',
      'addConstraint',
      'addIndex',
    ]);
  });
  it('a type change temporarily drops and restores an existing default', () => {
    let m = setColumnEdit(EMPTY_MODEL, original[1] as ColumnState, 'type', 'integer');
    m = setColumnEdit(m, original[1] as ColumnState, 'using', 'age::integer');
    expect(diffToChanges(original, m)).toEqual([
      { kind: 'setDefault', name: 'age', type: 'text', default: null },
      { kind: 'alterType', name: 'age', type: 'integer', using: 'age::integer' },
      { kind: 'setDefault', name: 'age', type: 'integer', default: "'0'::text" },
    ]);
  });
  it('an explicit default edit wins over the restore', () => {
    let m = setColumnEdit(EMPTY_MODEL, original[1] as ColumnState, 'type', 'integer');
    m = setColumnEdit(m, original[1] as ColumnState, 'default', '5');
    const c = diffToChanges(original, m);
    expect(c.map((x) => x.kind)).toEqual(['alterType', 'setDefault']);
    expect(c[1]).toMatchObject({ default: '5', type: 'integer' });
  });
  it('clearing a default becomes DROP DEFAULT; a blank comment clears the comment', () => {
    let m = setColumnEdit(EMPTY_MODEL, original[1] as ColumnState, 'default', '');
    m = setColumnEdit(m, original[2] as ColumnState, 'comment', ' ');
    expect(diffToChanges(original, m)).toEqual([
      { kind: 'setDefault', name: 'age', type: 'text', default: null },
      { kind: 'setComment', name: 'note', comment: null },
    ]);
  });
  it('skips edits of dropped columns', () => {
    let m = setColumnEdit(EMPTY_MODEL, original[2] as ColumnState, 'nullable', false);
    m = { ...m, droppedColumns: ['note'] };
    expect(diffToChanges(original, m)).toEqual([{ kind: 'dropColumn', name: 'note' }]);
  });
  it('fills in the schema for dropped indexes', () => {
    const c = withSchema(
      diffToChanges(original, { ...EMPTY_MODEL, droppedIndexes: ['ix'] }),
      'sales',
    );
    expect(c).toEqual([{ kind: 'dropIndex', schema: 'sales', name: 'ix' }]);
  });
});

describe('effectiveColumns / changeCount / usingHint', () => {
  it('reflects renames, drops and additions', () => {
    let m = setColumnEdit(EMPTY_MODEL, original[1] as ColumnState, 'name', 'years');
    m = {
      ...m,
      droppedColumns: ['note'],
      addedColumns: [{ name: 'z', type: 'int', nullable: false, primaryKey: true }],
    };
    expect(effectiveColumns(original, m).map((c) => c.name)).toEqual(['id', 'years', 'z']);
    expect(effectiveColumns(original, m)[2]).toMatchObject({ nullable: false, primaryKey: true });
    expect(changeCount(m)).toBe(3);
  });
  it('hints a cast only across type families', () => {
    expect(usingHint('a', 'text', 'integer')).toBe('a::integer');
    expect(usingHint('a', 'integer', 'bigint')).toBe('');
    expect(usingHint('a', 'text', 'not a type;')).toBe('');
  });
});
