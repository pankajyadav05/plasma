import { afterEach, describe, expect, it } from 'vitest';
import type { McpToolDef } from '../mcp/protocol';
import { type ToolEndpoint, createToolEndpoint, mcpToolsFromOpenAi } from './tool-endpoint';

const tool = (name: string): McpToolDef => ({
  name,
  title: name,
  description: `the ${name} tool`,
  inputSchema: { type: 'object', properties: { sql: { type: 'string' } } },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
});

async function rpc(
  url: string,
  token: string | null,
  body: unknown,
  extra: Record<string, string> = {},
) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extra,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

describe('tool endpoint', () => {
  let endpoint: ToolEndpoint;
  afterEach(async () => {
    await endpoint?.close();
  });

  it('serves exactly the registered tools to the chat that owns the token', async () => {
    endpoint = createToolEndpoint();
    const reg = await endpoint.register({
      tools: [tool('run_query'), tool('show_table')],
      call: async () => 'x',
    });
    expect(reg.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(reg.token.length).toBeGreaterThanOrEqual(43);
    const list = await rpc(reg.url, reg.token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(list.status).toBe(200);
    expect(list.json.result.tools.map((t: { name: string }) => t.name)).toEqual([
      'run_query',
      'show_table',
    ]);
  });

  it('keeps two chats apart', async () => {
    endpoint = createToolEndpoint();
    const a = await endpoint.register({ tools: [tool('a_tool')], call: async () => 'A' });
    const b = await endpoint.register({ tools: [tool('b_tool')], call: async () => 'B' });
    expect(a.url).toBe(b.url);
    expect(a.token).not.toBe(b.token);
    const la = await rpc(a.url, a.token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const lb = await rpc(b.url, b.token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(la.json.result.tools[0].name).toBe('a_tool');
    expect(lb.json.result.tools[0].name).toBe('b_tool');
    // a's token cannot call b's tool
    const cross = await rpc(a.url, a.token, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'b_tool', arguments: {} },
    });
    expect(cross.json.error.message).toMatch(/Unknown tool/);
  });

  it('answers 401 to no token, a wrong token and an unknown token', async () => {
    endpoint = createToolEndpoint();
    const reg = await endpoint.register({ tools: [tool('t')], call: async () => 'x' });
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    expect((await rpc(reg.url, null, body)).status).toBe(401);
    expect((await rpc(reg.url, 'nope', body)).status).toBe(401);
    expect((await rpc(reg.url, `${reg.token}x`, body)).status).toBe(401);
  });

  it('refuses a foreign Host header, any Origin, other paths and GET', async () => {
    endpoint = createToolEndpoint();
    const reg = await endpoint.register({ tools: [tool('t')], call: async () => 'x' });
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    const base = { 'content-type': 'application/json', authorization: `Bearer ${reg.token}` };
    const withOrigin = await fetch(reg.url, {
      method: 'POST',
      headers: { ...base, origin: 'https://evil.example' },
      body: JSON.stringify(body),
    });
    expect(withOrigin.status).toBe(403);
    const other = await fetch(reg.url.replace('/mcp', '/other'), {
      method: 'POST',
      headers: base,
      body: JSON.stringify(body),
    });
    expect(other.status).toBe(404);
    const get = await fetch(reg.url, { headers: base });
    expect(get.status).toBe(405);
    // Host check: a raw request with a rebound name.
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve) => {
      const u = new URL(reg.url);
      const r = request(
        {
          host: '127.0.0.1',
          port: u.port,
          path: '/mcp',
          method: 'POST',
          headers: { ...base, host: 'evil.example' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      r.end(JSON.stringify(body));
    });
    expect(status).toBe(403);
  });

  it('runs tools/call through the chat`s own call function', async () => {
    endpoint = createToolEndpoint();
    const seen: Array<[string, unknown]> = [];
    const reg = await endpoint.register({
      tools: [tool('run_query')],
      call: async (name, args) => {
        seen.push([name, args]);
        return '{"outcome":"applied"}';
      },
    });
    const res = await rpc(reg.url, reg.token, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'run_query', arguments: { sql: 'select 1' } },
    });
    expect(seen).toEqual([['run_query', { sql: 'select 1' }]]);
    expect(res.json.result).toEqual({ content: [{ type: 'text', text: '{"outcome":"applied"}' }] });
  });

  it('marks an error answer as an error result', async () => {
    endpoint = createToolEndpoint();
    const reg = await endpoint.register({
      tools: [tool('run_query')],
      call: async () => '{"error":"rejected: nope"}',
    });
    const res = await rpc(reg.url, reg.token, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'run_query', arguments: {} },
    });
    expect(res.json.result.isError).toBe(true);
  });

  it('does not offer, or run, a tool that was not registered', async () => {
    endpoint = createToolEndpoint();
    let called = false;
    const reg = await endpoint.register({
      tools: [tool('run_query')],
      call: async () => {
        called = true;
        return 'x';
      },
    });
    const res = await rpc(reg.url, reg.token, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'propose_change', arguments: { sql: 'drop table x' } },
    });
    expect(res.json.error.message).toMatch(/Unknown tool/);
    expect(called).toBe(false);
  });

  it('revokes the token when the run ends, and stops listening with the last chat', async () => {
    endpoint = createToolEndpoint();
    const a = await endpoint.register({ tools: [tool('t')], call: async () => 'x' });
    const b = await endpoint.register({ tools: [tool('t')], call: async () => 'x' });
    expect(endpoint.size()).toBe(2);
    a.revoke();
    expect(endpoint.size()).toBe(1);
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    expect((await rpc(a.url, a.token, body)).status).toBe(401);
    expect((await rpc(b.url, b.token, body)).status).toBe(200);
    b.revoke();
    expect(endpoint.size()).toBe(0);
    await expect(rpc(b.url, b.token, body)).rejects.toBeTruthy();
    // A later chat gets a fresh server.
    const c = await endpoint.register({ tools: [tool('t')], call: async () => 'x' });
    expect((await rpc(c.url, c.token, body)).status).toBe(200);
  });

  it('aborts a running call when its chat is revoked', async () => {
    endpoint = createToolEndpoint();
    let aborted = false;
    const reg = await endpoint.register({
      tools: [tool('slow')],
      call: (_n, _a, signal) =>
        new Promise<string>((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve('{"error":"stopped"}');
          });
        }),
    });
    const pending = rpc(reg.url, reg.token, {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'slow', arguments: {} },
    });
    await new Promise((r) => setTimeout(r, 100));
    reg.revoke();
    await pending.catch(() => undefined);
    expect(aborted).toBe(true);
  });
});

describe('mcpToolsFromOpenAi', () => {
  it('converts a function spec into an MCP tool with the same schema', () => {
    const [t] = mcpToolsFromOpenAi([
      {
        type: 'function',
        function: {
          name: 'run_query',
          description: 'Run it.',
          parameters: {
            type: 'object',
            properties: { sql: { type: 'string' } },
            required: ['sql'],
          },
        },
      },
    ]);
    expect(t).toMatchObject({
      name: 'run_query',
      description: 'Run it.',
      inputSchema: { type: 'object', required: ['sql'] },
    });
  });
});
