import { beforeEach, describe, expect, it, vi } from 'vitest';

const settingsSet = vi.fn();

vi.mock('@/lib/ipc', () => ({
  ipc: {
    settings: {
      get: vi.fn(),
      set: (...a: unknown[]) => settingsSet(...a),
      clearApiKey: vi.fn(),
    },
    history: { list: vi.fn(async () => []) },
    vault: { list: vi.fn(async () => []) },
    query: { run: vi.fn(), cancel: vi.fn() },
  },
}));

import { useSession } from './session';
import { DEFAULT_SETTINGS, mergeResponse } from './session-settings';

describe('mergeResponse (R-17)', () => {
  it('takes touched keys and has* flags from the response, keeps the rest', () => {
    const current = { ...DEFAULT_SETTINGS, sidebarWidth: 400, hasOpenrouterApiKey: false };
    const response = {
      ...DEFAULT_SETTINGS,
      sidebarWidth: 250,
      defaultPageSize: 300,
      hasOpenrouterApiKey: true,
    };
    const merged = mergeResponse(current, response, ['defaultPageSize']);
    expect(merged.defaultPageSize).toBe(300);
    expect(merged.sidebarWidth).toBe(400);
    expect(merged.hasOpenrouterApiKey).toBe(true);
  });
});

describe('updateSettings does not roll back concurrent optimistic writes (R-17)', () => {
  beforeEach(() => {
    settingsSet.mockReset();
  });

  it('keeps a saved query added while the write was in flight', async () => {
    let finish!: (v: unknown) => void;
    settingsSet.mockReturnValue(
      new Promise((r) => {
        finish = r;
      }),
    );
    const pending = useSession.getState().updateSettings({ defaultPageSize: 500 });
    // Meanwhile an optimistic writer adds a saved query and widens the sidebar.
    useSession.setState((s) => ({
      settings: {
        ...s.settings,
        sidebarWidth: 333,
        savedQueries: [{ id: 'q', name: 'new', sql: 'select 1' }] as never,
      },
    }));
    // The (older) response knows nothing about either.
    finish({ ...DEFAULT_SETTINGS, defaultPageSize: 500, sidebarWidth: 260, savedQueries: [] });
    await pending;
    const s = useSession.getState().settings;
    expect(s.defaultPageSize).toBe(500);
    expect(s.sidebarWidth).toBe(333);
    expect(s.savedQueries).toHaveLength(1);
  });
});
