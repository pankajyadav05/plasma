import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';

// Minimal stand-in for the session store: just the fields the reconnect
// machine reads, and a connectSaved whose outcome each test scripts.
type FakeSession = {
  connectionState: 'idle' | 'connecting' | 'connected' | 'error';
  connectionError: string | null;
  connectionDiagnosis?: { cause: string; title: string } | null;
  connectionActionGate: unknown;
  activeConfig: { id: string } | null;
  pendingEditsByTab: Record<string, unknown[]>;
  settings: { autoReconnect: boolean };
  connectSaved: (id: string) => Promise<void>;
};

let outcomes: Array<'ok' | 'fail'> = [];
const connectSaved = vi.fn(async (id: string) => {
  const next = outcomes.shift() ?? 'fail';
  fakeSession.setState(
    next === 'ok'
      ? { connectionState: 'connected', connectionError: null, activeConfig: { id } }
      : { connectionState: 'error', connectionError: 'ECONNREFUSED' },
  );
});

const fakeSession = create<FakeSession>(() => ({
  connectionState: 'idle',
  connectionError: null,
  connectionActionGate: null,
  activeConfig: null,
  pendingEditsByTab: {},
  settings: { autoReconnect: true },
  connectSaved,
}));

vi.mock('./session', () => ({ useSession: fakeSession }));

const { RECONNECT_DELAYS_MS, useReconnect } = await import('./reconnect');
const target = { id: 'c1', name: 'Resilinc Admin' };

describe('reconnect machine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    outcomes = [];
    connectSaved.mockClear();
    fakeSession.setState({
      connectionState: 'idle',
      connectionError: null,
      connectionActionGate: null,
      activeConfig: null,
      pendingEditsByTab: {},
      settings: { autoReconnect: true },
    });
    useReconnect.getState().cancel();
  });

  afterEach(() => {
    useReconnect.getState().cancel();
    vi.useRealTimers();
  });

  it('launch connects immediately and settles idle on success', async () => {
    outcomes = ['ok'];
    useReconnect.getState().start(target, 'launch');
    await vi.waitFor(() => expect(useReconnect.getState().phase).toBe('idle'));
    expect(connectSaved).toHaveBeenCalledTimes(1);
    expect(useReconnect.getState().target).toBeNull();
  });

  it('a lost session waits the first backoff step before trying', async () => {
    outcomes = ['ok'];
    useReconnect.getState().start(target, 'lost');
    expect(useReconnect.getState().phase).toBe('waiting');
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0] - 1);
    expect(connectSaved).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(useReconnect.getState().phase).toBe('idle'));
    expect(connectSaved).toHaveBeenCalledTimes(1);
  });

  it('backs off through every step, then gives up and waits for a click', async () => {
    useReconnect.getState().start(target, 'lost');
    for (const delay of RECONNECT_DELAYS_MS) {
      await vi.advanceTimersByTimeAsync(delay);
    }
    await vi.waitFor(() => expect(useReconnect.getState().phase).toBe('failed'));
    expect(connectSaved).toHaveBeenCalledTimes(RECONNECT_DELAYS_MS.length);
    expect(useReconnect.getState().lastError).toBe('ECONNREFUSED');
    // A click still works after giving up.
    outcomes = ['ok'];
    await useReconnect.getState().reconnectNow();
    expect(useReconnect.getState().phase).toBe('idle');
  });

  it('keeps the plain-language diagnosis of the last failure for the banner', async () => {
    fakeSession.setState({ connectionDiagnosis: null });
    connectSaved.mockImplementationOnce(async () => {
      fakeSession.setState({
        connectionState: 'error',
        connectionError: 'Nothing is listening there. db:5432 refused the connection.',
        connectionDiagnosis: { cause: 'refused', title: 'Nothing is listening there' },
      });
    });
    useReconnect.getState().start(target, 'launch');
    await vi.waitFor(() => expect(useReconnect.getState().attempt).toBe(1));
    expect(useReconnect.getState().lastDiagnosis).toMatchObject({ cause: 'refused' });
    // A new run starts clean, and a good connection clears it.
    useReconnect.getState().cancel();
    expect(useReconnect.getState().lastDiagnosis).toBeNull();
  });

  it('with auto-reconnect off, a lost session only offers the click', async () => {
    fakeSession.setState({ settings: { autoReconnect: false } });
    useReconnect.getState().start(target, 'lost');
    expect(useReconnect.getState().phase).toBe('failed');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(connectSaved).not.toHaveBeenCalled();
  });

  it('never auto-connects over pending grid edits', async () => {
    fakeSession.setState({ pendingEditsByTab: { t: [{}] } });
    useReconnect.getState().start(target, 'lost');
    expect(useReconnect.getState().phase).toBe('failed');
    expect(useReconnect.getState().lastError).toMatch(/Unsaved edits/);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(connectSaved).not.toHaveBeenCalled();
  });

  it('cancel stops a scheduled retry', async () => {
    useReconnect.getState().start(target, 'lost');
    useReconnect.getState().cancel();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(connectSaved).not.toHaveBeenCalled();
    expect(useReconnect.getState().phase).toBe('idle');
  });

  it('connecting elsewhere (or main recovering) ends the retry loop', async () => {
    useReconnect.getState().start(target, 'lost');
    fakeSession.setState({ connectionState: 'connected', activeConfig: { id: 'other' } });
    expect(useReconnect.getState().phase).toBe('idle');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(connectSaved).not.toHaveBeenCalled();
  });
});
