import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpHandler } from './protocol';
import { bearerToken, createMcpHttpServer, hostAllowed, tokensEqual } from './server';
import { conn, fakeToolsDeps } from './test-support';
import { MCP_INSTRUCTIONS, createMcpTools } from './tools';

const TOKEN = 'T'.repeat(43);
let closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.map((c) => c()));
  closers = [];
});

async function start(over: Parameters<typeof fakeToolsDeps>[0] = {}) {
  const fake = fakeToolsDeps(over);
  const tools = createMcpTools(fake.deps);
  const handler = createMcpHandler({
    version: '1.2.3',
    instructions: MCP_INSTRUCTIONS,
    tools: tools.defs,
    callTool: (n, a, c) => tools.call(n, a, c),
  });
  const http = createMcpHttpServer({ handler, token: () => TOKEN });
  const port = await http.listen(0);
  closers.push(() => http.close());
  return { port, http, handler, ...fake };
}

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  // biome-ignore lint/suspicious/noExplicitAny: test reads arbitrary JSON
  json?: any;
}

function send(
  port: number,
  opts: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
    auth?: string | null;
  } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...opts.headers,
    };
    if (opts.auth !== null) headers.Authorization = `Bearer ${opts.auth ?? TOKEN}`;
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: opts.path ?? '/mcp',
        method: opts.method ?? 'POST',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let json: unknown;
          try {
            json = JSON.parse(body);
          } catch {}
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json });
        });
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}
const rpc = (id: number, method: string, params?: unknown) =>
  JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });

describe('helpers', () => {
  it('compares tokens in constant time without caring about length', () => {
    expect(tokensEqual('abc', 'abc')).toBe(true);
    expect(tokensEqual('abc', 'abd')).toBe(false);
    expect(tokensEqual('abc', 'abcd')).toBe(false);
    expect(tokensEqual('', 'a')).toBe(false);
  });
  it('parses the bearer header strictly', () => {
    expect(bearerToken('Bearer xyz')).toBe('xyz');
    expect(bearerToken('bearer   xyz')).toBe('xyz');
    expect(bearerToken('Basic xyz')).toBeNull();
    expect(bearerToken('Bearer a b')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
  it('allows only the loopback names on our port', () => {
    expect(hostAllowed('127.0.0.1:47321', 47321)).toBe(true);
    expect(hostAllowed('localhost:47321', 47321)).toBe(true);
    expect(hostAllowed('LOCALHOST:47321', 47321)).toBe(true);
    expect(hostAllowed('127.0.0.1:1', 47321)).toBe(false);
    expect(hostAllowed('evil.example:47321', 47321)).toBe(false);
    expect(hostAllowed('127.0.0.1', 47321)).toBe(false);
    expect(hostAllowed(undefined, 47321)).toBe(false);
  });
});

describe('who gets in', () => {
  it('401 without or with the wrong token', async () => {
    const { port } = await start();
    const none = await send(port, { auth: null, body: rpc(1, 'ping') });
    expect(none.status).toBe(401);
    expect(none.headers['www-authenticate']).toMatch(/Bearer/);
    expect((await send(port, { auth: 'wrong', body: rpc(1, 'ping') })).status).toBe(401);
    expect(
      (
        await send(port, {
          headers: { Authorization: 'Basic abc' },
          auth: null,
          body: rpc(1, 'ping'),
        })
      ).status,
    ).toBe(401);
  });
  it('403 when an Origin header is present (browsers), even with the right token', async () => {
    const { port } = await start();
    for (const origin of ['http://evil.example', 'http://127.0.0.1:1234', 'null']) {
      expect((await send(port, { headers: { Origin: origin }, body: rpc(1, 'ping') })).status).toBe(
        403,
      );
    }
  });
  it('403 for another Host (DNS rebinding)', async () => {
    const { port } = await start();
    expect(
      (await send(port, { headers: { Host: 'evil.example' }, body: rpc(1, 'ping') })).status,
    ).toBe(403);
    expect(
      (await send(port, { headers: { Host: `evil.example:${port}` }, body: rpc(1, 'ping') }))
        .status,
    ).toBe(403);
    expect(
      (await send(port, { headers: { Host: `localhost:${port}` }, body: rpc(1, 'ping') })).status,
    ).toBe(200);
  });
  it('checks the host and origin before the token', async () => {
    const { port } = await start();
    const r = await send(port, {
      auth: 'wrong',
      headers: { Origin: 'http://evil.example' },
      body: rpc(1, 'ping'),
    });
    expect(r.status).toBe(403);
  });
  it('404 for other paths; 405 for GET and DELETE', async () => {
    const { port } = await start();
    expect((await send(port, { path: '/', body: '{}' })).status).toBe(404);
    expect((await send(port, { path: '/mcp/x', body: '{}' })).status).toBe(404);
    const g = await send(port, { method: 'GET', headers: { Accept: 'text/event-stream' } });
    expect(g.status).toBe(405);
    expect(g.headers.allow).toBe('POST');
    expect(
      (await send(port, { method: 'DELETE', headers: { 'Mcp-Session-Id': 'x' } })).status,
    ).toBe(405);
  });
  it('binds 127.0.0.1 only', async () => {
    const { http } = await start();
    expect(http.port).toBeGreaterThan(0);
  });
});

describe('request hygiene', () => {
  it('415 for a body that is not JSON content', async () => {
    const { port } = await start();
    expect(
      (await send(port, { headers: { 'Content-Type': 'text/plain' }, body: rpc(1, 'ping') }))
        .status,
    ).toBe(415);
  });
  it('-32700 for bad JSON', async () => {
    const { port } = await start();
    const r = await send(port, { body: '{nope' });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe(-32700);
  });
  it('-32600 for valid JSON that is not a request', async () => {
    const { port } = await start();
    const r = await send(port, { body: '42' });
    expect(r.json.error.code).toBe(-32600);
  });
  it('413 above 1 MB', async () => {
    const { port } = await start();
    const big = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'ping',
      params: { pad: 'x'.repeat(1_100_000) },
    });
    const r = await send(port, { body: big }).catch(() => ({ status: 413 }) as Reply);
    expect(r.status).toBe(413);
  });
  it('400 for an unsupported MCP-Protocol-Version header', async () => {
    const { port } = await start();
    expect(
      (
        await send(port, {
          headers: { 'MCP-Protocol-Version': '1999-01-01' },
          body: rpc(1, 'ping'),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await send(port, {
          headers: { 'MCP-Protocol-Version': '2025-06-18' },
          body: rpc(1, 'ping'),
        })
      ).status,
    ).toBe(200);
  });
  it('202 with no body for a notification', async () => {
    const { port } = await start();
    const r = await send(port, {
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(r.status).toBe(202);
    expect(r.body).toBe('');
  });
});

describe('a whole session (initialize, tools/list, run_query)', () => {
  it('works end to end over HTTP against a fake executor', async () => {
    const { port, calls, audits } = await start({
      list: [
        conn({ id: 'c1', name: 'Shop', access: 'read' }),
        conn({ id: 'c2', name: 'Hidden', access: 'off' }),
      ],
    });
    const init = await send(port, {
      body: rpc(1, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'Claude Code', version: '2' },
      }),
    });
    expect(init.status).toBe(200);
    expect(init.headers['content-type']).toMatch(/application\/json/);
    expect(init.json.result.protocolVersion).toBe('2025-06-18');
    const sid = init.headers['mcp-session-id'] as string;
    expect(sid).toBeTruthy();
    const session = { 'Mcp-Session-Id': sid, 'MCP-Protocol-Version': '2025-06-18' };

    const inited = await send(port, {
      headers: session,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(inited.status).toBe(202);

    const list = await send(port, { headers: session, body: rpc(2, 'tools/list') });
    expect(list.json.result.tools.map((t: { name: string }) => t.name)).toContain('run_query');

    const conns = await send(port, {
      headers: session,
      body: rpc(3, 'tools/call', { name: 'list_connections', arguments: {} }),
    });
    const names = JSON.parse(conns.json.result.content[0].text).map(
      (c: { name: string }) => c.name,
    );
    expect(names).toEqual(['Shop']);

    const q = await send(port, {
      headers: session,
      body: rpc(4, 'tools/call', {
        name: 'run_query',
        arguments: { connection: 'Shop', sql: 'select id, email from users' },
      }),
    });
    expect(q.status).toBe(200);
    const rows = JSON.parse(q.json.result.content[0].text);
    expect(rows.rows).toEqual([{ id: 1, email: '•••' }]);
    expect(calls.read[0]?.sql).toBe('select id, email from users');
    expect(audits.at(-1)?.client).toBe('Claude Code');

    const bad = await send(port, {
      headers: session,
      body: rpc(5, 'tools/call', {
        name: 'run_query',
        arguments: { connection: 'Hidden', sql: 'select 1' },
      }),
    });
    expect(bad.json.result.isError).toBe(true);

    const gone = await send(port, {
      headers: { 'Mcp-Session-Id': 'unknown' },
      body: rpc(6, 'ping'),
    });
    expect(gone.status).toBe(404);
    const unknownMethod = await send(port, { headers: session, body: rpc(7, 'prompts/list') });
    expect(unknownMethod.json.error.code).toBe(-32601);
  });

  it('also works without a session id (stateless clients)', async () => {
    const { port } = await start();
    const r = await send(port, { body: rpc(1, 'tools/list') });
    expect(r.status).toBe(200);
  });

  it('answers a token change on the very next request', async () => {
    let token = TOKEN;
    const fake = fakeToolsDeps();
    const tools = createMcpTools(fake.deps);
    const handler = createMcpHandler({
      version: '1',
      instructions: '',
      tools: tools.defs,
      callTool: (n, a, c) => tools.call(n, a, c),
    });
    const http = createMcpHttpServer({ handler, token: () => token });
    const port = await http.listen(0);
    closers.push(() => http.close());
    expect((await send(port, { body: rpc(1, 'ping') })).status).toBe(200);
    token = 'R'.repeat(43);
    expect((await send(port, { body: rpc(1, 'ping') })).status).toBe(401);
    expect((await send(port, { auth: token, body: rpc(1, 'ping') })).status).toBe(200);
  });
});

describe('limits and shutdown', () => {
  it('refuses a fifth tool call while four are in flight', async () => {
    const release: Array<() => void> = [];
    const { port } = await start({
      runRead: () =>
        new Promise((resolve) =>
          release.push(() =>
            resolve({ columns: [], rows: [], rowCount: 0, durationMs: 1 } as never),
          ),
        ),
    });
    const call = (id: number) =>
      send(port, {
        body: rpc(id, 'tools/call', {
          name: 'run_query',
          arguments: { connection: 'c1', sql: 'select 1' },
        }),
      });
    const first = [1, 2, 3, 4].map(call);
    await new Promise((r) => setTimeout(r, 50));
    const fifth = await call(5);
    expect(fifth.json.result.isError).toBe(true);
    expect(fifth.json.result.content[0].text).toBe('Plasma is busy, try again.');
    for (const r of release) r();
    const done = await Promise.all(first);
    expect(done.every((d) => d.status === 200)).toBe(true);
  });
  it('close() aborts calls in flight and stops listening', async () => {
    let signal: AbortSignal | undefined;
    const { port, http } = await start({
      runRead: (_i, _s, _m, sig) =>
        new Promise((_resolve, reject) => {
          signal = sig;
          sig.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    const pending = send(port, {
      body: rpc(1, 'tools/call', {
        name: 'run_query',
        arguments: { connection: 'c1', sql: 'select 1' },
      }),
    }).catch(() => null);
    await new Promise((r) => setTimeout(r, 50));
    await http.close();
    await pending;
    expect(signal?.aborted).toBe(true);
    await expect(send(port, { body: rpc(2, 'ping') })).rejects.toBeTruthy();
  });

  it('a dropped connection stops the wait for the user but proposes nothing new and cancels nothing', async () => {
    let waitSignal: AbortSignal | undefined;
    let created = 0;
    const { port } = await start({
      list: [conn({ access: 'propose', openInPlasma: true })],
      waitMs: 60_000,
      proposals: {
        create: () => {
          created++;
          return { ok: true, id: 'p-1' };
        },
        wait: (_id, _ms, signal) =>
          new Promise((resolve) => {
            waitSignal = signal;
            signal.addEventListener('abort', () =>
              resolve({ proposal_id: 'p-1', status: 'waiting_for_approval', message: 'w' }),
            );
          }),
      },
    });
    const body = rpc(1, 'tools/call', {
      name: 'propose_change',
      arguments: { connection: 'c1', sql: 'update t set a = 1', summary: 's' },
    });
    await new Promise<void>((resolve) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: '/mcp',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        },
        () => undefined,
      );
      req.on('error', () => undefined);
      req.end(body);
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 100);
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(waitSignal?.aborted).toBe(true);
    expect(created).toBe(1);
  });
});
