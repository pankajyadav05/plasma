import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { requestExternalChange, submitAiActionResult } from './ai';

type Evt = { kind: string; [k: string]: unknown };

function fakeWindow() {
  const events: Evt[] = [];
  const win = {
    isDestroyed: () => false,
    webContents: { send: (_ch: string, evt: Evt) => events.push(evt) },
  };
  return { win: win as never, events };
}

const base = (win: never, over: Record<string, unknown> = {}) => ({
  win,
  client: 'Claude Code',
  connectionId: 'c1',
  sql: 'update orders set paid = true where id = 1',
  summary: 'mark paid',
  signal: new AbortController().signal,
  timeoutMs: 5_000,
  ...over,
});

const settle = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => vi.useRealTimers());

describe('requestExternalChange (MCP propose_change through the in-app approval card)', () => {
  it('opens a labelled thread, shows the propose_change card and returns the card result', async () => {
    const { win, events } = fakeWindow();
    const p = requestExternalChange(base(win));
    await settle();
    expect(events[0]).toMatchObject({
      kind: 'external',
      client: 'Claude Code',
      connectionId: 'c1',
    });
    const action = events[1] as Evt;
    expect(action).toMatchObject({
      kind: 'action',
      name: 'propose_change',
      args: { sql: 'update orders set paid = true where id = 1', summary: 'mark paid' },
    });
    const { requestId, callId } = action as unknown as { requestId: string; callId: string };
    expect(requestId).toMatch(/^mcp-/);
    expect(
      submitAiActionResult({ requestId, callId, outcome: 'applied', note: '1 row affected.' }),
    ).toBe(true);
    const out = await p;
    expect(out).toEqual({
      kind: 'answered',
      res: { requestId, callId, outcome: 'applied', note: '1 row affected.' },
    });
    expect(events.at(-1)).toEqual({ kind: 'done', requestId });
  });

  it('refuses an invalid or read-only statement without ever asking the user', async () => {
    const { win, events } = fakeWindow();
    const reads = await requestExternalChange(base(win, { sql: 'select 1' }));
    expect(reads.kind).toBe('refused');
    const several = await requestExternalChange(base(win, { sql: 'delete from a; delete from b' }));
    expect(several.kind).toBe('refused');
    expect(events).toHaveLength(0);
  });

  it('is refused when there is no window, and while another proposal waits', async () => {
    expect((await requestExternalChange(base(null as never))).kind).toBe('refused');
    const { win } = fakeWindow();
    const ctl = new AbortController();
    const first = requestExternalChange(base(win, { signal: ctl.signal }));
    await settle();
    const second = await requestExternalChange(base(win));
    expect(second).toMatchObject({ kind: 'refused' });
    ctl.abort();
    expect(await first).toEqual({ kind: 'cancelled' });
    // the slot is free again
    const again = requestExternalChange(base(win, { timeoutMs: 1 }));
    expect(await again).toEqual({ kind: 'timeout' });
  });

  it('times out after 10 minutes of silence and closes the thread', async () => {
    vi.useFakeTimers();
    const { win, events } = fakeWindow();
    const p = requestExternalChange(base(win, { timeoutMs: 10 * 60_000 }));
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
    expect(await p).toEqual({ kind: 'timeout' });
    expect(events.at(-1)).toMatchObject({ kind: 'done' });
    // a late answer is ignored
    const { requestId, callId } = events[1] as unknown as { requestId: string; callId: string };
    expect(submitAiActionResult({ requestId, callId, outcome: 'applied' })).toBe(false);
  });

  it('is cancelled when the MCP call is aborted (client left, or the server closed)', async () => {
    const { win, events } = fakeWindow();
    const ctl = new AbortController();
    const p = requestExternalChange(base(win, { signal: ctl.signal }));
    await settle();
    ctl.abort();
    expect(await p).toEqual({ kind: 'cancelled' });
    expect(events.at(-1)).toMatchObject({ kind: 'done' });
  });
});
