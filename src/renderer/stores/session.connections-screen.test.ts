import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ipc', () => ({
  ipc: {
    settings: { get: vi.fn(), set: vi.fn(async (p: unknown) => p) },
    history: { list: vi.fn(async () => []), clear: vi.fn(), latest: vi.fn() },
  },
}));

import { useSession } from './session';

describe('Connections screen routing', () => {
  beforeEach(() => {
    useSession.setState({
      canvasMode: 'database',
      dialogOpen: false,
      dialogPrefill: null,
      canvasModeBeforeConnections: 'database',
    });
  });

  it('openDialog shows the screen and closeDialog returns to the previous canvas', () => {
    useSession.setState({ canvasMode: 'monitor' });
    useSession.getState().openDialog();
    expect(useSession.getState().canvasMode).toBe('connections');
    expect(useSession.getState().dialogOpen).toBe(true);
    useSession.getState().closeDialog();
    expect(useSession.getState().canvasMode).toBe('monitor');
    expect(useSession.getState().dialogOpen).toBe(false);
  });

  it('opening twice keeps the first previous canvas and bumps the nonce', () => {
    useSession.setState({ canvasMode: 'settings' });
    const before = useSession.getState().dialogNonce;
    useSession.getState().openDialog();
    useSession.getState().openDialog();
    expect(useSession.getState().dialogNonce).toBe(before + 2);
    useSession.getState().closeDialog();
    expect(useSession.getState().canvasMode).toBe('settings');
  });

  it('switching canvas from the rail clears the screen state', () => {
    useSession.getState().openDialog();
    useSession.getState().setCanvasMode('settings');
    expect(useSession.getState().canvasMode).toBe('settings');
    expect(useSession.getState().dialogOpen).toBe(false);
  });
});
