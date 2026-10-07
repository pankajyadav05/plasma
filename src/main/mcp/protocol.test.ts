import { describe, expect, it } from 'vitest';
import { RPC, createMcpHandler, negotiateVersion, textResult } from './protocol';

function make(over: Partial<Parameters<typeof createMcpHandler>[0]> = {}) {
  return createMcpHandler({
    version: '9.9.9',
    instructions: 'how to',
    tools: () => [
      {
        name: 'echo',
        title: 'Echo',
        description: 'd',
        inputSchema: { type: 'object' },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
    ],
    callTool: async (_n, args, ctx) => textResult(`${ctx.client}:${JSON.stringify(args)}`),
    ...over,
  });
}
const ctx = { protocolVersion: null, sessionId: null };
const init = (v: string, name = 'Claude Code') => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: v, clientInfo: { name, version: '1' }, capabilities: {} },
});

describe('initialize', () => {
  it.each(['2025-11-25', '2025-06-18', '2025-03-26'])(
    'answers with the client version %s',
    async (v) => {
      const out = await make().handle(init(v), ctx);
      expect(out.status).toBe(200);
      const r = (out.body as { result: Record<string, unknown> }).result;
      expect(r.protocolVersion).toBe(v);
      expect(r.capabilities).toEqual({ tools: {} });
      expect((r.serverInfo as { name: string; version: string }).name).toBe('plasma');
      expect((r.serverInfo as { version: string }).version).toBe('9.9.9');
      expect(r.instructions).toBe('how to');
      expect(out.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    },
  );
  it('falls back to our newest for an unknown version', async () => {
    const out = await make().handle(init('2024-11-05'), ctx);
    expect((out.body as { result: { protocolVersion: string } }).result.protocolVersion).toBe(
      '2025-11-25',
    );
    expect(negotiateVersion(5)).toBe('2025-11-25');
  });
  it('remembers the client name for tool calls of that session', async () => {
    const h = make();
    const i = await h.handle(init('2025-06-18', 'Cursor'), ctx);
    const out = await h.handle(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'echo', arguments: { a: 1 } },
      },
      { protocolVersion: '2025-06-18', sessionId: i.sessionId ?? null },
    );
    expect(JSON.stringify(out.body)).toContain('Cursor:{\\"a\\":1}');
  });
  it('answers 404 for a session it does not know, and accepts none', async () => {
    const h = make();
    const bad = await h.handle(
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { protocolVersion: null, sessionId: 'ghost' },
    );
    expect(bad.status).toBe(404);
    const ok = await h.handle({ jsonrpc: '2.0', id: 1, method: 'ping' }, ctx);
    expect(ok).toEqual({ status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } });
  });
});

describe('messages', () => {
  it('202 for notifications and for client responses', async () => {
    const h = make();
    expect(
      (await h.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx)).status,
    ).toBe(202);
    expect((await h.handle({ jsonrpc: '2.0', id: 3, result: {} }, ctx)).status).toBe(202);
  });
  it('-32601 for an unknown method', async () => {
    const out = await make().handle({ jsonrpc: '2.0', id: 4, method: 'resources/list' }, ctx);
    expect((out.body as { error: { code: number } }).error.code).toBe(RPC.methodNotFound);
  });
  it('-32600 for things that are not requests', async () => {
    const h = make();
    for (const bad of [
      42,
      'x',
      null,
      { id: 1 },
      { jsonrpc: '1.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: {}, method: 'ping' },
    ]) {
      const out = await h.handle(bad, ctx);
      expect((out.body as { error: { code: number } }).error.code).toBe(RPC.invalidRequest);
    }
  });
  it('lists tools with annotations', async () => {
    const out = await make().handle({ jsonrpc: '2.0', id: 5, method: 'tools/list' }, ctx);
    const tools = (out.body as { result: { tools: Array<{ name: string; annotations: object }> } })
      .result.tools;
    expect(tools[0]?.name).toBe('echo');
    expect(tools[0]?.annotations).toBeTruthy();
  });
  it('unknown tool is -32602; bad arguments are a tool error', async () => {
    const h = make();
    const u = await h.handle(
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope' } },
      ctx,
    );
    expect((u.body as { error: { code: number } }).error.code).toBe(RPC.invalidParams);
    const a = await h.handle(
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'echo', arguments: [1] } },
      ctx,
    );
    expect((a.body as { result: { isError: boolean } }).result.isError).toBe(true);
  });
  it('a tool that throws becomes isError without the message', async () => {
    const h = make({
      callTool: async () => {
        throw new Error('secret host db.corp');
      },
    });
    const out = await h.handle(
      { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'echo' } },
      ctx,
    );
    const text = JSON.stringify(out.body);
    expect(text).toContain('isError');
    expect(text).not.toContain('db.corp');
  });
});

describe('batches', () => {
  const batch = [
    { jsonrpc: '2.0', id: 1, method: 'ping' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'ping' },
  ];
  it('are handled on 2025-03-26 (and when no version header is sent)', async () => {
    for (const v of ['2025-03-26', null]) {
      const out = await make().handle(batch, { protocolVersion: v, sessionId: null });
      expect(out.status).toBe(200);
      expect(out.body).toHaveLength(2);
    }
    expect((await make().handle([{ jsonrpc: '2.0', method: 'x' }], ctx)).status).toBe(202);
  });
  it('are refused on newer revisions, and when empty', async () => {
    const out = await make().handle(batch, { protocolVersion: '2025-06-18', sessionId: null });
    expect(out.status).toBe(400);
    expect((await make().handle([], ctx)).status).toBe(400);
  });
});

describe('concurrency cap', () => {
  it('refuses the call beyond the limit and frees the slot afterwards', async () => {
    const release: Array<() => void> = [];
    const h = make({
      maxInFlight: 2,
      callTool: () => new Promise((resolve) => release.push(() => resolve(textResult('ok')))),
    });
    const call = (id: number) =>
      h.handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'echo' } }, ctx);
    const a = call(1);
    const b = call(2);
    await new Promise((r) => setTimeout(r, 5));
    expect(h.inFlight()).toBe(2);
    const c = await call(3);
    expect(JSON.stringify(c.body)).toContain('Plasma is busy, try again.');
    for (const r of release) r();
    await Promise.all([a, b]);
    expect(h.inFlight()).toBe(0);
  });
  it('abortAll and notifications/cancelled reach the running call', async () => {
    let seen: AbortSignal | undefined;
    const h = make({
      callTool: (_n, _a, c) =>
        new Promise((resolve) => {
          seen = c.signal;
          c.signal.addEventListener('abort', () => resolve(textResult('aborted', true)));
        }),
    });
    const p = h.handle(
      { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'echo' } },
      ctx,
    );
    await new Promise((r) => setTimeout(r, 5));
    await h.handle(
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 9 } },
      ctx,
    );
    await p;
    expect(seen?.aborted).toBe(true);
    const q = h.handle(
      { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'echo' } },
      ctx,
    );
    await new Promise((r) => setTimeout(r, 5));
    h.abortAll();
    expect(JSON.stringify((await q).body)).toContain('aborted');
  });
});
