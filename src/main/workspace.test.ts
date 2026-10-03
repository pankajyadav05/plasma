import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecentWorkspaces, WorkspaceService } from './workspace';

let root: string;
let secrets: Map<string, string>;
let sqliteAllowed: string[];
let changes: number;
let ws: WorkspaceService;
let env: Record<string, string | undefined>;

const plasma = (...p: string[]) => join(root, '.plasma', ...p);
const put = (rel: string, text: string) => {
  mkdirSync(join(plasma(), rel, '..'), { recursive: true });
  writeFileSync(plasma(rel), text);
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'plasma-wsvc-')));
  secrets = new Map();
  sqliteAllowed = [];
  changes = 0;
  env = { PGHOST: 'db.internal' };
  ws = new WorkspaceService({
    env,
    getSecret: (k) => secrets.get(k) ?? null,
    putSecret: (k, v) => (v ? secrets.set(k, v) : secrets.delete(k)),
    hasSecret: (k) => secrets.has(k),
    allowSqlitePath: (p) => sqliteAllowed.push(p),
    onChange: () => {
      changes++;
    },
    debounceMs: 30,
  });
});
afterEach(() => {
  ws.close();
  rmSync(root, { recursive: true, force: true });
});

const CONNECTIONS = JSON.stringify({
  version: 1,
  connections: [
    {
      id: 'prod-ro',
      name: 'Prod',
      engine: 'postgres',
      host: '${PGHOST}',
      port: 5432,
      database: 'app',
      user: 'ro',
      readOnly: true,
      tag: 'prod',
    },
    { id: 'lite', name: 'Local', engine: 'sqlite', database: 'data/app.db' },
  ],
});

describe('snapshot', () => {
  it('lists profiles, queries, snippets and notebooks', () => {
    put('connections.json', CONNECTIONS);
    put('queries/reports/top.sql', '-- plasma:query\n-- name: Top\n\nSELECT 1;\n');
    put('queries/plain.sql', 'SELECT 2;\n');
    put(
      'snippets.json',
      '{"version":1,"snippets":[{"name":"n","prefix":"p","description":"","body":"b"}]}\n',
    );
    put(
      'notebooks/a.plasma-notebook.json',
      '{"version":1,"name":"A","cells":[{"id":"1","kind":"sql","content":"x"}]}\n',
    );
    const snap = ws.open(root);
    expect(snap.name).toBe(root.split('/').pop());
    expect(snap.profiles.map((p) => [p.id, p.summary])).toEqual([
      ['prod-ro', 'ro@db.internal:5432/app'],
      ['lite', 'data/app.db'],
    ]);
    expect(snap.profiles[0]).toMatchObject({ tag: 'prod', readOnly: true, needsPassword: true });
    expect(snap.profiles[1]?.needsPassword).toBe(false);
    expect(snap.queries.map((q) => [q.path, q.name])).toEqual([
      ['plain.sql', 'plain'],
      ['reports/top.sql', 'Top'],
    ]);
    expect(snap.snippets).toHaveLength(1);
    expect(snap.notebooks).toEqual([
      expect.objectContaining({ file: 'a.plasma-notebook.json', cellCount: 1 }),
    ]);
    expect(snap.problems).toEqual([]);
  });

  it('works for a folder without .plasma and reports an unset env var per profile', () => {
    expect(ws.open(root).profiles).toEqual([]);
    ws.close();
    put('connections.json', CONNECTIONS);
    env.PGHOST = undefined;
    const p = ws.open(root).profiles[0];
    expect(p?.error).toMatch(/PGHOST/);
  });

  it('does not follow symlinks out of queries/', () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'plasma-outside-')));
    try {
      writeFileSync(join(outside, 'leak.sql'), 'SELECT secret;');
      mkdirSync(plasma('queries'), { recursive: true });
      symlinkSync(outside, plasma('queries', 'linked'));
      symlinkSync(join(outside, 'leak.sql'), plasma('queries', 'leak.sql'));
      expect(ws.open(root).queries).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('writing queries', () => {
  it('creates a git-friendly file and is a no-op when nothing changed', () => {
    ws.open(root);
    const r = ws.writeQuery({
      name: 'Top Customers',
      folder: 'reports',
      variables: {},
      sql: 'SELECT 1',
    });
    expect(r).toMatchObject({ ok: true, path: 'reports/top-customers.sql' });
    const file = plasma('queries/reports/top-customers.sql');
    const text = readFileSync(file, 'utf8');
    expect(text).toBe('-- plasma:query\n-- name: Top Customers\n\nSELECT 1\n');
    const again = ws.writeQuery({
      path: 'reports/top-customers.sql',
      name: 'Top Customers',
      variables: {},
      sql: 'SELECT 1',
      baseRev: r.ok ? r.rev : null,
    });
    expect(again.ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(text);
  });

  it('never overwrites an existing file for a new query', () => {
    ws.open(root);
    ws.writeQuery({ name: 'Same', variables: {}, sql: 'SELECT 1' });
    const second = ws.writeQuery({ name: 'Same', variables: {}, sql: 'SELECT 2' });
    expect(second).toMatchObject({ ok: true, path: 'same-2.sql' });
  });

  it('reports a conflict when the file changed on disk, and overwrites only when told to', () => {
    ws.open(root);
    const first = ws.writeQuery({ name: 'Q', variables: {}, sql: 'SELECT 1' });
    if (!first.ok) throw new Error('write failed');
    writeFileSync(plasma('queries/q.sql'), '-- edited by a teammate\nSELECT 99;\n');
    const mine = { path: 'q.sql', name: 'Q', variables: {}, sql: 'SELECT 2', baseRev: first.rev };
    const res = ws.writeQuery(mine);
    expect(res).toMatchObject({ ok: false, conflict: true });
    expect(readFileSync(plasma('queries/q.sql'), 'utf8')).toContain('SELECT 99');
    const forced = ws.writeQuery({ ...mine, overwrite: true });
    expect(forced.ok).toBe(true);
    expect(readFileSync(plasma('queries/q.sql'), 'utf8')).toContain('SELECT 2');
  });

  it('refuses paths that escape the queries folder', () => {
    ws.open(root);
    for (const path of [
      '../evil.sql',
      '../../evil.sql',
      '/tmp/evil.sql',
      'a/../../evil.sql',
      'evil.txt',
    ]) {
      expect(() => ws.writeQuery({ path, name: 'x', variables: {}, sql: 'x' })).toThrow();
      expect(() => ws.deleteQuery(path)).toThrow();
    }
    expect(existsSync(join(root, '..', 'evil.sql'))).toBe(false);
  });

  it('refuses to write through a symlinked folder', () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'plasma-outside-')));
    try {
      mkdirSync(plasma('queries'), { recursive: true });
      symlinkSync(outside, plasma('queries', 'out'));
      ws.open(root);
      expect(() =>
        ws.writeQuery({ path: 'out/x.sql', name: 'x', variables: {}, sql: 'x' }),
      ).toThrow();
      expect(existsSync(join(outside, 'x.sql'))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('deletes a query', () => {
    ws.open(root);
    ws.writeQuery({ name: 'Gone', variables: {}, sql: 'x' });
    ws.deleteQuery('gone.sql');
    expect(existsSync(plasma('queries/gone.sql'))).toBe(false);
  });
});

describe('snippets and notebooks', () => {
  it('writes and detects conflicts', () => {
    ws.open(root);
    const snippets = [{ name: 'n', prefix: 'p', description: '', body: 'SELECT 1' }];
    const first = ws.writeSnippets(snippets, null);
    if (!first.ok) throw new Error('write failed');
    expect(readFileSync(plasma('snippets.json'), 'utf8').endsWith('}\n')).toBe(true);
    writeFileSync(plasma('snippets.json'), '{"version":1,"snippets":[]}\n');
    expect(ws.writeSnippets(snippets, first.rev)).toMatchObject({ ok: false, conflict: true });
    expect(ws.writeSnippets(snippets, first.rev, true).ok).toBe(true);
  });

  it('writes notebooks under a derived, confined name', () => {
    ws.open(root);
    const nb = {
      name: 'Incident 42',
      cells: [{ id: '1', kind: 'sql' as const, content: 'SELECT 1' }],
    };
    const res = ws.writeNotebook(nb, null, null);
    expect(res).toMatchObject({ ok: true, file: 'incident-42.plasma-notebook.json' });
    expect(ws.readNotebook('incident-42.plasma-notebook.json')).toEqual(nb);
    expect(ws.writeNotebook(nb, null, null)).toMatchObject({
      file: 'incident-42-2.plasma-notebook.json',
    });
    expect(() => ws.writeNotebook(nb, '../x.plasma-notebook.json', null)).toThrow();
    expect(() => ws.readNotebook('../../etc/passwd')).toThrow();
  });
});

describe('connecting a profile', () => {
  beforeEach(() => {
    put('connections.json', CONNECTIONS);
    ws.open(root);
  });

  it('builds the config in main with env resolved and no password', () => {
    const { config, needsPassword } = ws.profileConfig('prod-ro');
    expect(needsPassword).toBe(true);
    expect(config).toMatchObject({
      host: 'db.internal',
      port: 5432,
      database: 'app',
      user: 'ro',
      password: '',
      readOnly: true,
    });
    expect(config.id).toMatch(/^ws:[a-f0-9]{12}:prod-ro$/);
  });

  it('keeps the password in the secret store only, never in .plasma/', () => {
    ws.setPassword('prod-ro', 's3cret-pw');
    expect([...secrets.keys()].some((k) => k.endsWith(':prod-ro:password'))).toBe(true);
    expect(ws.profileConfig('prod-ro').needsPassword).toBe(false);
    const id = ws.profileConfig('prod-ro').config.id;
    expect(ws.connectConfig(id).password).toBe('s3cret-pw');
    for (const f of ['connections.json']) {
      expect(readFileSync(plasma(f), 'utf8')).not.toContain('s3cret-pw');
    }
    expect(ws.snapshot().profiles[0]?.needsPassword).toBe(false);
  });

  it('remembers an intentionally empty password', () => {
    ws.setPassword('prod-ro', '');
    expect(ws.profileConfig('prod-ro').needsPassword).toBe(false);
    expect(ws.connectConfig(ws.profileConfig('prod-ro').config.id).password).toBe('');
  });

  it('only connects ids of the open workspace and rebuilds from the file', () => {
    expect(() => ws.connectConfig('ws:000000000000:prod-ro')).toThrow(/not open/);
    expect(() => ws.connectConfig('not-a-ws-id')).toThrow();
    expect(() => ws.profileConfig('missing')).toThrow(/No workspace connection/);
  });

  it('resolves a sqlite profile inside the workspace and allows exactly that file', () => {
    const { config, needsPassword } = ws.profileConfig('lite');
    expect(needsPassword).toBe(false);
    expect(config.database).toBe(join(root, 'data/app.db'));
    expect(sqliteAllowed).toEqual([join(root, 'data/app.db')]);
  });

  it('refuses a sqlite profile that points outside the workspace', () => {
    put(
      'connections.json',
      JSON.stringify({
        version: 1,
        connections: [
          { id: 'evil', name: 'x', engine: 'sqlite', database: '../../etc/passwd' },
          { id: 'abs', name: 'x', engine: 'sqlite', database: '/etc/passwd' },
        ],
      }),
    );
    expect(() => ws.profileConfig('evil')).toThrow();
    expect(() => ws.profileConfig('abs')).toThrow();
    expect(sqliteAllowed).toEqual([]);
  });

  it('fails clearly when an env variable is missing', () => {
    env.PGHOST = undefined;
    expect(() => ws.profileConfig('prod-ro')).toThrow(/PGHOST/);
  });
});

describe('watching', () => {
  it('notifies (debounced) when a query file changes', async () => {
    put('connections.json', CONNECTIONS);
    ws.open(root);
    writeFileSync(plasma('queries-note'), '1');
    mkdirSync(plasma('queries'), { recursive: true });
    for (let i = 0; i < 5; i++) writeFileSync(plasma('queries', `q${i}.sql`), `SELECT ${i};`);
    await vi.waitFor(() => expect(changes).toBeGreaterThan(0), { timeout: 3000 });
    const seen = changes;
    await new Promise((r) => setTimeout(r, 150));
    expect(changes).toBeLessThan(seen + 2);
  });

  it('notices when .plasma/ is created later', async () => {
    ws.open(root);
    mkdirSync(plasma(), { recursive: true });
    await vi.waitFor(() => expect(changes).toBeGreaterThan(0), { timeout: 3000 });
  });
});

describe('RecentWorkspaces', () => {
  it('keeps most recent first, de-duplicated and capped', () => {
    const file = join(root, 'recent.json');
    const r = new RecentWorkspaces(file);
    for (let i = 0; i < 10; i++) r.add(`/tmp/ws-${i}`);
    r.add('/tmp/ws-3');
    const list = r.list();
    expect(list).toHaveLength(8);
    expect(list[0]).toEqual({ path: '/tmp/ws-3', name: 'ws-3' });
    expect(r.has('/tmp/ws-9')).toBe(true);
    expect(r.has('/tmp/ws-0')).toBe(false);
    expect(r.remove('/tmp/ws-9').some((x) => x.path === '/tmp/ws-9')).toBe(false);
  });

  it('survives a corrupt file', () => {
    const file = join(root, 'recent.json');
    writeFileSync(file, '{nope');
    expect(new RecentWorkspaces(file).list()).toEqual([]);
  });
});
