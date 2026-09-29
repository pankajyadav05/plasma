import type { SchemaInfo } from '@shared/protocol';
import { describe, expect, it } from 'vitest';
import { buildEntityRows, rowName, treeKeyAction } from './entity-tree';

const ALL = new Set([
  'table',
  'view',
  'matview',
  'foreign',
  'partitioned',
  'function',
  'procedure',
  'sequence',
  'type',
  'extension',
]);

function info(): SchemaInfo {
  const t = (
    name: string,
    kind: SchemaInfo['tables'][number]['kind'] = 'table',
    parent?: string,
  ) => ({
    schema: 'public',
    name,
    kind,
    rowCountEstimate: null,
    partitionOf: parent ? { schema: 'public', name: parent } : null,
  });
  return {
    schemas: [{ name: 'public' }, { name: 'other' }],
    tables: [
      t('users'),
      t('accounts'),
      t('events', 'partitioned'),
      t('events_2025', 'table', 'events'),
      t('events_2026', 'table', 'events'),
      t('active_users', 'view'),
      {
        schema: 'other',
        name: 'elsewhere',
        kind: 'table',
        rowCountEstimate: null,
        partitionOf: null,
      },
    ],
    columns: [],
    foreignKeys: [],
    routines: [
      {
        schema: 'public',
        name: 'add',
        kind: 'function',
        args: 'a integer',
        returns: 'integer',
        oid: 1,
      },
      { schema: 'public', name: 'cleanup', kind: 'procedure', args: '', returns: null, oid: 2 },
    ],
    sequences: [{ schema: 'public', name: 'users_id_seq' }],
    types: [{ schema: 'public', name: 'mood', kind: 'enum', values: ['a'] }],
    extensions: [{ name: 'pg_trgm', schema: 'public', version: '1.6' }],
  };
}

const base = {
  currentSchema: 'public',
  filter: ALL,
  search: '',
  favorites: new Set<string>(),
  expanded: new Set<string>(),
};

describe('buildEntityRows', () => {
  it('lists relations by name, hides partitions, then collapsed sections', () => {
    const rows = buildEntityRows({ ...base, schema: info() });
    expect(rows.map(rowName)).toEqual([
      'accounts',
      'active_users',
      'events',
      'users',
      'Functions',
      'Procedures',
      'Sequences',
      'Types',
      'Extensions',
    ]);
    const events = rows.find((r) => rowName(r) === 'events');
    expect(events?.type === 'relation' && events.childCount).toBe(2);
  });

  it('puts favourites first (PC1)', () => {
    const rows = buildEntityRows({ ...base, schema: info(), favorites: new Set(['public.users']) });
    expect(rowName(rows[0]!)).toBe('users');
  });

  it('nests partitions under an expanded parent', () => {
    const rows = buildEntityRows({
      ...base,
      schema: info(),
      expanded: new Set(['rel:public.events']),
    });
    const names = rows.map(rowName);
    const i = names.indexOf('events');
    expect(names.slice(i + 1, i + 3)).toEqual(['events_2025', 'events_2026']);
    expect(rows[i + 1]?.level).toBe(2);
    expect(rows[i + 1]?.parentKey).toBe('rel:public.events');
  });

  it('expands sections on demand', () => {
    const rows = buildEntityRows({ ...base, schema: info(), expanded: new Set(['sec:function']) });
    const names = rows.map(rowName);
    expect(names.slice(names.indexOf('Functions'), names.indexOf('Functions') + 2)).toEqual([
      'Functions',
      'add',
    ]);
  });

  it('fuzzy-searches relations, partitions and section items', () => {
    const rows = buildEntityRows({ ...base, schema: info(), search: 'ev26' });
    expect(rows.map(rowName)).toEqual(['events_2026']);
    const fn = buildEntityRows({ ...base, schema: info(), search: 'add' });
    expect(fn.map(rowName)).toEqual(['Functions', 'add']);
  });

  it('respects the kind filter', () => {
    const rows = buildEntityRows({
      ...base,
      schema: info(),
      filter: new Set(['view', 'extension']),
    });
    expect(rows.map(rowName)).toEqual(['active_users', 'Extensions']);
  });
});

describe('treeKeyAction', () => {
  const rows = buildEntityRows({ ...base, schema: info(), expanded: new Set(['sec:function']) });
  const idx = (name: string) => rows.findIndex((r) => rowName(r) === name);

  it('moves with arrows / Home / End and clamps', () => {
    expect(treeKeyAction(rows, 0, 'ArrowDown')).toEqual({ kind: 'focus', index: 1 });
    expect(treeKeyAction(rows, 0, 'ArrowUp')).toEqual({ kind: 'focus', index: 0 });
    expect(treeKeyAction(rows, 3, 'Home')).toEqual({ kind: 'focus', index: 0 });
    expect(treeKeyAction(rows, 0, 'End')).toEqual({ kind: 'focus', index: rows.length - 1 });
  });

  it('expands, steps into and collapses sections', () => {
    expect(treeKeyAction(rows, idx('Procedures'), 'ArrowRight')).toEqual({
      kind: 'expand',
      key: 'sec:procedure',
    });
    expect(treeKeyAction(rows, idx('Functions'), 'ArrowRight')).toEqual({
      kind: 'focus',
      index: idx('add'),
    });
    expect(treeKeyAction(rows, idx('Functions'), 'ArrowLeft')).toEqual({
      kind: 'collapse',
      key: 'sec:function',
    });
    expect(treeKeyAction(rows, idx('add'), 'ArrowLeft')).toEqual({
      kind: 'focus',
      index: idx('Functions'),
    });
  });

  it('activates on Enter and ignores other keys', () => {
    expect(treeKeyAction(rows, 2, 'Enter')).toEqual({ kind: 'activate', index: 2 });
    expect(treeKeyAction(rows, 2, 'x')).toBeNull();
    expect(treeKeyAction(rows, idx('users'), 'ArrowRight')).toBeNull();
  });
});
