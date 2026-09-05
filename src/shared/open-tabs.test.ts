import { describe, expect, it } from 'vitest';
import { isTabDirty, serializeSnapshot, serializeTab } from './open-tabs';

describe('serializeTab', () => {
  it('keeps sql plaintext and drops transient fields', () => {
    const tab = serializeTab({
      id: 't1',
      title: 'q.sql',
      kind: 'sql',
      sql: "SELECT 'secret'",
      pageSize: 50,
      tableSort: [],
      filters: [],
      hiddenColumns: new Set(),
      stickyColumns: new Set(),
      viewMode: 'data',
    });
    expect(tab.sql).toBe("SELECT 'secret'");
    expect(tab.kind).toBe('sql');
    expect(tab).not.toHaveProperty('queryResult');
  });

  it('persists table filter/sort/hidden state', () => {
    const tab = serializeTab({
      id: 't2',
      title: 'users',
      kind: 'table',
      sql: '',
      pageSize: 100,
      tableSchema: 'public',
      tableName: 'users',
      tableSort: [{ column: 'id', direction: 'desc' }],
      filters: [{ id: 'f1', column: 'email', op: 'ILIKE', value: '%@' }],
      hiddenColumns: new Set(['password']),
      stickyColumns: new Set(['id']),
      viewMode: 'data',
    });
    expect(tab.tableSchema).toBe('public');
    expect(tab.tableName).toBe('users');
    expect(tab.tableSort).toEqual([{ column: 'id', direction: 'desc' }]);
    expect(tab.filters?.[0]?.column).toBe('email');
    expect(tab.hiddenColumns).toEqual(['password']);
    expect(tab.stickyColumns).toEqual(['id']);
  });
});

describe('serializeSnapshot', () => {
  it('round-trips active tab id', () => {
    const snap = serializeSnapshot(
      [
        {
          id: 'a',
          title: 'a.sql',
          kind: 'sql',
          sql: 'select 1',
          pageSize: 50,
          tableSort: [],
          filters: [],
          hiddenColumns: [],
          stickyColumns: [],
          viewMode: 'data',
        },
        {
          id: 'b',
          title: 'b.sql',
          kind: 'sql',
          sql: '',
          pageSize: 50,
          tableSort: [],
          filters: [],
          hiddenColumns: [],
          stickyColumns: [],
          viewMode: 'data',
        },
      ],
      'b',
    );
    expect(snap.activeTabId).toBe('b');
    expect(snap.tabs).toHaveLength(2);
  });
});

describe('isTabDirty', () => {
  it('is clean when sql matches baseline', () => {
    expect(
      isTabDirty({ sql: 'select 1', kind: 'sql' }, { sql: 'select 1' }),
    ).toBe(false);
  });

  it('is dirty when sql diverges', () => {
    expect(
      isTabDirty({ sql: 'select 2', kind: 'sql' }, { sql: 'select 1' }),
    ).toBe(true);
  });
});
