import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import {
  cancelAllAiChats,
  markExternalApproved,
  startExternalAction,
  submitAiActionResult,
} from './ai';

type Evt = { kind: string; [k: string]: unknown };

function fakeWindow() {
  const events: Evt[] = [];
  const win = {
    isDestroyed: () => false,
    webContents: { send: (_ch: string, evt: Evt) => events.push(evt) },
  };
  return { win: win as never, events };
}

const change = (win: never, over: Record<string, unknown> = {}) =>
  startExternalAction({
    win,
    client: 'Claude Code',
    connectionId: 'c1',
    name: 'propose_change',
    args: { sql: 'update orders set paid = true where id = 1', summary: 'mark paid' },
    ...over,
  });

const started = (r: ReturnType<typeof change>) => {
  if (!r.ok) throw new Error(r.note);
  return r.action;
};

afterEach(() => {
  cancelAllAiChats();
  vi.useRealTimers();
});

describe('startExternalAction (MCP proposals through the in-app approval card)', () => {
  it('opens a labelled thread, shows the propose_change card and returns the card result', async () => {
    const { win, events } = fakeWindow();
    const a = started(change(win));
    expect(events[0]).toMatchObject({
      kind: 'external',
      client: 'Claude Code',
      connectionId: 'c1',
    });
    expect(events[1]).toMatchObject({
      kind: 'action',
      name: 'propose_change',
      args: { sql: 'update orders set paid = true where id = 1', summary: 'mark paid' },
    });
    expect(a.requestId).toMatch(/^mcp-/);
    const res = {
      requestId: a.requestId,
      callId: a.callId,
      outcome: 'applied' as const,
      note: '1 row affected.',
    };
    expect(submitAiActionResult(res)).toBe(true);
    expect(await a.result).toEqual(res);
    // The thread closes only after the answer.
    expect(events.at(-1)).toEqual({ kind: 'done', requestId: a.requestId });
  });

  it('shows a remember card for a note', () => {
    const { win, events } = fakeWindow();
    started(change(win, { name: 'remember', args: { text: 'amount is in cents' } }));
    expect(events[1]).toMatchObject({ name: 'remember', args: { text: 'amount is in cents' } });
  });

  it('refuses an invalid or read-only statement without ever asking the user', () => {
    const { win, events } = fakeWindow();
    expect(change(win, { args: { sql: 'select 1', summary: '' } }).ok).toBe(false);
    expect(change(win, { args: { sql: 'delete from a; delete from b', summary: '' } }).ok).toBe(
      false,
    );
    expect(change(null as never).ok).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('withdraws an undecided card: the renderer is told, and its answer settles it', async () => {
    const { win, events } = fakeWindow();
    const a = started(change(win));
    expect(a.withdraw('Withdrawn: the request expired.')).toBe(true);
    expect(events.at(-1)).toMatchObject({
      kind: 'withdraw',
      reason: 'Withdrawn: the request expired.',
    });
    submitAiActionResult({
      requestId: a.requestId,
      callId: a.callId,
      outcome: 'cancelled',
      note: 'Withdrawn: the request expired.',
    });
    expect((await a.result).outcome).toBe('cancelled');
  });

  it('answers a withdrawn card itself when the renderer is gone', async () => {
    vi.useFakeTimers();
    const { win } = fakeWindow();
    const a = started(change(win));
    a.withdraw('Withdrawn: the request expired.');
    await vi.advanceTimersByTimeAsync(5_001);
    expect((await a.result).outcome).toBe('cancelled');
  });

  it('after Approve nothing withdraws it: not a withdrawal, not a timer, only the real answer', async () => {
    vi.useFakeTimers();
    const { win, events } = fakeWindow();
    const a = started(change(win));
    expect(markExternalApproved(a.requestId, a.callId)).toBe(true);
    expect(a.approved()).toBe(true);
    const before = events.length;
    expect(a.withdraw('Withdrawn: the request expired.')).toBe(false);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(events).toHaveLength(before); // no withdraw event, no done
    let settled = false;
    void a.result.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    submitAiActionResult({
      requestId: a.requestId,
      callId: a.callId,
      outcome: 'applied',
      note: '3 rows affected.',
    });
    expect((await a.result).outcome).toBe('applied');
  });

  it('a card that went back to waiting (a note to fix) can be withdrawn again', () => {
    const { win } = fakeWindow();
    const a = started(change(win, { name: 'remember', args: { text: 'x note' } }));
    markExternalApproved(a.requestId, a.callId);
    markExternalApproved(a.requestId, a.callId, false);
    expect(a.withdraw('r')).toBe(true);
  });

  it('a late answer after settling is ignored', async () => {
    const { win } = fakeWindow();
    const a = started(change(win));
    submitAiActionResult({ requestId: a.requestId, callId: a.callId, outcome: 'rejected' });
    await a.result;
    expect(
      submitAiActionResult({ requestId: a.requestId, callId: a.callId, outcome: 'applied' }),
    ).toBe(false);
  });
});
