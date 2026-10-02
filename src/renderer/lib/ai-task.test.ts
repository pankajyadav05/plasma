import type { SchemaInfo } from '@shared/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const chat = vi.fn();
const cancel = vi.fn(async (_id: string) => undefined);
vi.mock('@/lib/ipc', () => ({
  ipc: { ai: { chat: (r: unknown) => chat(r), cancel: (id: string) => cancel(id) } },
}));

import {
  AiAbortError,
  aiSchemaAllowed,
  routeAiTaskEvent,
  runAiTask,
  schemaForTask,
} from './ai-task';

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  chat.mockReset();
  cancel.mockClear();
});

describe('runAiTask', () => {
  it('sends one user message with the task and resolves with the streamed text', async () => {
    let id = '';
    chat.mockImplementation(async (req: { requestId: string }) => {
      id = req.requestId;
      return { accepted: true };
    });
    const p = runAiTask({ task: 'fix-sql', prompt: 'fix this' });
    await tick();
    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({
        task: 'fix-sql',
        messages: [{ role: 'user', content: 'fix this' }],
        engine: 'postgres',
        schema: null,
      }),
    );
    expect(routeAiTaskEvent({ kind: 'delta', requestId: id, text: 'Hel' })).toBe(true);
    routeAiTaskEvent({ kind: 'delta', requestId: id, text: 'lo' });
    routeAiTaskEvent({ kind: 'done', requestId: id });
    await expect(p).resolves.toBe('Hello');
  });

  it('rejects with the provider error', async () => {
    let id = '';
    chat.mockImplementation(async (req: { requestId: string }) => {
      id = req.requestId;
      return { accepted: true };
    });
    const p = runAiTask({ task: 'nl-filter', prompt: 'x' });
    await tick();
    routeAiTaskEvent({ kind: 'error', requestId: id, message: 'OpenRouter HTTP 401: nope' });
    await expect(p).rejects.toThrow('OpenRouter HTTP 401: nope');
  });

  it('rejects when main does not accept the request (no key)', async () => {
    chat.mockResolvedValue({ accepted: false });
    await expect(runAiTask({ task: 'explain-plan', prompt: 'x' })).rejects.toThrow(/rejected/);
  });

  it('cancels on abort and ignores late events', async () => {
    let id = '';
    chat.mockImplementation(async (req: { requestId: string }) => {
      id = req.requestId;
      return { accepted: true };
    });
    const ctl = new AbortController();
    const p = runAiTask({ task: 'fix-sql', prompt: 'x', signal: ctl.signal });
    await tick();
    ctl.abort();
    await expect(p).rejects.toBeInstanceOf(AiAbortError);
    expect(cancel).toHaveBeenCalledWith(id);
    expect(routeAiTaskEvent({ kind: 'delta', requestId: id, text: 'late' })).toBe(false);
  });

  it('does not claim events of other requests (the chat panel keeps them)', () => {
    expect(routeAiTaskEvent({ kind: 'delta', requestId: 'chat-1', text: 'x' })).toBe(false);
  });
});

describe('schemaForTask', () => {
  const schema = {
    schemas: [],
    tables: [{ schema: 'public', name: 'orders', kind: 'table', rowCountEstimate: 1 }],
    columns: [],
    foreignKeys: [],
  } as unknown as SchemaInfo;

  it('sends nothing when schema sharing is not allowed or there is no schema', () => {
    expect(schemaForTask(schema, false, 'orders')).toBeNull();
    expect(schemaForTask(null, true, 'orders')).toBeNull();
  });

  it('follows the connection policy: off setting and un-opted prod deny, dev allows', () => {
    const base = { activeConfig: { id: 'c1' } };
    expect(aiSchemaAllowed({ ...base, settings: { aiSendSchema: false } })).toBe(false);
    expect(aiSchemaAllowed({ ...base, settings: { connectionTags: { c1: 'prod' } } })).toBe(false);
    expect(
      aiSchemaAllowed({
        ...base,
        settings: { connectionTags: { c1: 'prod' }, connectionAiRowData: { c1: true } },
      }),
    ).toBe(true);
    expect(aiSchemaAllowed({ ...base, settings: { connectionTags: { c1: 'dev' } } })).toBe(true);
    expect(aiSchemaAllowed({ activeConfig: null, settings: {} })).toBe(false);
  });

  it('narrows to the relevant tables by default', () => {
    expect(schemaForTask(schema, true, 'select * from orders')?.tables).toHaveLength(1);
  });
});
