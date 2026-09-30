import { describe, expect, it } from 'vitest';
import { existingGroups, groupConnections, normaliseGroup } from './connection-groups';

const c = (id: string, group?: string) => ({ id, group });

describe('groupConnections', () => {
  it('puts ungrouped first, then folders alphabetically, keeping input order', () => {
    const out = groupConnections([
      c('a', 'Zed'),
      c('b'),
      c('c', 'alpha'),
      c('d', ' zed '),
      c('e', '  '),
    ]);
    expect(out.map((g) => [g.group, g.items.map((i) => i.id)])).toEqual([
      [null, ['b', 'e']],
      ['alpha', ['c']],
      ['Zed', ['a', 'd']],
    ]);
  });
  it('returns nothing for an empty list', () => {
    expect(groupConnections([])).toEqual([]);
  });
});

describe('existingGroups / normaliseGroup', () => {
  it('lists distinct folders case-insensitively', () => {
    expect(existingGroups([c('a', 'Prod'), c('b', 'prod'), c('c'), c('d', 'Dev')])).toEqual([
      'Dev',
      'Prod',
    ]);
    expect(normaliseGroup('  ')).toBeNull();
    expect(normaliseGroup(' x ')).toBe('x');
  });
});
