import type { AiChatRequest } from '@shared/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import {
  cancelAiChat,
  resolveLocalAiEndpoint,
  setAiToolExecutor,
  startAiChat,
  submitAiActionResult,
} from './ai';
import { shapeAgentActionResult } from './ai-policy';

type Evt = { kind: string; [k: string]: unknown };

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

const toolTurn = (calls: Array<{ name: string; args: unknown; id?: string }>) =>
  sse([
    {
      choices: [
        {
          delta: {
            tool_calls: calls.map((c, i) => ({
              index: i,
              id: c.id ?? `call_${i}`,
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            })),
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
  ]);
const finalTurn = (text = 'ok') =>
  sse([{ choices: [{ delta: { content: text }, finish_reason: 'stop' }] }]);

function fakeWindow() {
  const events: Evt[] = [];
  const win = {
    isDestroyed: () => false,
    webContents: { send: (_ch: string, evt: Evt) => events.push(evt) },
  };
  return { win: win as never, events };
}

const req = (id: string, extra: Partial<AiChatRequest> = {}): AiChatRequest =>
  ({
    requestId: id,
    messages: [{ role: 'user', content: 'show my orders' }],
    engine: 'postgres',
    agent: true,
    schema: {
      tables: [{ schema: 'public', name: 'orders', kind: 'table' }],
      columns: [],
      foreignKeys: [],
    },
    ...extra,
  }) as never;

async function until(cond: () => boolean) {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('timed out');
}
const settled = (events: Evt[]) =>
  until(() => events.some((e) => e.kind === 'done' || e.kind === 'error'));
const actions = (events: Evt[]) => events.filter((e) => e.kind === 'action');

/** Fetch mock: round N returns turns[N]; records each body. */
function scripted(turns: Array<() => Response>) {
  const bodies: Array<{
    messages: Array<{ role: string; content: string; tool_call_id?: string }>;
    tools?: Array<{ function: { name: string } }>;
  }> = [];
  const headers: Array<Record<string, string>> = [];
  const urls: string[] = [];
  let n = 0;
  const fetchImpl = vi.fn(async (url: unknown, init: { body: string; headers: never }) => {
    urls.push(String(url));
    headers.push(init.headers);
    bodies.push(JSON.parse(init.body));
    return (turns[n++] ?? finalTurn)();
  });
  return { fetchImpl: fetchImpl as never, bodies, headers, urls, count: () => n };
}

const SHOW = { schema: 'public', table: 'orders', limit: 10 };

describe('agent actions (main)', () => {
  const executor = vi.fn(async () => '{"ok":true}');
  beforeEach(() => {
    executor.mockClear();
    setAiToolExecutor(executor);
  });

  it('offers action tools without the row-data opt-in, but not the read tool', async () => {
    const { win, events } = fakeWindow();
    const s = scripted([finalTurn]);
    await startAiChat(win, req('a1'), 'k', 'm', { allowRowData: false, fetchImpl: s.fetchImpl });
    await settled(events);
    const names = s.bodies[0]?.tools?.map((t) => t.function.name);
    expect(names).toEqual(['show_table', 'run_query', 'propose_change', 'open_in_editor']);
  });

  it('adds query_database only with the row-data opt-in', async () => {
    const { win, events } = fakeWindow();
    const s = scripted([finalTurn]);
    await startAiChat(win, req('a2'), 'k', 'm', { allowRowData: true, fetchImpl: s.fetchImpl });
    await settled(events);
    expect(s.bodies[0]?.tools?.map((t) => t.function.name)).toContain('query_database');
  });

  it('offers nothing agentic on non-SQL engines or without agent mode', async () => {
    for (const [id, extra] of [
      ['a3', { engine: 'redis' }],
      ['a4', { engine: 'opensearch' }],
      ['a5', { agent: false }],
      ['a6', { task: 'nl-filter' }],
    ] as const) {
      const { win, events } = fakeWindow();
      const s = scripted([finalTurn]);
      await startAiChat(win, req(id, extra as Partial<AiChatRequest>), 'k', 'm', {
        allowRowData: false,
        fetchImpl: s.fetchImpl,
      });
      await settled(events);
      expect(s.bodies[0]?.tools, id).toBeUndefined();
    }
  });

  it('drops an action call a Redis chat was never offered', async () => {
    const { win, events } = fakeWindow();
    const s = scripted([() => toolTurn([{ name: 'show_table', args: SHOW }])]);
    await startAiChat(win, req('a7', { engine: 'redis' }), 'k', 'm', { fetchImpl: s.fetchImpl });
    await settled(events);
    expect(actions(events)).toHaveLength(0);
    expect(events.at(-1)?.kind).toBe('done');
  });

  it('emits an action event, waits, and feeds the approved result back as the tool message', async () => {
    const { win, events } = fakeWindow();
    const s = scripted([() => toolTurn([{ name: 'show_table', args: SHOW }]), finalTurn]);
    await startAiChat(win, req('b1'), 'k', 'm', { fetchImpl: s.fetchImpl });
    await until(() => actions(events).length === 1);
    const evt = actions(events)[0]!;
    expect(evt).toMatchObject({
      requestId: 'b1',
      callId: 'call_0',
      name: 'show_table',
      args: SHOW,
    });
    // The model is not called again while the card waits.
    await new Promise((r) => setTimeout(r, 30));
    expect(s.count()).toBe(1);

    expect(
      submitAiActionResult({
        requestId: 'b1',
        callId: 'call_0',
        outcome: 'applied',
        data: { columns: ['id', 'total'], rows: [[1, 5]], rowCount: 1 },
      }),
    ).toBe(true);
    await settled(events);
    const tool = s.bodies[1]?.messages.find((m) => m.role === 'tool');
    expect(tool?.tool_call_id).toBe('call_0');
    const parsed = JSON.parse(tool?.content ?? '{}');
    expect(parsed).toMatchObject({ outcome: 'applied', columns: ['id', 'total'], rowCount: 1 });
    // The default shaper never carries rows.
    expect(parsed.rows).toBeUndefined();
    expect(parsed.dbError).toBeUndefined();
    expect(events.at(-1)?.kind).toBe('done');
  });

  it('feeds a rejection with the user note back to the model', async () => {
    const { win, events } = fakeWindow();
    const s = scripted([
      () =>
        toolTurn([{ name: 'propose_change', args: { sql: 'delete from orders', summary: 's' } }]),
      finalTurn,
    ]);
    await startAiChat(win, req('b2'), 'k', 'm', { fetchImpl: s.fetchImpl });
    await until(() => actions(events).length === 1);
    submitAiActionResult({
      requestId: 'b2',
      callId: 'call_0',
      outcome: 'rejected',
      note: 'only paid orders',
    });
    await settled(events);
    const tool = s.bodies[1]?.messages.find((m) => m.role === 'tool');
    expect(JSON.parse(tool?.content ?? '{}')).toEqual({
      outcome: 'rejected',
      note: 'only paid orders',
    });
  });

  it('feeds a cancelled result back and keeps going', async () => {
    const { win, events } = fakeWindow();
    const s = scripted([
      () => toolTurn([{ name: 'open_in_editor', args: { sql: 'select 1' } }]),
      finalTurn,
    ]);
    await startAiChat(win, req('b3'), 'k', 'm', { fetchImpl: s.fetchImpl });
    await until(() => actions(events).length === 1);
    submitAiActionResult({ requestId: 'b3', callId: 'call_0', outcome: 'cancelled' });
    await settled(events);
    const tool = s.bodies[1]?.messages.find((m) => m.role === 'tool');
    expect(JSON.parse(tool?.content ?? '{}').outcome).toBe('cancelled');
  });

  it('Stop while a card waits resolves it as cancelled and stops the loop', async () => {
    const { win, events } = fakeWindow();
    const s = scripted([() => toolTurn([{ name: 'show_table', args: SHOW }]), finalTurn]);
    await startAiChat(win, req('b4'), 'k', 'm', { fetchImpl: s.fetchImpl });
    await until(() => actions(events).length === 1);
    cancelAiChat('b4');
    await new Promise((r) => setTimeout(r, 50));
    expect(s.count()).toBe(1);
    expect(events.some((e) => e.kind === 'done' || e.kind === 'error')).toBe(false);
    // The pending entry is gone: a late click is ignored.
    expect(submitAiActionResult({ requestId: 'b4', callId: 'call_0', outcome: 'applied' })).toBe(
      false,
    );
  });

  it('runs the next queued action only after the previous one is answered', async () => {
    const { win, events } = fakeWindow();
    const s = scripted([
      () =>
        toolTurn([
          { name: 'open_in_editor', args: { sql: 'select 1' }, id: 'c1' },
          { name: 'open_in_editor', args: { sql: 'select 2' }, id: 'c2' },
        ]),
      finalTurn,
    ]);
    await startAiChat(win, req('b5'), 'k', 'm', { fetchImpl: s.fetchImpl });
    await until(() => actions(events).length === 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(actions(events)).toHaveLength(1);
    submitAiActionResult({ requestId: 'b5', callId: 'c1', outcome: 'applied' });
    await until(() => actions(events).length === 2);
    submitAiActionResult({ requestId: 'b5', callId: 'c2', outcome: 'applied' });
    await settled(events);
    const tools = s.bodies[1]?.messages.filter((m) => m.role === 'tool');
    expect(tools?.map((t) => t.tool_call_id)).toEqual(['c1', 'c2']);
  });

  it('ignores results for unknown keys, other requests and malformed payloads', async () => {
    expect(submitAiActionResult({ requestId: 'nope', callId: 'x', outcome: 'applied' })).toBe(
      false,
    );
    expect(submitAiActionResult({ requestId: 'nope', callId: 'x', outcome: 'maybe' })).toBe(false);
    expect(submitAiActionResult(null)).toBe(false);
    const { win, events } = fakeWindow();
    const s = scripted([() => toolTurn([{ name: 'show_table', args: SHOW }]), finalTurn]);
    await startAiChat(win, req('b6'), 'k', 'm', { fetchImpl: s.fetchImpl });
    await until(() => actions(events).length === 1);
    // A result for another request is ignored; the card still waits.
    expect(submitAiActionResult({ requestId: 'other', callId: 'call_0', outcome: 'applied' })).toBe(
      false,
    );
    expect(s.count()).toBe(1);
    // A malformed result for the card main waits on must not leave it hanging:
    // it is answered to the model as a failure.
    expect(
      submitAiActionResult({
        requestId: 'b6',
        callId: 'call_0',
        outcome: 'applied',
        data: { columns: ['a'], rows: Array(201).fill([1]), rowCount: 201 },
      }),
    ).toBe(true);
    await settled(events);
    const tool = s.bodies[1]?.messages.find((m) => m.role === 'tool');
    expect(JSON.parse(tool?.content ?? '{}').outcome).toBe('failed');
  });

  it('rejects run_query write SQL without asking the user', async () => {
    const { win, events } = fakeWindow();
    const bad = [
      'delete from orders',
      'select 1; select 2',
      'explain analyze delete from orders',
      'select * into backup from orders',
      "select nextval('s')",
    ];
    for (const [i, sql] of bad.entries()) {
      const s = scripted([() => toolTurn([{ name: 'run_query', args: { sql } }]), finalTurn]);
      const f = fakeWindow();
      await startAiChat(f.win, req(`c${i}`), 'k', 'm', { fetchImpl: s.fetchImpl });
      await settled(f.events);
      expect(actions(f.events), sql).toHaveLength(0);
      const tool = s.bodies[1]?.messages.find((m) => m.role === 'tool');
      expect(JSON.parse(tool?.content ?? '{}').error, sql).toMatch(/^rejected:/);
    }
    void win;
    void events;
  });

  it('rejects propose_change that is multi-statement or read-only', async () => {
    for (const [i, sql] of ['delete from a; delete from b', 'select * from orders'].entries()) {
      const s = scripted([
        () => toolTurn([{ name: 'propose_change', args: { sql, summary: 's' } }]),
        finalTurn,
      ]);
      const f = fakeWindow();
      await startAiChat(f.win, req(`d${i}`), 'k', 'm', { fetchImpl: s.fetchImpl });
      await settled(f.events);
      expect(actions(f.events), sql).toHaveLength(0);
      const tool = s.bodies[1]?.messages.find((m) => m.role === 'tool');
      const err = JSON.parse(tool?.content ?? '{}').error as string;
      expect(err).toMatch(/^rejected:/);
      if (i === 1) expect(err).toContain('run_query');
    }
  });

  it('refuses an action when the connection changed, without asking', async () => {
    const { win, events } = fakeWindow();
    const s = scripted([() => toolTurn([{ name: 'show_table', args: SHOW }]), finalTurn]);
    await startAiChat(win, req('e1'), 'k', 'm', {
      actionGuard: () => 'the active connection changed since this chat started',
      fetchImpl: s.fetchImpl,
    });
    await settled(events);
    expect(actions(events)).toHaveLength(0);
    expect(s.bodies[1]?.messages.find((m) => m.role === 'tool')?.content).toContain(
      'the active connection changed',
    );
  });

  it('uses the supplied shaper for the tool message (rows only where main allows)', async () => {
    const { win, events } = fakeWindow();
    const s = scripted([() => toolTurn([{ name: 'show_table', args: SHOW }]), finalTurn]);
    const shape = vi.fn(() => '{"outcome":"applied","shaped":true}');
    await startAiChat(win, req('e2'), 'k', 'm', {
      shapeActionResult: shape,
      fetchImpl: s.fetchImpl,
    });
    await until(() => actions(events).length === 1);
    submitAiActionResult({ requestId: 'e2', callId: 'call_0', outcome: 'applied' });
    await settled(events);
    expect(shape).toHaveBeenCalledTimes(1);
    expect(s.bodies[1]?.messages.find((m) => m.role === 'tool')?.content).toContain(
      '"shaped":true',
    );
  });

  it('allows up to 8 tool rounds on an agent turn (5 otherwise)', async () => {
    const run = async (id: string, extra: Partial<AiChatRequest>) => {
      const f = fakeWindow();
      const s = scripted(
        Array.from(
          { length: 12 },
          () => () => toolTurn([{ name: 'query_database', args: { sql: 'select 1' } }]),
        ),
      );
      await startAiChat(f.win, req(id, extra), 'k', 'm', {
        allowRowData: true,
        fetchImpl: s.fetchImpl,
      });
      await settled(f.events);
      return s.count();
    };
    expect(await run('f1', { agent: true })).toBe(9);
    expect(await run('f2', { agent: false })).toBe(6);
  });

  it('builds the agent system prompt: schema and tab context only when allowed', async () => {
    const run = async (allowSchema: boolean, id: string) => {
      const f = fakeWindow();
      const s = scripted([finalTurn]);
      await startAiChat(f.win, req(id, { context: 'Current tab: table public.orders' }), 'k', 'm', {
        allowSchema,
        fetchImpl: s.fetchImpl,
      });
      await settled(f.events);
      return s.bodies[0]?.messages[0]?.content ?? '';
    };
    const on = await run(true, 'g1');
    expect(on).toContain('public.orders');
    expect(on).toContain('Current tab: table public.orders');
    expect(on).toContain('show_table');
    const off = await run(false, 'g2');
    expect(off).not.toContain('Current tab: table public.orders');
    expect(off).toContain('schema is not available');
  });
});

describe('shapeAgentActionResult', () => {
  const mask = (_c: string[], rows: unknown[][]) => rows.map((r) => r.map(() => '***'));
  const data = { columns: ['email'], rows: [['a@b.c'], ['d@e.f']], rowCount: 2 };

  it('strips rows when row data is off', () => {
    const out = JSON.parse(
      shapeAgentActionResult(
        { requestId: 'r', callId: 'c', outcome: 'applied', data },
        { rowData: false, maskRows: mask },
      ),
    );
    expect(out).toEqual({ outcome: 'applied', columns: ['email'], rowCount: 2 });
  });

  it('includes masked, capped rows when row data is on', () => {
    const big = {
      columns: ['n'],
      rows: Array.from({ length: 120 }, (_, i) => [i]),
      rowCount: 120,
    };
    const out = JSON.parse(
      shapeAgentActionResult(
        { requestId: 'r', callId: 'c', outcome: 'applied', data: big },
        { rowData: true, maskRows: (_c, rows) => rows },
      ),
    );
    expect(out.rows).toHaveLength(50);
    expect(out.truncated).toBe(true);
    const masked = JSON.parse(
      shapeAgentActionResult(
        { requestId: 'r', callId: 'c', outcome: 'applied', data },
        { rowData: true, maskRows: mask },
      ),
    );
    expect(masked.rows).toEqual([{ email: '***' }, { email: '***' }]);
  });

  it('never forwards database error text without the opt-in (P0-1)', () => {
    const dbError = "Duplicate entry 'alice@corp.com' for key 'users.email'";
    const out = shapeAgentActionResult(
      { requestId: 'r', callId: 'c', outcome: 'failed', note: dbError, dbError },
      { rowData: false, maskRows: mask },
    );
    expect(out).not.toContain('alice');
    expect(JSON.parse(out).note).toBe('duplicate key (23505)');
    // A trigger message with no recognisable category is generic.
    const trig = shapeAgentActionResult(
      {
        requestId: 'r',
        callId: 'c',
        outcome: 'failed',
        note: 'customer Bob balance 5',
        dbError: 'customer Bob balance 5',
      },
      { rowData: false, maskRows: mask },
    );
    expect(trig).not.toContain('Bob');
    // With the opt-in the first line goes through.
    const on = JSON.parse(
      shapeAgentActionResult(
        {
          requestId: 'r',
          callId: 'c',
          outcome: 'failed',
          note: dbError,
          dbError: `${dbError}\nDETAIL: x`,
        },
        { rowData: true, maskRows: mask },
      ),
    );
    expect(on.note).toBe(dbError);
  });

  it('leaves result column names out without schema sharing (P1-3)', () => {
    const out = JSON.parse(
      shapeAgentActionResult(
        { requestId: 'r', callId: 'c', outcome: 'applied', data },
        { rowData: false, schema: false, maskRows: mask },
      ),
    );
    expect(out).toEqual({ outcome: 'applied', rowCount: 2 });
  });

  it('cuts a failure note to its first line without the opt-in', () => {
    const note =
      'duplicate key value violates unique constraint "u"\nDETAIL: Key (email)=(a@b.c) already exists.';
    const off = JSON.parse(
      shapeAgentActionResult(
        { requestId: 'r', callId: 'c', outcome: 'failed', note },
        { rowData: false, maskRows: mask },
      ),
    );
    expect(off.note).toBe('duplicate key value violates unique constraint "u"');
    const on = JSON.parse(
      shapeAgentActionResult(
        { requestId: 'r', callId: 'c', outcome: 'failed', note },
        { rowData: true, maskRows: mask },
      ),
    );
    expect(on.note).toContain('DETAIL');
  });
});

describe('local provider', () => {
  it('accepts only loopback http(s) and builds the chat endpoint', () => {
    const ok = (u: string) => {
      const r = resolveLocalAiEndpoint(u);
      return r.ok ? r.endpoint : null;
    };
    expect(ok('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(ok('http://localhost:1234/v1/')).toBe('http://localhost:1234/v1/chat/completions');
    expect(ok('http://[::1]:11434/v1')).toBe('http://[::1]:11434/v1/chat/completions');
    expect(ok('https://localhost/v1/chat/completions')).toBe(
      'https://localhost/v1/chat/completions',
    );
    expect(ok('http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434/chat/completions');
    for (const bad of [
      '',
      'not a url',
      'http://example.com/v1',
      'http://192.168.1.5:11434/v1',
      'http://0.0.0.0:11434/v1',
      'http://127.0.0.1.evil.com/v1',
      'http://localhost.evil.com/v1',
      'ftp://localhost/v1',
      'file:///etc/passwd',
      'http://user:pw@localhost:11434/v1',
    ]) {
      expect(resolveLocalAiEndpoint(bad).ok, bad).toBe(false);
    }
  });

  const chatReq = (id: string): AiChatRequest =>
    ({ requestId: id, messages: [{ role: 'user', content: 'hi' }], engine: 'postgres' }) as never;

  it('sends no Authorization or OpenRouter headers and uses the local model', async () => {
    const { win, events } = fakeWindow();
    const s = scripted([finalTurn]);
    const r = await startAiChat(win, chatReq('l1'), '', 'openrouter/model', {
      provider: 'local',
      localUrl: 'http://127.0.0.1:11434/v1',
      localModel: 'llama3.1',
      fetchImpl: s.fetchImpl,
    });
    expect(r.accepted).toBe(true);
    await settled(events);
    expect(s.urls[0]).toBe('http://127.0.0.1:11434/v1/chat/completions');
    const h = s.headers[0] ?? {};
    expect(Object.keys(h).map((k) => k.toLowerCase())).toEqual(['content-type']);
    expect((s.bodies[0] as unknown as { model: string }).model).toBe('llama3.1');
  });

  it('needs a model, and a loopback URL, and sends nothing otherwise', async () => {
    const { win } = fakeWindow();
    const s = scripted([finalTurn]);
    const noModel = await startAiChat(win, chatReq('l2'), '', 'm', {
      provider: 'local',
      localUrl: 'http://127.0.0.1:11434/v1',
      localModel: '  ',
      fetchImpl: s.fetchImpl,
    });
    expect(noModel.accepted).toBe(false);
    expect(noModel.reason).toMatch(/model/i);
    const remote = await startAiChat(win, chatReq('l3'), 'sk-secret', 'm', {
      provider: 'local',
      localUrl: 'https://api.example.com/v1',
      localModel: 'x',
      fetchImpl: s.fetchImpl,
    });
    expect(remote.accepted).toBe(false);
    expect(s.count()).toBe(0);
  });

  it('does not need an API key for a local model but does for OpenRouter', async () => {
    const { win } = fakeWindow();
    const s = scripted([finalTurn]);
    const r = await startAiChat(win, chatReq('l4'), '', 'm', { fetchImpl: s.fetchImpl });
    expect(r).toEqual({ accepted: false, reason: 'no OpenRouter API key configured' });
  });

  it('says so when the local server is not running', async () => {
    const { win, events } = fakeWindow();
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await startAiChat(win, chatReq('l5'), '', 'm', {
      provider: 'local',
      localUrl: 'http://127.0.0.1:11434/v1',
      localModel: 'llama3.1',
      fetchImpl: fetchImpl as never,
    });
    await settled(events);
    expect(events.at(-1)).toMatchObject({
      kind: 'error',
      message:
        'Could not reach the local model at http://127.0.0.1:11434/v1. Is Ollama (or LM Studio) running?',
    });
  });
});

describe('main never waits forever (P2-1 / P2-2)', () => {
  it('cancelAllAiChats resolves every waiting card as cancelled and stops the loops', async () => {
    const { cancelAllAiChats } = await import('./ai');
    const f = fakeWindow();
    const s = scripted([() => toolTurn([{ name: 'show_table', args: SHOW }]), finalTurn]);
    await startAiChat(f.win, req('z1'), 'k', 'm', { fetchImpl: s.fetchImpl });
    await until(() => actions(f.events).length === 1);
    cancelAllAiChats();
    await new Promise((r) => setTimeout(r, 40));
    expect(s.count()).toBe(1);
    expect(submitAiActionResult({ requestId: 'z1', callId: 'call_0', outcome: 'applied' })).toBe(
      false,
    );
  });

  it('answers cancelled at once when the window is already gone', async () => {
    const events: Evt[] = [];
    let destroyed = false;
    const win = {
      isDestroyed: () => destroyed,
      webContents: { send: (_c: string, e: Evt) => events.push(e) },
    };
    const s = scripted([
      () => {
        destroyed = true;
        return toolTurn([{ name: 'show_table', args: SHOW }]);
      },
      finalTurn,
    ]);
    await startAiChat(win as never, req('z2'), 'k', 'm', { fetchImpl: s.fetchImpl });
    await new Promise((r) => setTimeout(r, 60));
    expect(actions(events)).toHaveLength(0);
  });
});

describe('local provider redirects (P2-3)', () => {
  const chat = (id: string): AiChatRequest =>
    ({ requestId: id, messages: [{ role: 'user', content: 'hi' }], engine: 'postgres' }) as never;

  it('refuses redirects for a local server, and leaves OpenRouter requests as they were', async () => {
    const inits: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_u: unknown, init: Record<string, unknown>) => {
      inits.push(init);
      return finalTurn();
    });
    const a = fakeWindow();
    await startAiChat(a.win, chat('r1'), '', 'm', {
      provider: 'local',
      localUrl: 'http://127.0.0.1:11434/v1',
      localModel: 'x',
      fetchImpl: fetchImpl as never,
    });
    await settled(a.events);
    const b = fakeWindow();
    await startAiChat(b.win, chat('r2'), 'k', 'm', { fetchImpl: fetchImpl as never });
    await settled(b.events);
    expect(inits[0]?.redirect).toBe('error');
    expect(inits[1]?.redirect).toBeUndefined();
  });
});
