import type { SavedQuery } from '@shared/protocol';
import { describe, expect, it } from 'vitest';
import {
  patchSavedQuery,
  replaceSavedQuery,
  savedQueryFolders,
  savedQueryFromTab,
} from './session-saved-queries';

const sqlTab = {
  kind: 'sql',
  sql: 'select 1',
  pageSize: 50,
  filters: [],
  tableSort: [],
  hiddenColumns: new Set<string>(),
  stickyColumns: new Set<string>(),
};

const q = (id: string, extra: Partial<SavedQuery> = {}): SavedQuery =>
  ({
    kind: 'sql',
    id,
    name: id,
    createdAt: 1,
    updatedAt: 1,
    sql: 'x',
    pageSize: 50,
    ...extra,
  }) as SavedQuery;

describe('savedQueryFromTab', () => {
  it('snapshots a SQL tab', () => {
    expect(savedQueryFromTab(sqlTab, { id: 'a', name: 'A', now: 5 })).toEqual({
      kind: 'sql',
      id: 'a',
      name: 'A',
      createdAt: 5,
      updatedAt: 5,
      sql: 'select 1',
      pageSize: 50,
    });
  });

  it('keeps variable values only for the placeholders the SQL still uses', () => {
    const entry = savedQueryFromTab(
      {
        ...sqlTab,
        sql: 'select * from t where a = :a',
        queryVars: { a: { mode: 'number', value: '5' }, gone: { mode: 'text', value: 'x' } },
      },
      { id: 'a', name: 'A', now: 5 },
    );
    expect(entry).toMatchObject({ variables: { a: { mode: 'number', value: '5' } } });
    expect((entry as { variables: object }).variables).not.toHaveProperty('gone');
    expect(savedQueryFromTab(sqlTab, { id: 'b', name: 'B', now: 5 })).not.toHaveProperty(
      'variables',
    );
  });

  it('keeps createdAt / folder / favourite when updating in place', () => {
    const base = q('a', { createdAt: 1, folder: 'Reports', favorite: true });
    const next = savedQueryFromTab(
      { ...sqlTab, sql: 'select 2' },
      { id: 'a', name: 'a', now: 9 },
      base,
    );
    expect(next).toMatchObject({
      id: 'a',
      createdAt: 1,
      updatedAt: 9,
      folder: 'Reports',
      favorite: true,
      sql: 'select 2',
    });
  });

  it('snapshots a table tab', () => {
    const next = savedQueryFromTab(
      {
        ...sqlTab,
        kind: 'table',
        tableSchema: 'public',
        tableName: 'users',
        filters: [{ id: 'f', column: 'id', op: '=', value: '1' }],
        hiddenColumns: new Set(['email']),
      },
      { id: 't', name: 'T', now: 2 },
    );
    expect(next).toMatchObject({
      kind: 'table',
      tableSchema: 'public',
      tableName: 'users',
      hidden: ['email'],
    });
  });
});

describe('patchSavedQuery', () => {
  const list = [q('a'), q('b', { folder: 'F' })];

  it('renames, moves and favourites', () => {
    const next = patchSavedQuery(
      list,
      'a',
      { name: ' New ', folder: 'Reports', favorite: true },
      7,
    );
    expect(next[0]).toMatchObject({ name: 'New', folder: 'Reports', favorite: true, updatedAt: 7 });
    expect(next[1]).toBe(list[1]);
  });

  it('clears folder / favourite', () => {
    const next = patchSavedQuery(list, 'b', { folder: null }, 7);
    expect(next[1]).not.toHaveProperty('folder');
  });

  it('returns the same list for no-op patches', () => {
    expect(patchSavedQuery(list, 'a', { name: '  ' }, 7)).toBe(list);
    expect(patchSavedQuery(list, 'a', { favorite: false }, 7)).toBe(list);
    expect(patchSavedQuery(list, 'zzz', { name: 'x' }, 7)).toBe(list);
  });
});

describe('replaceSavedQuery / savedQueryFolders', () => {
  it('replaces in place, keeping order', () => {
    const list = [q('a'), q('b'), q('c')];
    const next = replaceSavedQuery(list, q('b', { sql: 'new' } as Partial<SavedQuery>));
    expect(next.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect((next[1] as { sql: string }).sql).toBe('new');
  });

  it('lists distinct sorted folders', () => {
    expect(
      savedQueryFolders([
        q('a', { folder: 'b' }),
        q('b', { folder: 'a' }),
        q('c', { folder: 'b' }),
        q('d'),
      ]),
    ).toEqual(['a', 'b']);
  });
});
