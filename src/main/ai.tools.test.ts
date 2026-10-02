import type { AiChatRequest } from '@shared/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { cancelAiChat, setAiToolExecutor, startAiChat } from './ai';
import { isAiSchemaAllowed } from './ai-policy';

function sse(chunks: unknown[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(`data: ${JSON.stringify(ch)}\n\n`));
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
  return new Response(body, { status: 200 });
}

const toolTurn = (calls: Array<{ name: string; args: string }>) =>
  sse([
    {
      choices: [
        {
          delta: {
            tool_calls: calls.map((c, i) => ({
              index: i,
              id: `call_${i}`,
              function: { name: c.name, arguments: c.args },
            })),
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
  ]);

const finalTurn = () => sse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]);

function fakeWindow() {
  const events: Array<{ kind: string }> = [];
  const win = {
    isDestroyed: () => false,
    webContents: { send: (_ch: string, evt: { kind: string }) => events.push(evt) },
  };
  return { win: win as never, events };
}

const req = (id: string): AiChatRequest =>
  ({
    requestId: id,
    messages: [{ role: 'user', content: 'hi' }],
    engine: 'postgres',
    schema: {
      tables: [{ schema: 'public', name: 'secret_table', kind: 'table' }],
      columns: [],
      foreignKeys: [],
    },
  }) as never;

async function settle(events: Array<{ kind: string }>) {
  for (let i = 0; i < 200; i++) {
    if (events.some((e) => e.kind === 'done' || e.kind === 'error')) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('AI tool execution guards (SC-05 / SC-20)', () => {
  const executor = vi.fn(async () => '{"ok":true}');
  beforeEach(() => {
    executor.mockClear();
    setAiToolExecutor(executor);
  });

  it('drops tool_calls when no tools were offered (row data not allowed)', async () => {
    const { win, events } = fakeWindow();
    const fetchImpl = vi.fn(async () =>
      toolTurn([{ name: 'query_database', args: '{"sql":"select 1"}' }]),
    );
    await startAiChat(win, req('r1'), 'k', 'm', {
      allowRowData: false,
      fetchImpl: fetchImpl as never,
    });
    await settle(events);
    expect(executor).not.toHaveBeenCalled();
    expect(events.at(-1)?.kind).toBe('done');
  });

  it('drops tool_calls with a name that was not offered', async () => {
    const { win, events } = fakeWindow();
    const fetchImpl = vi.fn(async () => toolTurn([{ name: 'redis_command', args: '{}' }]));
    await startAiChat(win, req('r2'), 'k', 'm', {
      allowRowData: true,
      fetchImpl: fetchImpl as never,
    });
    await settle(events);
    expect(executor).not.toHaveBeenCalled();
  });

  it('re-checks the guard at execution time and feeds the refusal back', async () => {
    const { win, events } = fakeWindow();
    const bodies: string[] = [];
    let n = 0;
    const fetchImpl = vi.fn(async (_u: unknown, init: { body: string }) => {
      bodies.push(init.body);
      return n++ === 0
        ? toolTurn([{ name: 'query_database', args: '{"sql":"select 1"}' }])
        : finalTurn();
    });
    await startAiChat(win, req('r3'), 'k', 'm', {
      allowRowData: true,
      toolGuard: () => 'the active connection changed since this chat started',
      fetchImpl: fetchImpl as never,
    });
    await settle(events);
    expect(executor).not.toHaveBeenCalled();
    expect(bodies[1]).toContain('the active connection changed');
  });

  it('runs an offered tool when the guard passes', async () => {
    const { win, events } = fakeWindow();
    let n = 0;
    const fetchImpl = vi.fn(async () =>
      n++ === 0 ? toolTurn([{ name: 'query_database', args: '{"sql":"select 1"}' }]) : finalTurn(),
    );
    await startAiChat(win, req('r4'), 'k', 'm', {
      allowRowData: true,
      toolGuard: () => null,
      fetchImpl: fetchImpl as never,
    });
    await settle(events);
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('Cancel stops queued tool calls', async () => {
    const { win } = fakeWindow();
    executor.mockImplementationOnce(async () => {
      cancelAiChat('r5');
      return '{"ok":true}';
    });
    let n = 0;
    const fetchImpl = vi.fn(async () =>
      n++ === 0
        ? toolTurn([
            { name: 'query_database', args: '{"sql":"select 1"}' },
            { name: 'query_database', args: '{"sql":"select 2"}' },
            { name: 'query_database', args: '{"sql":"select 3"}' },
          ])
        : finalTurn(),
    );
    await startAiChat(win, req('r5'), 'k', 'm', {
      allowRowData: true,
      fetchImpl: fetchImpl as never,
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(executor).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('omits the schema from the system prompt unless allowed (SC-20)', async () => {
    const run = async (allowSchema: boolean, id: string) => {
      const { win, events } = fakeWindow();
      const bodies: string[] = [];
      const fetchImpl = vi.fn(async (_u: unknown, init: { body: string }) => {
        bodies.push(init.body);
        return finalTurn();
      });
      await startAiChat(win, req(id), 'k', 'm', { allowSchema, fetchImpl: fetchImpl as never });
      await settle(events);
      return bodies[0] ?? '';
    };
    expect(await run(false, 's1')).not.toContain('secret_table');
    expect(await run(true, 's2')).toContain('secret_table');
  });
});

describe('isAiSchemaAllowed (SC-20)', () => {
  it('is on by default, off when disabled, and needs opt-in on prod', () => {
    expect(isAiSchemaAllowed('a', {})).toBe(true);
    expect(isAiSchemaAllowed(null, {})).toBe(false);
    expect(isAiSchemaAllowed('a', { aiSendSchema: false })).toBe(false);
    expect(isAiSchemaAllowed('a', { connectionTags: { a: 'prod' } })).toBe(false);
    expect(
      isAiSchemaAllowed('a', { connectionTags: { a: 'prod' }, connectionAiRowData: { a: true } }),
    ).toBe(true);
    expect(isAiSchemaAllowed('a', { connectionTags: { a: 'dev' } })).toBe(true);
  });
});
