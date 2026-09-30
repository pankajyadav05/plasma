import { describe, expect, it } from 'vitest';
import {
  NO_SPLIT,
  type PaneState,
  activeIn,
  applyLayout,
  closePane,
  focusedActive,
  moveTab,
  noteActive,
  paneTabIds,
  parseLayout,
  prune,
  serializeLayout,
  splitRight,
  switchPane,
} from './pane-state';

const ids = ['a', 'b', 'c', 'd'];

describe('pane state', () => {
  it('starts unsplit and behaves like a single pane', () => {
    expect(paneTabIds(NO_SPLIT, ids, 'primary')).toEqual(ids);
    expect(paneTabIds(NO_SPLIT, ids, 'secondary')).toEqual([]);
    expect(switchPane(NO_SPLIT, 1)).toBe(NO_SPLIT);
    expect(closePane(NO_SPLIT, ids)).toBe(NO_SPLIT);
    expect(noteActive(NO_SPLIT, ids, 'b').secondary).toBeNull();
    expect(focusedActive(noteActive(NO_SPLIT, ids, 'b'), ids)).toBe('b');
  });

  it('splits the tab into the right pane and focuses it', () => {
    const s = splitRight(noteActive(NO_SPLIT, ids, 'a'), ids, 'c');
    expect(s.secondary).toEqual(['c']);
    expect(paneTabIds(s, ids, 'primary')).toEqual(['a', 'b', 'd']);
    expect(s.focus).toBe('secondary');
    expect(focusedActive(s, ids)).toBe('c');
    expect(activeIn(s, ids, 'primary')).toBe('a');
  });

  it('never empties the primary pane', () => {
    expect(splitRight(NO_SPLIT, ['a'], 'a')).toBe(NO_SPLIT);
    const s = splitRight(NO_SPLIT, ['a', 'b'], 'b');
    expect(moveTab(s, ['a', 'b'], 'a', 'secondary')).toBe(s);
  });

  it('moves tabs between panes with an index and collapses when the right pane empties', () => {
    let s = splitRight(NO_SPLIT, ids, 'c');
    s = moveTab(s, ids, 'd', 'secondary', 0);
    expect(s.secondary).toEqual(['d', 'c']);
    s = moveTab(s, ids, 'd', 'primary');
    expect(s.secondary).toEqual(['c']);
    expect(focusedActive(s, ids)).toBe('d');
    s = moveTab(s, ids, 'c', 'primary');
    expect(s.secondary).toBeNull();
    expect(s.focus).toBe('primary');
  });

  it('closing the pane returns its tabs to the primary strip', () => {
    const s = closePane(splitRight(NO_SPLIT, ids, 'c'), ids);
    expect(s.secondary).toBeNull();
    expect(paneTabIds(s, ids, 'primary')).toEqual(ids);
    expect(s.primaryActive).toBe('c');
  });

  it('switches pane focus in both directions and follows session activation', () => {
    let s = splitRight(NO_SPLIT, ids, 'c');
    s = switchPane(s, 1);
    expect(s.focus).toBe('primary');
    s = switchPane(s, -1);
    expect(s.focus).toBe('secondary');
    s = noteActive(s, ids, 'b');
    expect(s.focus).toBe('primary');
    expect(focusedActive(s, ids)).toBe('b');
    s = noteActive(s, ids, 'c');
    expect(s.focus).toBe('secondary');
  });

  it('prunes closed tabs and collapses an emptied pane', () => {
    const s = splitRight(NO_SPLIT, ids, 'c');
    expect(prune(s, ['a', 'b', 'd']).secondary).toBeNull();
    expect(prune(moveTab(s, ids, 'd', 'secondary'), ['a', 'b', 'c']).secondary).toEqual(['c']);
    expect(prune(s, ids)).toBe(s);
    expect(prune(s, ['c']).secondary).toBeNull();
  });

  it('round-trips through the persisted (index-based) layout', () => {
    const persistable = ['t1', 't2', 't3'];
    const s: PaneState = {
      secondary: ['t3'],
      secondaryActive: 't3',
      primaryActive: 't1',
      focus: 'secondary',
    };
    const layout = serializeLayout(s, persistable);
    expect(layout).toEqual({ secondary: [2], secondaryActive: 2, focus: 'secondary' });
    const fresh = ['n1', 'n2', 'n3'];
    const back = applyLayout(parseLayout(JSON.parse(JSON.stringify(layout))) as never, fresh, 'n1');
    expect(back).toEqual({
      secondary: ['n3'],
      secondaryActive: 'n3',
      primaryActive: 'n1',
      focus: 'secondary',
    });
    expect(serializeLayout(NO_SPLIT, persistable)).toBeNull();
    expect(parseLayout({ secondary: ['x'] })).toBeNull();
    expect(
      applyLayout({ secondary: [5], secondaryActive: 5, focus: 'primary' }, fresh, null),
    ).toEqual(NO_SPLIT);
  });
});
