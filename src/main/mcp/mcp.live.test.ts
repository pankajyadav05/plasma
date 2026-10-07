import type { ConnectionConfig } from '@shared/protocol';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runIsolatedIntrospect, runIsolatedReadOnlyQuery } from '../../workers/test-connect';
import { createIsolatedSessions } from '../isolated-session';
import { maskForMcp } from './mask';
import { createMcpHandler } from './protocol';
import { scrubErrorForMcp, scrubValuesFor } from './scrub';
import { createMcpHttpServer } from './server';
import { conn, fakeToolsDeps } from './test-support';
import { MCP_INSTRUCTIONS, createMcpTools } from './tools';

/**
 * Opt-in live check of the MCP read path on a saved connection that is NOT
 * open: the real `runIsolatedRead` / `introspectIsolated` (config lookup, TLS
 * gate, history), the real masking and the real error scrubbing, against a
 * Postgres. Only the worker process is stood in for (its request is handed to
 * the same functions the worker calls).
 *
 *   PLASMA_LIVE_PG=postgres://postgres@127.0.0.1:5512/postgres pnpm vitest run src/main/mcp/mcp.live.test.ts
 */
const url = process.env.PLASMA_LIVE_PG;
const suite = url ? describe : describe.skip;
const scratch = `plasma_mcp_${Math.random().toString(36).slice(2, 10)}`;
const TOKEN = 'L'.repeat(43);
const history: Array<{ connectionId: string; sql: string; error: string | null }> = [];

function configFor(database: string): ConnectionConfig {
  const u = new URL(url as string);
  return {
    id: 'live1',
    name: 'Live',
    engine: 'postgres',
    host: u.hostname,
    port: Number(u.port || 5432),
    database,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    ssl: false,
    readOnly: false,
  } as ConnectionConfig;
}

suite('MCP on a saved, not-open connection (live)', () => {
  let admin: pg.Client;
  let port = 0;
  let close: () => Promise<void>;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${scratch}`);
    const c = new pg.Client(configFor(scratch));
    await c.connect();
    await c.query('CREATE TABLE users (id int primary key, email text, note text)');
    await c.query(
      "INSERT INTO users VALUES (1, 'ann@example.com', 'hi'), (2, 'bob@example.com', 'yo')",
    );
    await c.query('CREATE TABLE orders (id int primary key, user_id int references users(id))');
    await c.end();

    const config = configFor(scratch);
    history.length = 0;
    const sessions = createIsolatedSessions({
      resolveConfig: (id) => (id === config.id ? config : null),
      loadSaved: () => null,
      settings: () => ({ connectionTags: {}, connectionSsh: {} }) as never,
      withTlsFiles: async (c) => c,
      sshFor: () => null,
      openTunnel: async () => {
        throw new Error('no tunnel in this test');
      },
      closeTunnel: () => undefined,
      // The worker's job, done in process.
      callWorker: (async (req: {
        kind: string;
        config: ConnectionConfig;
        sql?: string;
        maxRows?: number;
      }) => {
        if (req.kind === 'compareQuery') {
          return {
            result: await runIsolatedReadOnlyQuery(
              req.config,
              req.sql as string,
              req.maxRows as number,
            ),
          };
        }
        return { info: await runIsolatedIntrospect(req.config) };
      }) as never,
      recordHistory: (e) => history.push(e),
      log: () => undefined,
    });
    const { deps } = fakeToolsDeps({
      list: [conn({ id: 'live1', name: 'Live', access: 'read', openInPlasma: false })],
      runRead: (id, sql, maxRows) =>
        sessions.runIsolatedRead(id, sql, maxRows, { timeoutMs: 30_000 }),
      schema: (id) => sessions.introspectIsolated(id),
      maskRows: (_id, cols, rows) => maskForMcp(cols, rows, { unmasked: false, style: 'initial' }),
      scrub: (_id, text) => scrubErrorForMcp(text, scrubValuesFor(config, null)),
    });
    const tools = createMcpTools(deps);
    const http = createMcpHttpServer({
      handler: createMcpHandler({
        version: '1',
        instructions: MCP_INSTRUCTIONS,
        tools: tools.defs,
        callTool: (n, a, c) => tools.call(n, a, c),
      }),
      token: () => TOKEN,
    });
    port = await http.listen(0);
    close = () => http.close();
  });

  afterAll(async () => {
    await close?.();
    await admin?.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
    await admin?.end();
  });

  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    return (await r.json()).result as { isError?: boolean; content: Array<{ text: string }> };
  };

  it('get_schema introspects the connection that is not open', async () => {
    const out = await call('get_schema', { connection: 'Live' });
    expect(out.isError).toBeUndefined();
    expect(out.content[0]?.text).toContain('public.users (id integer PK NOT NULL');
    expect(out.content[0]?.text).toContain('FK: user_id -> public.users.id');
  });

  it('run_query reads through the isolated read-only session', async () => {
    const out = await call('run_query', {
      connection: 'live1',
      sql: 'SELECT id, note FROM users ORDER BY id',
    });
    expect(JSON.parse(out.content[0]?.text ?? '{}').rows).toEqual([
      { id: 1, note: 'hi' },
      { id: 2, note: 'yo' },
    ]);
    // the real session recorded it in history
    expect(history.at(-1)).toMatchObject({ connectionId: 'live1', error: null });
  });

  it('masks e-mail addresses by default', async () => {
    const out = await call('run_query', {
      connection: 'live1',
      sql: 'SELECT id, email FROM users ORDER BY id',
    });
    const text = out.content[0]?.text ?? '';
    expect(text).not.toContain('ann@example.com');
    expect(text).not.toContain('bob@example.com');
    expect(JSON.parse(text).rows[0].email).toMatch(/•/);
  });

  it('a write hidden in a CTE is refused, and nothing changes', async () => {
    const sql = 'WITH d AS (DELETE FROM users WHERE id = 1 RETURNING id) SELECT * FROM d';
    const out = await call('run_query', { connection: 'live1', sql });
    expect(out.isError).toBe(true);
    // Even if the keyword guard were fooled, the session itself is read-only:
    await expect(runIsolatedReadOnlyQuery(configFor(scratch), sql, 10)).rejects.toThrow(
      /read-only/i,
    );
    const after = await call('run_query', {
      connection: 'live1',
      sql: 'SELECT count(*)::int AS n FROM users',
    });
    expect(JSON.parse(after.content[0]?.text ?? '{}').rows).toEqual([{ n: 2 }]);
  });

  it('a database error reaches the client without host or user', async () => {
    const out = await call('run_query', { connection: 'live1', sql: 'SELECT * FROM nope' });
    expect(out.isError).toBe(true);
    expect(out.content[0]?.text).toContain('nope');
    const text = out.content[0]?.text ?? '';
    expect(text).not.toContain(
      configFor(scratch).host === '127.0.0.1' ? '127.0.0.1' : configFor(scratch).host,
    );
    expect(text).not.toContain(`${configFor(scratch).user}@`);
  });

  it('a connection that cannot be reached says so without host, port or user', async () => {
    const dead = { ...configFor(scratch), id: 'dead', port: 1 };
    const sessions = createIsolatedSessions({
      resolveConfig: () => dead,
      loadSaved: () => null,
      settings: () => ({ connectionTags: {}, connectionSsh: {} }) as never,
      withTlsFiles: async (c) => c,
      sshFor: () => null,
      openTunnel: async () => {
        throw new Error('no');
      },
      closeTunnel: () => undefined,
      callWorker: (async (req: { config: ConnectionConfig; sql: string; maxRows: number }) => ({
        result: await runIsolatedReadOnlyQuery(req.config, req.sql, req.maxRows),
      })) as never,
      recordHistory: () => undefined,
      log: () => undefined,
    });
    const raw = await sessions
      .runIsolatedRead('dead', 'select 1', 10)
      .catch((e: Error) => e.message);
    expect(String(raw)).toBeTruthy();
    const clean = scrubErrorForMcp(String(raw), scrubValuesFor(dead, null));
    expect(clean).not.toContain('127.0.0.1');
  });
});
