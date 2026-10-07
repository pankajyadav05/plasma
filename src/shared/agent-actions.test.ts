import { describe, expect, it } from 'vitest';
import { actionHistoryLine, actionSubject, actionTitle, normalizeAction } from './agent-actions';
import { buildAgentSystemPrompt } from './agent-prompt';
import { isAgentReadSql } from './ai-readonly-sql';

describe('normalizeAction', () => {
  it('accepts show_table and keeps the raw view for validation', () => {
    const r = normalizeAction('show_table', {
      schema: ' public ',
      table: 'orders',
      columns: ['id'],
      limit: 10,
      sort: null,
    });
    expect(r).toEqual({
      ok: true,
      action: {
        name: 'show_table',
        schema: 'public',
        table: 'orders',
        rawView: { columns: ['id'], limit: 10, sort: null },
      },
    });
  });

  it('requires schema and table', () => {
    const r = normalizeAction('show_table', { table: 'orders' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('schema');
  });

  it('accepts one read-only query', () => {
    const r = normalizeAction('run_query', { sql: ' select 1; ', title: ' one ' });
    expect(r).toEqual({ ok: true, action: { name: 'run_query', sql: 'select 1;', title: 'one' } });
  });

  it('rejects run_query that writes, or is more than one statement', () => {
    for (const sql of [
      'delete from t',
      'update t set a = 1',
      'select 1; select 2',
      'explain analyze delete from t',
      'with x as (delete from t returning *) select * from x',
      'select * into copy from t',
      'select pg_terminate_backend(1)',
      '',
    ]) {
      expect(normalizeAction('run_query', { sql }).ok, sql).toBe(false);
    }
  });

  it('accepts one changing statement and tells the model to use run_query for reads', () => {
    expect(
      normalizeAction('propose_change', { sql: 'delete from t where id = 1', summary: 'one row' })
        .ok,
    ).toBe(true);
    expect(
      normalizeAction('propose_change', { sql: 'create index i on t (a)', summary: '' }).ok,
    ).toBe(true);
    const read = normalizeAction('propose_change', { sql: 'select * from t', summary: 's' });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error).toContain('run_query');
  });

  it('rejects multi-statement and empty propose_change', () => {
    expect(
      normalizeAction('propose_change', { sql: 'delete from a; delete from b', summary: 's' }).ok,
    ).toBe(false);
    expect(normalizeAction('propose_change', { sql: '  ', summary: 's' }).ok).toBe(false);
    expect(normalizeAction('propose_change', {}).ok).toBe(false);
  });

  it('does not split on semicolons inside strings', () => {
    expect(
      normalizeAction('propose_change', { sql: "update t set a = 'x;y'", summary: 's' }).ok,
    ).toBe(true);
  });

  it('open_in_editor takes any SQL, several statements included', () => {
    expect(normalizeAction('open_in_editor', { sql: 'delete from t; select 1' }).ok).toBe(true);
    expect(normalizeAction('open_in_editor', { sql: '' }).ok).toBe(false);
  });

  it('rejects unknown actions and non-object args', () => {
    expect(normalizeAction('drop_everything', {}).ok).toBe(false);
    expect(normalizeAction('run_query', 'select 1').ok).toBe(false);
    expect(normalizeAction('run_query', null).ok).toBe(false);
  });
});

describe('isAgentReadSql', () => {
  it('allows plain reads, including words only inside strings, comments and identifiers', () => {
    for (const sql of [
      'select 1',
      "select * from t where note = 'delete me'",
      'select updated_at, insert_count from t -- delete',
      'with a as (select 1) select * from a',
      'show server_version',
      'explain select * from t',
    ]) {
      expect(isAgentReadSql(sql), sql).toBe(true);
    }
  });

  it('refuses what a plain run would turn into a write', () => {
    for (const sql of [
      'explain analyze insert into t values (1)',
      'select * into backup from t',
      "select nextval('s')",
      'select * from t for update',
      'explain analyze create table x as select 1',
      // P1-1: quoted names, large objects, advisory locks, file readers, remote table functions
      'SELECT "setval"(\'orders_id_seq\', 1)',
      'SELECT "nextval"(\'s\')',
      'SELECT lo_unlink(16384)',
      'SELECT pg_try_advisory_lock(1)',
      'SELECT pg_advisory_lock(1)',
      "SELECT * FROM read_text('/etc/passwd')",
      "SELECT * FROM read_csv('x.csv')",
      "SELECT * FROM 'data.csv'",
      "SELECT * FROM url('http://x', CSV)",
      "SELECT * FROM s3('https://b/x', 'CSV')",
      "SELECT load_extension('x')",
      "SELECT readfile('/etc/passwd')",
      "SELECT * FROM file('a')",
    ]) {
      expect(isAgentReadSql(sql), sql).toBe(false);
    }
  });
});

describe('labels and history lines', () => {
  it('titles each action', () => {
    expect(actionTitle('show_table')).toBe('Show table');
    expect(actionTitle('run_query')).toBe('Run query');
    expect(actionTitle('propose_change')).toBe('Change data');
    expect(actionTitle('open_in_editor')).toBe('Open in editor');
  });

  it('names the subject', () => {
    expect(
      actionSubject({ name: 'show_table', schema: 'public', table: 'orders', rawView: {} }),
    ).toBe('public.orders');
    expect(actionSubject({ name: 'run_query', sql: '\n  select 1\nfrom t' })).toBe('select 1');
    const long = actionSubject({ name: 'run_query', sql: `select ${'x'.repeat(200)}` });
    expect(long.length).toBeLessThanOrEqual(80);
  });

  it('writes the history line', () => {
    const show = { name: 'show_table', schema: 'public', table: 'orders', rawView: {} } as const;
    expect(actionHistoryLine(show, 'applied')).toBe('[show_table public.orders: applied]');
    expect(
      actionHistoryLine(
        { name: 'propose_change', sql: 'x', summary: '' },
        'rejected',
        'only paid orders',
      ),
    ).toBe('[propose_change: rejected — "only paid orders"]');
    expect(actionHistoryLine(show, 'pending')).toBe('[show_table public.orders: not answered]');
  });
});

describe('agent system prompt', () => {
  const base = {
    flavour: 'Postgres',
    ddl: 'public.orders (id int)',
    context: null,
    rowData: false,
  };

  it('tells the model how to use each tool and not to claim unconfirmed changes', () => {
    const p = buildAgentSystemPrompt(base);
    expect(p).toContain('show_table');
    expect(p).toContain('run_query');
    expect(p).toContain('propose_change');
    expect(p).toContain('Never claim a change happened unless the tool result says "applied"');
    expect(p).toContain('"rejected"');
    expect(p).toContain('public.orders (id int)');
    expect(p).toContain('cannot see row data');
  });

  it('says the schema is unavailable when it is off, and adds context only when given', () => {
    const off = buildAgentSystemPrompt({ ...base, ddl: null });
    expect(off).toContain('schema is not available');
    expect(off).not.toContain('--- SCHEMA ---');
    expect(off).not.toContain('CURRENT TAB');
    const withCtx = buildAgentSystemPrompt({
      ...base,
      context: 'Current tab: SQL editor',
      rowData: true,
    });
    expect(withCtx).toContain('Current tab: SQL editor');
    expect(withCtx).toContain('query_database');
  });
});

describe('normalizeAction: memory tools', () => {
  it('accepts a short note and cleans it', () => {
    expect(normalizeAction('remember', { text: '  orders.amount \n is in cents ' })).toEqual({
      ok: true,
      action: { name: 'remember', text: 'orders.amount is in cents' },
    });
  });

  it('refuses an empty, long or secret-bearing note before any card', () => {
    expect(normalizeAction('remember', { text: ' ' }).ok).toBe(false);
    expect(normalizeAction('remember', {}).ok).toBe(false);
    expect(normalizeAction('remember', { text: 'x'.repeat(501) }).ok).toBe(false);
    const secret = normalizeAction('remember', { text: 'password: hunter2hunter2' });
    expect(secret).toEqual({ ok: false, error: "Memory can't hold passwords or keys." });
  });

  it('accepts forget with an id and requires one', () => {
    expect(normalizeAction('forget', { id: ' m:abc123 ' })).toEqual({
      ok: true,
      action: { name: 'forget', id: 'm:abc123', text: undefined },
    });
    expect(normalizeAction('forget', {}).ok).toBe(false);
  });

  it('titles and describes them', () => {
    expect(actionTitle('remember')).toBe('Remember');
    expect(actionTitle('forget')).toBe('Forget');
    expect(actionSubject({ name: 'remember', text: 'a rule' })).toBe('a rule');
    expect(actionSubject({ name: 'forget', id: 'm:abc123', text: 'old rule' })).toBe('old rule');
    expect(actionHistoryLine({ name: 'remember', text: 'a rule' }, 'rejected')).toBe(
      '[remember: rejected]',
    );
  });
});

describe('agent prompt: memory', () => {
  const base = { flavour: 'Postgres', ddl: null, context: null, rowData: false };
  it('adds the notes and the remember rules only when memory is on', () => {
    const on = buildAgentSystemPrompt({
      ...base,
      memory: '--- Notes ---\n- [m:abc123] a rule',
      memoryTools: true,
    });
    expect(on).toContain('- [m:abc123] a rule');
    expect(on).toContain('- remember:');
    expect(on).toMatch(/at most one remember per reply/);
    expect(on).toMatch(/Never put row values, personal data/);
    const off = buildAgentSystemPrompt(base);
    expect(off).not.toContain('remember');
    expect(off).not.toContain('Notes');
  });
});
