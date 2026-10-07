import { MCP_MAX_ROWS } from '@shared/mcp';
import { describe, expect, it } from 'vitest';
import type { ProposalView } from './proposals';
import type { ToolContext } from './protocol';
import { conn, fakeToolsDeps, queryResult, schemaInfo } from './test-support';
import { type McpConnectionInfo, createMcpTools, mcpToolDefs, narrowSchema } from './tools';

const ctx = (client = 'Claude Code'): ToolContext => ({
  client,
  signal: new AbortController().signal,
});
const text = (r: { content: Array<{ text: string }> }) => r.content[0]?.text ?? '';

describe('tool definitions', () => {
  it('lists the tools with schemas and hints', () => {
    const defs = mcpToolDefs();
    expect(defs.map((d) => d.name)).toEqual([
      'list_connections',
      'get_schema',
      'run_query',
      'propose_change',
      'check_proposal',
      'get_memory',
      'remember',
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
  const proposeDeps = (view: ProposalView, extra: Partial<McpConnectionInfo> = {}) => {
    const created: unknown[] = [];
    const waits: Array<{ id: string; ms: number }> = [];
    const f = fakeToolsDeps({
      list: [conn({ access: 'propose', openInPlasma: true, ...extra })],
      proposals: {
        create: (input) => {
          created.push(input);
          return { ok: true, id: 'p-9' };
        },
        wait: async (id, ms) => {
          waits.push({ id, ms });
          return view;
        },
      },
      waitMs: 45_000,
    });
    return { ...f, created, waits };
  };
  const args = { connection: 'c1', sql: 'update t set a=1', summary: 'fix' };

  it('needs the connection to be open in Plasma', async () => {
    const { deps, calls } = fakeToolsDeps({
      list: [conn({ access: 'propose', openInPlasma: false })],
    });
    const out = await createMcpTools(deps).call('propose_change', args, ctx());
    expect(out.isError).toBe(true);
    expect(text(out)).toBe('Open Shop in Plasma first, then try again.');
    expect(calls.propose).toHaveLength(0);
  });
  it('refuses a read-only connection', async () => {
    const { deps } = fakeToolsDeps({
      list: [conn({ access: 'propose', readOnly: true, openInPlasma: true })],
    });
    expect((await createMcpTools(deps).call('propose_change', args, ctx())).isError).toBe(true);
  });
  it('creates a proposal with the client name and waits at most 45 s', async () => {
    const { deps, created, waits } = proposeDeps({
      proposal_id: 'p-9',
      status: 'applied',
      message: 'ok',
      rows_affected: 3,
    });
    const out = await createMcpTools(deps).call('propose_change', args, ctx('Cursor'));
    expect(JSON.parse(text(out))).toEqual({
      proposal_id: 'p-9',
      status: 'applied',
      message: 'ok',
      rows_affected: 3,
    });
    expect((created[0] as { client: string; kind: string }).client).toBe('Cursor');
    expect((created[0] as { kind: string }).kind).toBe('change');
    expect(waits).toEqual([{ id: 'p-9', ms: 45_000 }]);
  });
  it('answers waiting_for_approval with the id when the user has not decided', async () => {
    const { deps } = proposeDeps({
      proposal_id: 'p-9',
      status: 'waiting_for_approval',
      message: 'Waiting for the user to approve in Plasma. Call check_proposal with this id.',
    });
    const out = await createMcpTools(deps).call('propose_change', args, ctx());
    expect(out.isError).toBeUndefined();
    expect(JSON.parse(text(out))).toMatchObject({
      proposal_id: 'p-9',
      status: 'waiting_for_approval',
    });
  });
  it('a failed outcome is an error result', async () => {
    const { deps } = proposeDeps({
      proposal_id: 'p-9',
      status: 'failed',
      message: 'duplicate key',
    });
    expect((await createMcpTools(deps).call('propose_change', args, ctx())).isError).toBe(true);
  });
  it('passes on why a proposal could not be shown', async () => {
    const { deps } = fakeToolsDeps({
      list: [conn({ access: 'propose', openInPlasma: true })],
      proposals: {
        create: () => ({ ok: false, note: 'Too many proposals are waiting' }),
        wait: async () => null,
      },
    });
    const out = await createMcpTools(deps).call('propose_change', args, ctx());
    expect(out.isError).toBe(true);
    expect(text(out)).toContain('Too many');
  });
});

describe('check_proposal', () => {
  it('waits 45 s and reports where the proposal stands, for any outcome', async () => {
    for (const status of [
      'waiting_for_approval',
      'applied',
      'declined',
      'failed',
      'expired',
    ] as const) {
      const seen: number[] = [];
      const { deps } = fakeToolsDeps({
        waitMs: 45_000,
        proposals: {
          create: () => ({ ok: false, note: '' }),
          wait: async (id, ms) => {
            seen.push(ms);
            return { proposal_id: id, status, message: 'm' };
          },
        },
      });
      const out = await createMcpTools(deps).call('check_proposal', { proposal_id: 'abc' }, ctx());
      expect(JSON.parse(text(out)).status).toBe(status);
      expect(seen).toEqual([45_000]);
    }
  });
  it('says so for an unknown id', async () => {
    const { deps } = fakeToolsDeps({
      proposals: { create: () => ({ ok: false, note: '' }), wait: async () => null },
    });
    const out = await createMcpTools(deps).call('check_proposal', { proposal_id: 'nope' }, ctx());
    expect(out.isError).toBe(true);
  });
});

describe('memory tools', () => {
  const mem = (state: 'off' | 'empty' | 'on') =>
    fakeToolsDeps({
      list: [conn({ access: 'schema' })],
      memory: () =>
        state === 'on'
          ? { state, text: '--- Notes ---\n- [m:abc123] amount is in cents' }
          : { state },
    });
  it('get_memory returns the notes in prompt form, or why there are none', async () => {
    expect(
      text(await createMcpTools(mem('on').deps).call('get_memory', { connection: 'c1' }, ctx())),
    ).toContain('[m:abc123] amount is in cents');
    expect(
      text(await createMcpTools(mem('empty').deps).call('get_memory', { connection: 'c1' }, ctx())),
    ).toContain('No notes');
    const off = await createMcpTools(mem('off').deps).call(
      'get_memory',
      { connection: 'c1' },
      ctx(),
    );
    expect(off.isError).toBe(true);
  });
  it('get_memory needs at least schema access and a connection that is on', async () => {
    const { deps } = fakeToolsDeps({ list: [conn({ access: 'off' })] });
    expect(
      (await createMcpTools(deps).call('get_memory', { connection: 'c1' }, ctx())).isError,
    ).toBe(true);
  });
  it('get_schema appends the notes only when memory is on', async () => {
    const on = text(
      await createMcpTools(mem('on').deps).call('get_schema', { connection: 'c1' }, ctx()),
    );
    expect(on).toContain('public.orders');
    expect(on).toContain('amount is in cents');
    const off = text(
      await createMcpTools(mem('off').deps).call('get_schema', { connection: 'c1' }, ctx()),
    );
    expect(off).not.toContain('Notes');
  });
  it('remember needs read access and a valid note, then goes through a proposal', async () => {
    const created: unknown[] = [];
    const base = {
      list: [conn({ access: 'read' })],
      proposals: {
        create: (i: unknown) => {
          created.push(i);
          return { ok: true as const, id: 'p-1' };
        },
        wait: async (id: string) => ({
          proposal_id: id,
          status: 'waiting_for_approval' as const,
          message: 'w',
        }),
      },
    };
    const ok = fakeToolsDeps({ ...base });
    const out = await createMcpTools(ok.deps).call(
      'remember',
      { connection: 'c1', text: 'amount is in cents' },
      ctx('Codex'),
    );
    expect(JSON.parse(text(out)).proposal_id).toBe('p-1');
    expect(created[0]).toMatchObject({
      kind: 'remember',
      client: 'Codex',
      args: { text: 'amount is in cents' },
    });
    const low = fakeToolsDeps({ ...base, list: [conn({ access: 'schema' })] });
    expect(
      (await createMcpTools(low.deps).call('remember', { connection: 'c1', text: 'x' }, ctx()))
        .isError,
    ).toBe(true);
    const dup = fakeToolsDeps({ ...base, checkRemember: () => 'Already remembered.' });
    const d = await createMcpTools(dup.deps).call(
      'remember',
      { connection: 'c1', text: 'x' },
      ctx(),
    );
    expect(text(d)).toBe('Already remembered.');
    const off = fakeToolsDeps({ ...base, memory: () => ({ state: 'off' as const }) });
    expect(
      (await createMcpTools(off.deps).call('remember', { connection: 'c1', text: 'x' }, ctx()))
        .isError,
    ).toBe(true);
    expect(created).toHaveLength(1);
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
