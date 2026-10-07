import type { AiActionResult } from '@shared/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExternalAction, StartExternal } from '../ai';
import { EXPIRED_REASON, ProposalStore, WAITING_MESSAGE } from './proposals';

/** A card the test can answer, approve and watch. */
function fakeCard() {
  let resolve!: (r: AiActionResult) => void;
  let approved = false;
  const withdrawn: string[] = [];
  const action: ExternalAction = {
    requestId: 'mcp-1',
    callId: 'call-1',
    result: new Promise((r) => {
      resolve = r;
    }),
    approved: () => approved,
    withdraw: (reason) => {
      if (approved) return false;
      withdrawn.push(reason);
      return true;
    },
  };
  const answer = (outcome: AiActionResult['outcome'], extra: Partial<AiActionResult> = {}) =>
    resolve({ requestId: 'mcp-1', callId: 'call-1', outcome, ...extra });
  return {
    action,
    answer,
    approve: () => {
      approved = true;
    },
    withdrawn,
  };
}

function make(opts: { expiryMs?: number; keepMs?: number } = {}) {
  const cards: Array<ReturnType<typeof fakeCard>> = [];
  let t = 1_000;
  const store = new ProposalStore({
    start: (): StartExternal => {
      const c = fakeCard();
      cards.push(c);
      return { ok: true, action: c.action };
    },
    scrub: (_id, text) => text.replace(/db\.corp/g, '…'),
    now: () => t,
    ...opts,
  });
  const create = (kind: 'change' | 'remember' = 'change', connectionId = 'c1') => {
    const r = store.create({
      kind,
      client: 'Claude Code',
      connectionId,
      connectionName: 'Shop',
      args: {},
    });
    if (!r.ok) throw new Error(r.note);
    return r.id;
  };
  return {
    store,
    cards,
    create,
    tick: (ms: number) => {
      t += ms;
    },
  };
}

afterEach(() => vi.useRealTimers());

describe('ProposalStore', () => {
  it('waits for the user, then returns the outcome with rows affected', async () => {
    const { store, cards, create } = make();
    const id = create();
    expect(store.get(id)).toMatchObject({
      status: 'waiting_for_approval',
      message: WAITING_MESSAGE,
    });
    const w = store.wait(id, 45_000);
    cards[0]?.approve();
    cards[0]?.answer('applied', { note: '3 rows affected.' });
    expect(await w).toMatchObject({ status: 'applied', rows_affected: 3 });
  });

  it('wait returns "still waiting" at the limit without touching the proposal', async () => {
    vi.useFakeTimers();
    const { store, create } = make();
    const id = create();
    const w = store.wait(id, 45_000);
    await vi.advanceTimersByTimeAsync(45_000);
    expect((await w)?.status).toBe('waiting_for_approval');
    expect(store.get(id)?.status).toBe('waiting_for_approval');
  });

  it('maps declined, failed (redacted) and a note for remember', async () => {
    const { store, cards, create } = make();
    const a = create();
    cards[0]?.answer('rejected', { note: 'not now' });
    const b = create();
    cards[1]?.answer('failed', {
      dbError: 'duplicate key at db.corp\nDETAIL: Key (email)=(a@b.c)',
    });
    const c = create('remember');
    cards[2]?.answer('applied', { memoryId: 'abcdef1234' });
    await Promise.resolve();
    expect(store.get(a)).toMatchObject({ status: 'declined' });
    expect(store.get(a)?.message).toContain('not now');
    const failed = store.get(b);
    expect(failed?.status).toBe('failed');
    expect(failed?.message).toBe('duplicate key at …');
    expect(store.get(c)).toMatchObject({ status: 'applied', message: 'Remembered as m:abcdef.' });
  });

  it('an undecided proposal expires after 10 minutes: the card is withdrawn and the answer says expired', async () => {
    vi.useFakeTimers();
    const { store, cards, create } = make();
    const id = create();
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
    expect(cards[0]?.withdrawn).toEqual([EXPIRED_REASON]);
    cards[0]?.answer('cancelled', { note: EXPIRED_REASON });
    await Promise.resolve();
    expect(store.get(id)).toMatchObject({ status: 'expired' });
    expect(store.get(id)?.message).toContain('Nothing was changed');
  });

  it('after Approve: the timer, a dropped client and a disabled server change nothing; the real outcome is kept', async () => {
    vi.useFakeTimers();
    const { store, cards, create } = make();
    const id = create();
    cards[0]?.approve();
    const gone = new AbortController();
    const w = store.wait(id, 45_000, gone.signal);
    gone.abort(); // the client dropped the connection
    expect((await w)?.status).toBe('waiting_for_approval');
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1); // would have expired
    store.withdrawUndecided('Withdrawn: the MCP server was turned off.'); // server disabled
    store.recheck(() => 'Withdrawn: access lowered.');
    expect(cards[0]?.withdrawn).toEqual([]);
    expect(store.get(id)?.status).toBe('waiting_for_approval');
    expect(store.get(id)?.message).not.toMatch(/nothing was changed/i);
    // The statement finishes much later, after the client gave up:
    cards[0]?.answer('applied', { note: '7 rows affected.' });
    await Promise.resolve();
    expect(store.get(id)).toMatchObject({ status: 'applied', rows_affected: 7 });
  });

  it('an approved proposal that was stopped is "failed, may have run", never "nothing changed"', async () => {
    const { store, cards, create } = make();
    const id = create();
    cards[0]?.approve();
    cards[0]?.answer('cancelled', { note: 'Stopped; the statement may have run.' });
    await Promise.resolve();
    const v = store.get(id);
    expect(v?.status).toBe('failed');
    expect(v?.message).toMatch(/may have run/);
    expect(v?.message).not.toMatch(/nothing was changed/i);
  });

  it('withdraws undecided proposals when access drops or the connection goes, and only those', async () => {
    const { store, cards, create } = make();
    const a = create('change', 'c1');
    create('change', 'c2');
    store.recheck((id) =>
      id === 'c1' ? 'Withdrawn: AI tool access to this connection was lowered.' : null,
    );
    expect(cards[0]?.withdrawn).toHaveLength(1);
    expect(cards[1]?.withdrawn).toHaveLength(0);
    cards[0]?.answer('cancelled', { note: 'x' });
    await Promise.resolve();
    expect(store.get(a)?.status).toBe('declined');
    expect(store.get(a)?.message).toContain('lowered');
  });

  it('keeps outcomes for one hour', async () => {
    const { store, cards, create, tick } = make();
    const id = create();
    cards[0]?.answer('applied');
    await Promise.resolve();
    tick(59 * 60_000);
    expect(store.get(id)?.status).toBe('applied');
    tick(2 * 60_000);
    expect(store.get(id)).toBeNull();
    expect(await store.wait(id, 10)).toBeNull();
  });

  it('refuses more than five open proposals and passes on why the card could not be shown', () => {
    const { store, create } = make();
    for (let i = 0; i < 5; i++) create();
    const r = store.create({
      kind: 'change',
      client: 'x',
      connectionId: 'c1',
      connectionName: 'Shop',
      args: {},
    });
    expect(r.ok).toBe(false);
    const refused = new ProposalStore({
      start: () => ({ ok: false, note: 'rejected: sql is empty' }),
      scrub: (_i, t) => t,
    });
    expect(
      refused.create({
        kind: 'change',
        client: 'x',
        connectionId: 'c1',
        connectionName: 'S',
        args: {},
      }),
    ).toEqual({ ok: false, note: 'rejected: sql is empty' });
  });
});
