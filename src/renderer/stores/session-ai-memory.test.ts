import type { AiChatEvent } from '@shared/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const actionResult = vi.fn(async (_r: unknown) => undefined);
const memAdd = vi.fn();
const memDelete = vi.fn(async (_r: unknown) => undefined);
const memList = vi.fn(async (_id: string) => [] as unknown[]);

vi.mock('@/lib/ipc', () => ({
  ipc: {
    query: { run: vi.fn(), cancel: vi.fn() },
    conn: { introspect: vi.fn() },
    settings: { get: vi.fn(), set: vi.fn(async () => undefined) },
    vault: { list: vi.fn(async () => []) },
    history: { list: vi.fn(async () => []) },
    sql: { format: vi.fn() },
    ai: {
      chat: vi.fn(async () => ({ accepted: true })),
      cancel: vi.fn(async () => undefined),
      actionResult: (r: unknown) => actionResult(r),
    },
    memory: {
      list: (id: string) => memList(id),
      add: (r: unknown) => memAdd(r),
      update: vi.fn(),
      delete: (r: unknown) => memDelete(r),
    },
  },
}));

import { useSession } from './session';

const state = () => useSession.getState();
let counter = 0;

function event(name: string, args: Record<string, unknown>): AiChatEvent {
  return {
    kind: 'action',
    requestId: 'req1',
    callId: `call_${counter++}`,
    name: name as never,
    args,
  };
}
const cards = () => Object.values(state().aiActions);
const lastResult = () => actionResult.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;

beforeEach(() => {
  actionResult.mockClear();
  memAdd.mockReset();
  memDelete.mockClear();
  useSession.setState({
    connectionState: 'connected',
    connectionGen: 1,
    activeConfig: { id: 'c1', name: 'Shop', engine: 'postgres' } as never,
    tabs: [],
    aiActions: {},
    aiChatConnectionId: 'c1',
    aiRequestId: 'req1',
    aiPending: true,
    aiChat: [
      { id: 'u', role: 'user', content: 'amounts are cents' },
      { id: 'a', role: 'assistant', content: '', streaming: true, parts: [] },
    ],
  } as never);
});

describe('remember card', () => {
  it('shows a pending card with the proposed note and stores nothing yet', async () => {
    state().aiApplyEvent(event('remember', { text: 'orders.amount is in cents' }));
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    expect(cards()[0]).toMatchObject({
      name: 'remember',
      status: 'pending',
      memoryText: 'orders.amount is in cents',
    });
    expect(memAdd).not.toHaveBeenCalled();
    expect(actionResult).not.toHaveBeenCalled();
  });

  it('approving after an edit stores the edited text with source agent', async () => {
    memAdd.mockResolvedValue({ ok: true, note: { id: 'abcdef123456' } });
    state().aiApplyEvent(event('remember', { text: 'orders.amount is in cents' }));
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    const id = cards()[0]!.id;
    state().aiEditMemoryAction(id, 'orders.amount is in cents (USD)');
    await state().aiApproveAction(id);
    expect(memAdd).toHaveBeenCalledWith({
      connectionId: 'c1',
      text: 'orders.amount is in cents (USD)',
      source: 'agent',
    });
    expect(state().aiActions[id]?.status).toBe('applied');
    expect(lastResult()).toMatchObject({ outcome: 'applied', memoryId: 'abcdef123456' });
  });

  it('Skip stores nothing and tells the model it was rejected', async () => {
    state().aiApplyEvent(event('remember', { text: 'a rule' }));
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    state().aiRejectAction(cards()[0]!.id);
    expect(memAdd).not.toHaveBeenCalled();
    expect(lastResult()).toMatchObject({ outcome: 'rejected' });
  });

  it('keeps the card open with the reason when the store refuses the text', async () => {
    memAdd.mockResolvedValueOnce({ ok: false, error: 'Already remembered.' });
    state().aiApplyEvent(event('remember', { text: 'a rule' }));
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    const id = cards()[0]!.id;
    await state().aiApproveAction(id);
    expect(state().aiActions[id]).toMatchObject({ status: 'pending', note: 'Already remembered.' });
    expect(actionResult).not.toHaveBeenCalled();
    // Editing clears the reason; a good text then goes through.
    state().aiEditMemoryAction(id, 'a different rule');
    memAdd.mockResolvedValueOnce({ ok: true, note: { id: 'zzzzzz999999' } });
    await state().aiApproveAction(id);
    expect(state().aiActions[id]?.status).toBe('applied');
  });

  it('is never applied on its own, even with auto-apply for views on', async () => {
    useSession.setState((s) => ({ settings: { ...s.settings, aiAutoApplyViews: true } }) as never);
    state().aiApplyEvent(event('remember', { text: 'a rule' }));
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(cards()[0]?.status).toBe('pending');
    expect(memAdd).not.toHaveBeenCalled();
  });

  it('a bad call (secret) becomes a failed card, nothing to approve', async () => {
    state().aiApplyEvent(event('remember', { text: 'password: hunter2hunter2' }));
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    expect(cards()[0]?.status).toBe('failed');
  });
});

describe('forget card', () => {
  it('Forget deletes the note and answers applied; Keep deletes nothing', async () => {
    state().aiApplyEvent(event('forget', { id: 'abcdef123456', text: 'old rule' }));
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    const id = cards()[0]!.id;
    await state().aiApproveAction(id);
    expect(memDelete).toHaveBeenCalledWith({ connectionId: 'c1', id: 'abcdef123456' });
    expect(lastResult()).toMatchObject({ outcome: 'applied' });

    memDelete.mockClear();
    state().aiApplyEvent(event('forget', { id: 'zzzzzz', text: 'other' }));
    await vi.waitFor(() => expect(cards()).toHaveLength(2));
    const keep = cards().find((c) => c.id !== id)!;
    state().aiRejectAction(keep.id);
    expect(memDelete).not.toHaveBeenCalled();
    expect(state().aiActions[keep.id]?.status).toBe('rejected');
  });
});
