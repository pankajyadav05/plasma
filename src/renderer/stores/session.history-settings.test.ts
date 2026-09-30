import { beforeEach, describe, expect, it, vi } from 'vitest';

const historyDelete = vi.fn(async () => undefined);
const clearApiKey = vi.fn();
const vaultSave = vi.fn(async () => ({}));
const vaultDuplicate = vi.fn();
const vaultList = vi.fn(async () => [{ id: 'copy', name: 'x copy' }]);
const settingsGet = vi.fn(async () => ({}));

vi.mock('@/lib/ipc', () => ({
  ipc: {
    history: {
      list: vi.fn(async () => []),
      clear: vi.fn(),
      delete: (...a: unknown[]) => historyDelete(...(a as [])),
    },
    settings: {
      get: () => settingsGet(),
      set: vi.fn(async () => ({})),
      clearApiKey: () => clearApiKey(),
    },
    vault: {
      list: () => vaultList(),
      save: (...a: unknown[]) => vaultSave(...(a as [])),
      duplicate: (...a: unknown[]) => vaultDuplicate(...(a as [])),
      delete: vi.fn(),
    },
    query: { run: vi.fn(), cancel: vi.fn() },
    conn: { connect: vi.fn(), disconnect: vi.fn(), test: vi.fn() },
    schema: { introspect: vi.fn() },
    txn: { begin: vi.fn(), commit: vi.fn(), rollback: vi.fn() },
    sql: { format: vi.fn() },
    ai: { ask: vi.fn(), cancel: vi.fn() },
  },
}));

import { useSession } from './session';

const entry = (id: number) => ({
  id,
  connectionId: 'c',
  sql: `select ${id}`,
  rowCount: 1,
  durationMs: 1,
  error: null,
  executedAt: id,
});

beforeEach(() => {
  historyDelete.mockClear();
  clearApiKey.mockReset();
  vaultSave.mockClear();
  vaultDuplicate.mockReset();
});

describe('history entry delete', () => {
  it('removes just that entry, in the db and in the store', async () => {
    useSession.setState({ history: [entry(1), entry(2), entry(3)] });
    await useSession.getState().deleteHistoryEntry(2);
    expect(historyDelete).toHaveBeenCalledWith(2);
    expect(useSession.getState().history.map((h) => h.id)).toEqual([1, 3]);
  });
});

describe('remove saved AI key', () => {
  it('replaces settings with the response (no key flags)', async () => {
    clearApiKey.mockResolvedValue({
      hasOpenrouterApiKey: false,
      hasClaudeApiKey: false,
      openrouterModel: 'm',
    });
    useSession.setState({
      settings: { ...useSession.getState().settings, hasOpenrouterApiKey: true },
    });
    await useSession.getState().clearAiApiKey();
    expect(clearApiKey).toHaveBeenCalled();
    expect(useSession.getState().settings.hasOpenrouterApiKey).toBe(false);
    expect(useSession.getState().settings.openrouterModel).toBe('m');
  });
});

describe('saved connections (C28)', () => {
  it('save-without-connect persists and refreshes the list', async () => {
    const cfg = {
      id: 'a',
      name: 'a',
      host: 'h',
      engine: 'postgres' as const,
      port: 1,
      database: '',
      user: '',
      password: '',
      ssl: false,
    };
    await useSession.getState().saveConnectionOnly(cfg);
    expect(vaultSave).toHaveBeenCalledWith(cfg);
    expect(useSession.getState().savedConnections).toEqual([{ id: 'copy', name: 'x copy' }]);
    expect(useSession.getState().connectionState).not.toBe('connected');
  });
  it('duplicate asks main for a copy then reloads list and settings', async () => {
    vaultDuplicate.mockResolvedValue({ id: 'copy', name: 'x copy' });
    const out = await useSession.getState().duplicateSaved('orig');
    expect(vaultDuplicate).toHaveBeenCalledWith('orig');
    expect(out.id).toBe('copy');
    expect(settingsGet).toHaveBeenCalled();
  });
});
