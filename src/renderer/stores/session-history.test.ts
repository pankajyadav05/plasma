import { describe, expect, it, vi } from 'vitest';

const list = vi.fn();

vi.mock('@/lib/ipc', () => ({
  ipc: {
    history: { list: (...a: unknown[]) => list(...a), clear: vi.fn(), delete: vi.fn() },
    settings: { get: vi.fn(), set: vi.fn(async () => undefined) },
    vault: { list: vi.fn(async () => []) },
    query: { run: vi.fn(), cancel: vi.fn() },
  },
}));

import { useSession } from './session';

const entry = (id: number, sql: string) => ({
  id,
  connectionId: 'c',
  sql,
  rowCount: 1,
  durationMs: 1,
  error: null,
  executedAt: id,
});

describe('loadHistory ordering (R-29)', () => {
  it('drops an older response that resolves after a newer one', async () => {
    let resolveOld!: (v: unknown) => void;
    list
      .mockReturnValueOnce(
        new Promise((r) => {
          resolveOld = r;
        }),
      )
      .mockResolvedValueOnce([entry(2, 'select new')]);
    const first = useSession.getState().loadHistory({ search: 'ol' });
    const second = useSession.getState().loadHistory({ search: 'new' });
    await second;
    expect(useSession.getState().history.map((h) => h.sql)).toEqual(['select new']);
    resolveOld([entry(1, 'select old')]);
    await first;
    expect(useSession.getState().history.map((h) => h.sql)).toEqual(['select new']);
  });
});
