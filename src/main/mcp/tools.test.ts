import { MCP_MAX_ROWS } from '@shared/mcp';
import { describe, expect, it } from 'vitest';
import type { ToolContext } from './protocol';
import { conn, fakeToolsDeps, queryResult, schemaInfo } from './test-support';
import { createMcpTools, mcpToolDefs, narrowSchema } from './tools';

const ctx = (client = 'Claude Code'): ToolContext => ({
  client,
  signal: new AbortController().signal,
});
const text = (r: { content: Array<{ text: string }> }) => r.content[0]?.text ?? '';

describe('tool definitions', () => {
  it('lists the four tools with schemas and hints', () => {
    const defs = mcpToolDefs();
    expect(defs.map((d) => d.name)).toEqual([
      'list_connections',
      'get_schema',
      'run_query',
      'propose_change',
    ]);
    expect(defs.find((d) => d.name === 'run_query')?.annotations.readOnlyHint).toBe(true);
    expect(defs.find((d) => d.name === 'propose_change')?.annotations.destructiveHint).toBe(true);
  });
});

describe('list_connections', () => {
  it('lists only connections that are on, with no host, user or paths', async () => {
    const { deps } = fakeToolsDeps({
      list: [conn({ id: 'a', name: 'On' }), conn({ id: 'b', name: 'Off', access: 'off' })],
    });
    const out = await createMcpTools(deps).call('list_connections', {}, ctx());
    const rows = JSON.parse(text(out));
    expect(rows).toEqual([
      {
        id: 'a',
        name: 'On',
        engine: 'postgres',
        access: 'read',
        readOnly: false,
        production: false,
        openInPlasma: false,
      },
    ]);
    expect(text(out)).not.toMatch(/host|user|password|port|database/i);
  });
});

describe('connection resolution', () => {
  it('accepts an id or an exact name, and explains an ambiguous name', async () => {
    const { deps, calls } = fakeToolsDeps({
      list: [
        conn({ id: 'a', name: 'Same' }),
        conn({ id: 'b', name: 'Same' }),
        conn({ id: 'c', name: 'Solo' }),
      ],
    });
    const t = createMcpTools(deps);
    await t.call('run_query', { connection: 'Solo', sql: 'select 1' }, ctx());
    await t.call('run_query', { connection: 'a', sql: 'select 1' }, ctx());
    expect(calls.read.map((r) => r.id)).toEqual(['c', 'a']);
    const amb = await t.call('run_query', { connection: 'Same', sql: 'select 1' }, ctx());
    expect(amb.isError).toBe(true);
    expect(text(amb)).toContain('a, b');
  });
  it('cannot see a connection that is off', async () => {
    const { deps } = fakeToolsDeps({ list: [conn({ access: 'off' })] });
    const out = await createMcpTools(deps).call(
      'run_query',
      { connection: 'Shop', sql: 'select 1' },
      ctx(),
    );
    expect(out.isError).toBe(true);
    expect(text(out)).toContain('list_connections');
  });
});

describe('access per tool and level', () => {
  const levels = ['schema', 'read', 'propose'] as const;
  const run = async (
    access: (typeof levels)[number],
    tool: string,
    args: Record<string, unknown>,
  ) => {
    const { deps, calls } = fakeToolsDeps({ list: [conn({ access, openInPlasma: true })] });
    const out = await createMcpTools(deps).call(tool, { connection: 'c1', ...args }, ctx());
    return { out, calls };
  };
  it('schema: structure yes, queries and changes no', async () => {
    expect((await run('schema', 'get_schema', {})).out.isError).toBeUndefined();
    const q = await run('schema', 'run_query', { sql: 'select 1' });
    expect(q.out.isError).toBe(true);
    expect(q.calls.read).toHaveLength(0);
    const p = await run('schema', 'propose_change', { sql: 'delete from t', summary: 's' });
    expect(p.out.isError).toBe(true);
    expect(p.calls.propose).toHaveLength(0);
  });
  it('read: queries yes, changes no', async () => {
    expect((await run('read', 'run_query', { sql: 'select 1' })).out.isError).toBeUndefined();
    const p = await run('read', 'propose_change', { sql: 'delete from t', summary: 's' });
    expect(p.out.isError).toBe(true);
    expect(p.calls.propose).toHaveLength(0);
  });
  it('propose: everything', async () => {
    const p = await run('propose', 'propose_change', { sql: 'delete from t', summary: 's' });
    expect(p.out.isError).toBeUndefined();
    expect(p.calls.propose).toHaveLength(1);
  });
});

describe('get_schema', () => {
  it('returns compact structure, narrowed by schema and table, and caches for 60 s', async () => {
    let t = 1_000;
    const { deps, calls } = fakeToolsDeps({ now: () => t });
    const tools = createMcpTools(deps);
    const all = text(await tools.call('get_schema', { connection: 'c1' }, ctx()));
    expect(all).toContain('public.orders (id integer PK NOT NULL');
    expect(all).toContain('FK: user_id -> public.users.id');
    expect(all).toContain('other.misc');
    const one = text(
      await tools.call(
        'get_schema',
        { connection: 'c1', schema: 'public', table: 'orders' },
        ctx(),
      ),
    );
    expect(one).not.toContain('misc');
    expect(one).toContain('INDEX: CREATE UNIQUE INDEX orders_pkey');
    expect(calls.schema).toBe(1);
    t += 61_000;
    await tools.call('get_schema', { connection: 'c1' }, ctx());
    expect(calls.schema).toBe(2);
  });
  it('says so for engines it cannot do and for a missing table', async () => {
    const redis = fakeToolsDeps({ list: [conn({ engine: 'redis' })] });
    const r = await createMcpTools(redis.deps).call('get_schema', { connection: 'c1' }, ctx());
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('not supported over MCP yet');
    const { deps } = fakeToolsDeps();
    const none = await createMcpTools(deps).call(
      'get_schema',
      { connection: 'c1', table: 'ghost' },
      ctx(),
    );
    expect(none.isError).toBe(true);
  });
  it('narrowSchema keeps only what matches', () => {
    const n = narrowSchema(schemaInfo(), 'public', 'users');
    expect(n.tables.map((t) => t.name)).toEqual(['users']);
    expect(n.foreignKeys).toHaveLength(0);
  });
});

describe('run_query', () => {
  it('masks values by default and says whether it was cut', async () => {
    const { deps } = fakeToolsDeps();
    const out = await createMcpTools(deps).call(
      'run_query',
      { connection: 'c1', sql: 'select * from users' },
      ctx(),
    );
    const body = JSON.parse(text(out));
    expect(body.rows).toEqual([{ id: 1, email: '•••' }]);
    expect(body.truncated).toBe(false);
    expect(text(out)).not.toContain('ann@example.com');
  });
  it('caps rows: default 200, at most 1000, one extra row reveals truncation', async () => {
    const many = Array.from({ length: 6 }, (_, i) => [i, `u${i}`]);
    const { deps, calls } = fakeToolsDeps({
      runRead: async (id, sql, maxRows) => {
        calls.read.push({ id, sql, maxRows });
        return queryResult(many);
      },
    });
    const tools = createMcpTools(deps);
    await tools.call('run_query', { connection: 'c1', sql: 'select 1' }, ctx());
    await tools.call('run_query', { connection: 'c1', sql: 'select 1', max_rows: 99_999 }, ctx());
    expect(calls.read.map((r) => r.maxRows)).toEqual([201, MCP_MAX_ROWS + 1]);
    const cut = JSON.parse(
      text(
        await tools.call('run_query', { connection: 'c1', sql: 'select 1', max_rows: 3 }, ctx()),
      ),
    );
    expect(cut.rows).toHaveLength(3);
    expect(cut.truncated).toBe(true);
  });
  it('refuses writes, a hidden write in a CTE, several statements and unsupported engines', async () => {
    const { deps, calls } = fakeToolsDeps();
    const tools = createMcpTools(deps);
    for (const sql of [
      'delete from t',
      'with d as (delete from t returning *) select * from d',
      'select 1; select 2',
      'select pg_sleep(1); drop table t',
      "select setval('s', 1)",
    ]) {
      const out = await tools.call('run_query', { connection: 'c1', sql }, ctx());
      expect(out.isError, sql).toBe(true);
    }
    expect(calls.read).toHaveLength(0);
    const duck = fakeToolsDeps({ list: [conn({ engine: 'duckdb' })] });
    const d = await createMcpTools(duck.deps).call(
      'run_query',
      { connection: 'c1', sql: 'select 1' },
      ctx(),
    );
    expect(d.isError).toBe(true);
  });
  it('returns scrubbed database errors', async () => {
    const { deps } = fakeToolsDeps({
      runRead: async () => {
        throw new Error('connection to server at "db.internal.corp" failed for svc_user');
      },
    });
    const out = await createMcpTools(deps).call(
      'run_query',
      { connection: 'c1', sql: 'select 1' },
      ctx(),
    );
    expect(out.isError).toBe(true);
    expect(text(out)).not.toMatch(/db\.internal|svc_user/);
  });
});

describe('propose_change', () => {
  it('needs the connection to be open in Plasma', async () => {
    const { deps, calls } = fakeToolsDeps({
      list: [conn({ access: 'propose', openInPlasma: false })],
    });
    const out = await createMcpTools(deps).call(
      'propose_change',
      { connection: 'c1', sql: 'update t set a=1', summary: 's' },
      ctx(),
    );
    expect(out.isError).toBe(true);
    expect(text(out)).toBe('Open Shop in Plasma first, then try again.');
    expect(calls.propose).toHaveLength(0);
  });
  it('refuses a read-only connection', async () => {
    const { deps } = fakeToolsDeps({
      list: [conn({ access: 'propose', readOnly: true, openInPlasma: true })],
    });
    const out = await createMcpTools(deps).call(
      'propose_change',
      { connection: 'c1', sql: 'update t set a=1', summary: 's' },
      ctx(),
    );
    expect(out.isError).toBe(true);
  });
  it('passes the client name through and reports each outcome', async () => {
    const outcomes = [
      { kind: 'applied', rowsAffected: 3 },
      { kind: 'declined' },
      { kind: 'timeout' },
      { kind: 'failed', note: 'oops at db.internal.corp' },
      {
        kind: 'busy',
        note: 'The AI panel in Plasma is busy with another request. Try again in a moment.',
      },
    ] as const;
    const seen: unknown[] = [];
    let i = 0;
    const { deps } = fakeToolsDeps({
      list: [conn({ access: 'propose', openInPlasma: true })],
      propose: async (input) => {
        seen.push(input);
        return outcomes[i++] as never;
      },
    });
    const tools = createMcpTools(deps);
    const call = () =>
      tools.call(
        'propose_change',
        { connection: 'c1', sql: 'update t set a=1', summary: 'fix' },
        ctx('Cursor'),
      );
    expect(JSON.parse(text(await call()))).toEqual({ outcome: 'applied', rowsAffected: 3 });
    expect(JSON.parse(text(await call())).outcome).toBe('declined');
    const timeout = await call();
    expect(text(timeout)).toBe('No answer in Plasma; nothing was changed.');
    const failed = await call();
    expect(failed.isError).toBe(true);
    expect(text(failed)).not.toContain('db.internal.corp');
    expect((await call()).isError).toBe(true);
    expect((seen[0] as { client: string }).client).toBe('Cursor');
  });
});

describe('audit', () => {
  it('records client, tool, connection, sql (no rows), outcome and duration', async () => {
    const { deps, audits } = fakeToolsDeps();
    const tools = createMcpTools(deps);
    await tools.call(
      'run_query',
      { connection: 'c1', sql: 'select email from users' },
      ctx('Codex'),
    );
    await tools.call('run_query', { connection: 'c1', sql: 'drop table t' }, ctx('Codex'));
    expect(audits[0]).toMatchObject({
      client: 'Codex',
      tool: 'run_query',
      connectionId: 'c1',
      connectionName: 'Shop',
      sql: 'select email from users',
      outcome: 'ok',
      rows: 1,
    });
    expect(JSON.stringify(audits[0])).not.toContain('ann@example.com');
    expect(audits[1]).toMatchObject({ outcome: 'denied' });
  });
});
