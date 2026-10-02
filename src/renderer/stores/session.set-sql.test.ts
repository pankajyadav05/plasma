import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ipc', () => ({
  ipc: {
    query: { run: vi.fn(), cancel: vi.fn(async () => undefined) },
    settings: { get: vi.fn(), set: vi.fn(async () => undefined) },
    history: { list: vi.fn(async () => []) },
    vault: { list: vi.fn(async () => []) },
  },
}));

import { useSession } from './session';

beforeEach(() => {
  const first = useSession.getState().tabs[0]!;
  useSession.setState({
    tabs: [
      {
        ...first,
        kind: 'sql',
        sql: 'SELECT oops',
        queryErrorRange: { start: 7, end: 11 },
        queryRunningRange: { start: 0, end: 11 },
      },
    ],
    activeTabId: first.id,
  });
});

describe('setSql (R-15)', () => {
  it('clears stale error / running markers once the text changes', () => {
    useSession.getState().setSql('SELECT ok');
    const tab = useSession.getState().tabs[0]!;
    expect(tab.sql).toBe('SELECT ok');
    expect(tab.queryErrorRange).toBeNull();
    expect(tab.queryRunningRange).toBeNull();
  });

  it('keeps them when the text is unchanged', () => {
    useSession.getState().setSql('SELECT oops');
    expect(useSession.getState().tabs[0]!.queryErrorRange).toEqual({ start: 7, end: 11 });
  });
});
