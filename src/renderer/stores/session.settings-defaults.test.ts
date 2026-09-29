import { beforeEach, describe, expect, it, vi } from 'vitest';

// A main process built before newer settings existed (e.g. `pnpm dev`
// hot-reloads the renderer but keeps the old main running) returns
// settings objects without the new keys.
const staleSettings = { theme: 'dark', themeName: 'default', sidebarWidth: 264 };
const settingsGet = vi.fn(async () => staleSettings);
const settingsSet = vi.fn(async () => staleSettings);

vi.mock('@/lib/ipc', () => ({
  ipc: {
    settings: {
      get: (...a: unknown[]) => settingsGet(...(a as [])),
      set: (...a: unknown[]) => settingsSet(...(a as [])),
    },
  },
}));

// loadSettings / updateSettings apply the theme to <html>; give the node
// test environment just enough DOM for that to succeed.
const noop = () => {};
vi.stubGlobal('document', {
  documentElement: {
    classList: { toggle: noop, add: noop, remove: noop, contains: () => false },
    style: { setProperty: noop, removeProperty: noop },
  },
});
vi.stubGlobal('window', { dispatchEvent: noop });
vi.stubGlobal('CustomEvent', class {});

import { useSession, withDefaults } from './session';

describe('settings defaults when main is older than the renderer', () => {
  beforeEach(() => {
    settingsGet.mockClear();
    settingsSet.mockClear();
  });

  it('loadSettings fills keys main did not send', async () => {
    await useSession.getState().loadSettings();
    const s = useSession.getState().settings;
    expect(s.rightSidebarWidth).toBe(300);
    expect(s.autoReconnect).toBe(true);
    expect(s.autoConnectOnLaunch).toBe(true);
    expect(s.lastConnectionId).toBeNull();
    // Values main did send win over defaults.
    expect(s.sidebarWidth).toBe(264);
    expect(s.theme).toBe('dark');
  });

  it('updateSettings keeps the defaults too', async () => {
    await useSession.getState().updateSettings({ theme: 'dark' });
    expect(useSession.getState().settings.rightSidebarWidth).toBe(300);
  });

  it('width setters ignore non-finite input instead of storing NaN', () => {
    useSession.getState().setRightSidebarWidth(420);
    useSession.getState().setRightSidebarWidth(Number.NaN);
    expect(useSession.getState().settings.rightSidebarWidth).toBe(420);
    useSession.getState().setSidebarWidth(300);
    useSession.getState().setSidebarWidth(Number.NaN);
    expect(useSession.getState().settings.sidebarWidth).toBe(300);
  });

  it('withDefaults does not let undefined values erase defaults', () => {
    expect(withDefaults({ rightSidebarWidth: undefined }).rightSidebarWidth).toBe(300);
  });
});
