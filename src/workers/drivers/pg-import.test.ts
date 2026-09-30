import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImportJobSpec } from '@shared/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ImportClient, applyDdl, runImport } from './pg-import';

type Q = string | { text: string; values?: unknown[] };
const textOf = (q: Q) => (typeof q === 'string' ? q : q.text);

function fake(fail?: (q: Q) => Error | null) {
  const log: Q[] = [];
  const client: ImportClient = {
    async query(q) {
      log.push(q);
      const err = fail?.(q);
      if (err) throw err;
      return { rowCount: typeof q === 'string' ? 0 : (q.values?.length ?? 0) > 0 ? 1 : 0 };
    },
  };
  return { client, log, texts: () => log.map(textOf) };
}

describe('applyDdl', () => {
  it('runs the transactional statements in BEGIN…COMMIT, then concurrent ones alone', async () => {
    const f = fake();
    const res = await applyDdl(f.client, 'I', { transactional: ['A', 'B'], concurrent: ['C'] });
    expect(res).toEqual({ executed: 3 });
    expect(f.texts()).toEqual(['BEGIN', 'A', 'B', 'COMMIT', 'C']);
  });
  it('rolls back and reports the failing statement', async () => {
    const f = fake((q) => (textOf(q) === 'B' ? new Error('boom') : null));
    const res = await applyDdl(f.client, 'I', {
      transactional: ['A', 'B', 'C'],
      concurrent: ['X'],
    });
    expect(res.executed).toBe(0);
    expect(res.error).toMatchObject({ statement: 'B', index: 1 });
    expect(res.error?.message).toContain('Nothing was changed');
    expect(f.texts()).toEqual(['BEGIN', 'A', 'B', 'ROLLBACK']);
  });
  it('uses a savepoint inside the user transaction and refuses CONCURRENTLY there', async () => {
    const f = fake();
    await applyDdl(f.client, 'T', { transactional: ['A'], concurrent: [] });
    expect(f.texts()).toEqual([
      'SAVEPOINT plasma_structure',
      'A',
      'RELEASE SAVEPOINT plasma_structure',
    ]);
    const g = fake();
    const res = await applyDdl(g.client, 'T', { transactional: ['A'], concurrent: ['C'] });
    expect(res.error?.message).toMatch(/CONCURRENTLY/);
    expect(g.log).toHaveLength(0);
  });
  it('refuses an aborted transaction', async () => {
    const f = fake();
    const res = await applyDdl(f.client, 'E', { transactional: ['A'], concurrent: [] });
    expect(res.error).toBeDefined();
    expect(f.log).toHaveLength(0);
  });
  it('reports a concurrent failure after the transaction committed', async () => {
    const f = fake((q) => (textOf(q) === 'C2' ? new Error('dup') : null));
    const res = await applyDdl(f.client, 'I', { transactional: ['A'], concurrent: ['C1', 'C2'] });
    expect(res.executed).toBe(2);
    expect(res.error).toMatchObject({ statement: 'C2', index: 2 });
  });
});

describe('runImport', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'plasma-import-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const file = (name: string, body: string) => {
    const p = join(dir, name);
    writeFileSync(p, body);
    return p;
  };
  const hooks = (cancelAfter = Number.POSITIVE_INFINITY) => {
    const progress: unknown[] = [];
    let calls = 0;
    return {
      progress,
      hooks: {
        isCancelled: () => ++calls > cancelAfter,
        onProgress: (p: unknown) => progress.push(p),
      },
    };
  };
  const job = (over: Partial<ImportJobSpec>): ImportJobSpec => ({
    jobId: 'j1',
    connectionGen: 1,
    filePath: '',
    format: 'csv',
    schema: 'public',
    table: 't',
    columns: [
      { target: 'id', source: 0 },
      { target: 'name', source: 1 },
    ],
    csv: { delimiter: ',', quote: '"', header: true, nullString: '' },
    preStatements: [],
    ...over,
  });

  it('imports a CSV in batches inside one transaction', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => `${i},n${i}`).join('\n');
    const f = fake();
    const h = hooks();
    const res = await runImport(
      f.client,
      'I',
      job({ filePath: file('a.csv', `id,name\n${rows}\n`), batchRows: 10 }),
      h.hooks,
    );
    expect(res).toMatchObject({ ok: true, rowsImported: 25, rowsRead: 25 });
    const t = f.texts();
    expect(t[0]).toBe('BEGIN');
    expect(t.at(-1)).toBe('COMMIT');
    expect(t.filter((s) => s.startsWith('INSERT'))).toHaveLength(3);
    const first = f.log.find((q) => textOf(q).startsWith('INSERT')) as { values: unknown[] };
    expect(first.values.slice(0, 4)).toEqual(['0', 'n0', '1', 'n1']);
    expect(h.progress.length).toBeGreaterThan(0);
  });

  it('runs preStatements (create table) first, in the same transaction', async () => {
    const f = fake();
    await runImport(
      f.client,
      'I',
      job({
        filePath: file('b.csv', 'id,name\n1,a\n'),
        preStatements: ['CREATE TABLE public.t (id int)'],
      }),
      hooks().hooks,
    );
    expect(f.texts().slice(0, 2)).toEqual(['BEGIN', 'CREATE TABLE public.t (id int)']);
  });

  it('finds the first failing row, rolls back and imports nothing', async () => {
    const f = fake((q) => {
      if (typeof q === 'string' || !q.text.startsWith('INSERT')) return null;
      return (q.values ?? []).includes('bad')
        ? new Error('invalid input syntax for type integer: "bad"')
        : null;
    });
    const res = await runImport(
      f.client,
      'I',
      job({ filePath: file('c.csv', 'id,name\n1,a\n2,b\nbad,c\n4,d\n'), batchRows: 100 }),
      hooks().hooks,
    );
    expect(res.ok).toBe(false);
    expect(res.rowsImported).toBe(0);
    expect(res.error).toMatchObject({ row: 3 });
    expect(res.error?.sample).toContain('bad');
    expect(f.texts().at(-1)).toBe('ROLLBACK');
    expect(f.texts()).not.toContain('COMMIT');
  });

  it('cancels between batches with a rollback', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => `${i},n`).join('\n');
    const f = fake();
    const res = await runImport(
      f.client,
      'I',
      job({ filePath: file('d.csv', `id,name\n${rows}\n`), batchRows: 5 }),
      hooks(1).hooks,
    );
    expect(res).toMatchObject({ ok: false, cancelled: true, rowsImported: 0 });
    expect(f.texts().at(-1)).toBe('ROLLBACK');
  });

  it('imports json arrays and ndjson by key, nulls for missing keys', async () => {
    const cols = [
      { target: 'id', source: 'id' },
      { target: 'name', source: 'name' },
    ];
    for (const [format, body] of [
      ['json', '[{"id":1,"name":"a"},{"id":2}]'],
      ['ndjson', '{"id":1,"name":"a"}\n{"id":2}\n'],
    ] as const) {
      const f = fake();
      const res = await runImport(
        f.client,
        'I',
        job({ format, columns: cols, filePath: file(`e.${format}`, body), csv: undefined }),
        hooks().hooks,
      );
      expect(res).toMatchObject({ ok: true, rowsImported: 2 });
      const ins = f.log.find((q) => textOf(q).startsWith('INSERT')) as { values: unknown[] };
      expect(ins.values).toEqual(['1', 'a', '2', null]);
    }
  });

  it('reports malformed json with the row', async () => {
    const f = fake();
    const res = await runImport(
      f.client,
      'I',
      job({
        format: 'ndjson',
        columns: [{ target: 'id', source: 'id' }],
        filePath: file('f.ndjson', '{"id":1}\n{oops}\n'),
        csv: undefined,
      }),
      hooks().hooks,
    );
    expect(res.ok).toBe(false);
    expect(res.error?.row).toBe(2);
    expect(f.texts().at(-1)).toBe('ROLLBACK');
  });

  it('runs a .sql file statement by statement, skipping BEGIN/COMMIT', async () => {
    const f = fake();
    const res = await runImport(
      f.client,
      'I',
      job({
        format: 'sql',
        columns: [],
        csv: undefined,
        filePath: file(
          'g.sql',
          "BEGIN;\ncreate table x(a text);\ninsert into x values ('a;b');\n-- done\nCOMMIT;\n",
        ),
      }),
      hooks().hooks,
    );
    expect(res).toMatchObject({ ok: true, statements: 2 });
    expect(f.texts()).toEqual([
      'BEGIN',
      'create table x(a text)',
      "insert into x values ('a;b')",
      'COMMIT',
    ]);
  });

  it('names the failing statement in a .sql file', async () => {
    const f = fake((q) =>
      textOf(q).includes('nope') ? new Error('relation "nope" does not exist') : null,
    );
    const res = await runImport(
      f.client,
      'I',
      job({
        format: 'sql',
        columns: [],
        csv: undefined,
        filePath: file('h.sql', 'select 1;\nselect * from nope;\nselect 3;'),
      }),
      hooks().hooks,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatchObject({ row: 2 });
    expect(res.error?.sample).toContain('nope');
  });

  it('refuses while a transaction is open and reports unreadable files', async () => {
    const f = fake();
    const a = await runImport(
      f.client,
      'T',
      job({ filePath: file('i.csv', 'a\n') }),
      hooks().hooks,
    );
    expect(a.ok).toBe(false);
    const b = await runImport(
      f.client,
      'I',
      job({ filePath: join(dir, 'missing.csv') }),
      hooks().hooks,
    );
    expect(b.error?.message).toMatch(/Cannot read/);
    expect(f.log).toHaveLength(0);
  });
});
