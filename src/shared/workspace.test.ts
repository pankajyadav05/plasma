import { describe, expect, it } from 'vitest';
import {
  InterpolationError,
  type WorkspaceProfile,
  buildQueryTree,
  interpolateEnv,
  newQueryPath,
  notebookFileName,
  parseConnectionsFile,
  parseNotebookFile,
  parseQueryFile,
  parseSnippetsFile,
  parseWorkspaceConnectionId,
  resolveProfile,
  serializeConnectionsFile,
  serializeNotebookFile,
  serializeQueryFile,
  serializeSnippetsFile,
  slugify,
  workspaceConnectionId,
} from './workspace';

const profile = (over: Partial<WorkspaceProfile> = {}): WorkspaceProfile => ({
  id: 'prod-ro',
  name: 'Prod (read only)',
  engine: 'postgres',
  host: '${PGHOST}',
  port: 5432,
  database: 'app',
  user: 'app_ro',
  readOnly: true,
  tag: 'prod',
  ...over,
});

describe('connections.json', () => {
  it('round-trips and is byte-stable', () => {
    const text = serializeConnectionsFile([
      profile(),
      profile({ id: 'dev', name: 'Dev', tag: 'dev' }),
    ]);
    const parsed = parseConnectionsFile(text);
    expect(parsed.problems).toEqual([]);
    expect(parsed.profiles.map((p) => p.id).sort()).toEqual(['dev', 'prod-ro']);
    expect(serializeConnectionsFile(parsed.profiles)).toBe(text);
  });

  it('is pretty, ends with a newline and has stable key order regardless of input order', () => {
    const a = profile();
    const shuffled = Object.fromEntries(Object.entries(a).reverse()) as WorkspaceProfile;
    const text = serializeConnectionsFile([a]);
    expect(serializeConnectionsFile([shuffled])).toBe(text);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('\n  "connections": [');
    const keys = Object.keys(JSON.parse(text).connections[0]);
    expect(keys.slice(0, 3)).toEqual(['id', 'name', 'engine']);
  });

  it('sorts profiles by id so reordering never churns the diff', () => {
    const one = serializeConnectionsFile([profile({ id: 'b' }), profile({ id: 'a' })]);
    const two = serializeConnectionsFile([profile({ id: 'a' }), profile({ id: 'b' })]);
    expect(one).toBe(two);
  });

  it('contains no timestamps', () => {
    expect(serializeConnectionsFile([profile()])).not.toMatch(
      /\d{4}-\d{2}-\d{2}T|updatedAt|createdAt/,
    );
  });

  it('refuses a profile that carries a password, keeps the others', () => {
    const text = JSON.stringify({
      version: 1,
      connections: [{ ...profile(), password: 'hunter2' }, profile({ id: 'ok' })],
    });
    const r = parseConnectionsFile(text);
    expect(r.profiles.map((p) => p.id)).toEqual(['ok']);
    expect(r.problems[0]).toMatch(/passwords must not be stored/);
  });

  it('rejects unknown keys, bad ids, duplicates and unknown versions', () => {
    const r = parseConnectionsFile(
      JSON.stringify({
        version: 1,
        connections: [
          { ...profile(), token: 'x' },
          { ...profile(), id: '../evil' },
          profile({ id: 'dup' }),
          profile({ id: 'dup' }),
        ],
      }),
    );
    expect(r.profiles.map((p) => p.id)).toEqual(['dup']);
    expect(r.problems).toHaveLength(3);
    expect(parseConnectionsFile('{"version":2,"connections":[]}').problems[0]).toMatch(/version/);
    expect(parseConnectionsFile('nope').problems[0]).toMatch(/JSON/);
  });
});

describe('interpolateEnv', () => {
  const env = { PGHOST: 'db.internal', EMPTY: '', PORT: '6432' };

  it('substitutes variables and defaults', () => {
    expect(interpolateEnv('${PGHOST}:${PORT}', env)).toBe('db.internal:6432');
    expect(interpolateEnv('${MISSING:-fallback}', env)).toBe('fallback');
    expect(interpolateEnv('${EMPTY:-fallback}', env)).toBe('fallback');
    expect(interpolateEnv('${EMPTY}', env)).toBe('');
  });

  it('throws for an unset variable without a default', () => {
    expect(() => interpolateEnv('${NOPE}', env)).toThrow(InterpolationError);
    expect(() => interpolateEnv('${NOPE}', env)).toThrow(/NOPE/);
  });

  it('only reads the env: no files, commands, or nested expansion', () => {
    expect(interpolateEnv('$(whoami) `id` ~/.ssh/id_rsa $HOME', env)).toBe(
      '$(whoami) `id` ~/.ssh/id_rsa $HOME',
    );
    expect(interpolateEnv('${A}', { A: '${PGHOST}' })).toBe('${PGHOST}');
    expect(() => interpolateEnv('${file:/etc/passwd}', env)).not.toThrow();
    expect(interpolateEnv('${file:/etc/passwd}', env)).toBe('${file:/etc/passwd}');
  });

  it('does not read inherited object properties', () => {
    expect(() => interpolateEnv('${constructor}', {})).toThrow(InterpolationError);
    expect(() => interpolateEnv('${toString}', {})).toThrow(InterpolationError);
  });

  it('$$ escapes a literal dollar', () => {
    expect(interpolateEnv('$${PGHOST}', env)).toBe('${PGHOST}');
    expect(interpolateEnv('cost $$5', env)).toBe('cost $5');
  });
});

describe('resolveProfile', () => {
  it('resolves env placeholders in host, port, database and user', () => {
    const r = resolveProfile(
      profile({ host: '${H}', port: '${P}', database: '${D:-app}', user: 'u-${U}' }),
      { H: 'h', P: '5433', U: 'x' },
    );
    expect(r).toMatchObject({
      host: 'h',
      port: 5433,
      database: 'app',
      user: 'u-x',
      readOnly: true,
    });
  });

  it('fails clearly on a missing variable or a bad port', () => {
    expect(() => resolveProfile(profile(), {})).toThrow(/PGHOST/);
    expect(() => resolveProfile(profile({ host: 'h', port: 'abc' }), {})).toThrow(/port/);
    expect(() => resolveProfile(profile({ host: '' }), {})).toThrow(/host/);
  });

  it('defaults the port per engine and allows file engines without a host', () => {
    expect(resolveProfile(profile({ host: 'h', port: undefined }), {}).port).toBe(5432);
    expect(resolveProfile(profile({ engine: 'mysql', host: 'h', port: undefined }), {}).port).toBe(
      3306,
    );
    expect(
      resolveProfile(profile({ engine: 'sqlite', host: undefined, database: 'data/app.db' }), {})
        .host,
    ).toBe('localhost');
  });
});

describe('workspace connection ids', () => {
  it('round-trips', () => {
    const id = workspaceConnectionId('0123456789ab', 'prod-ro');
    expect(parseWorkspaceConnectionId(id)).toEqual({
      workspaceId: '0123456789ab',
      profileId: 'prod-ro',
    });
    expect(parseWorkspaceConnectionId('0123456789ab')).toBeNull();
    expect(parseWorkspaceConnectionId('ws:short:x')).toBeNull();
  });
});

describe('query files', () => {
  const q = {
    name: 'Top customers',
    description: 'Revenue by customer',
    connection: 'prod-ro',
    variables: {
      status: { mode: 'text' as const, value: 'active' },
      limit: { mode: 'number' as const, value: '10' },
    },
    sql: 'SELECT *\nFROM customers\nWHERE status = :status\nLIMIT :limit;',
  };

  it('round-trips and is stable', () => {
    const text = serializeQueryFile(q);
    expect(parseQueryFile('reports/top.sql', text)).toEqual({ path: 'reports/top.sql', ...q });
    expect(serializeQueryFile(parseQueryFile('reports/top.sql', text))).toBe(text);
  });

  it('writes a front-matter comment header with sorted variables and a trailing newline', () => {
    const text = serializeQueryFile(q);
    expect(text.startsWith('-- plasma:query\n-- name: Top customers\n')).toBe(true);
    expect(text.indexOf('-- var limit')).toBeLessThan(text.indexOf('-- var status'));
    expect(text.endsWith(';\n')).toBe(true);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('normalises CRLF and trailing whitespace', () => {
    const text = serializeQueryFile({ ...q, sql: 'SELECT 1;  \r\n\r\n' });
    expect(text).not.toContain('\r');
    expect(parseQueryFile('a.sql', text).sql).toBe('SELECT 1;');
  });

  it('reads a plain .sql file (no header) with the file name as the title', () => {
    const r = parseQueryFile('ops/vacuum-report.sql', 'SELECT 1;\n');
    expect(r).toMatchObject({ name: 'vacuum-report', sql: 'SELECT 1;', variables: {} });
  });

  it('keeps a body that begins with a comment', () => {
    const text = serializeQueryFile({ ...q, sql: '-- note: careful\nSELECT 1;' });
    expect(parseQueryFile('a.sql', text).sql).toBe('-- note: careful\nSELECT 1;');
  });

  it('collapses a multi-line description into one header line', () => {
    const text = serializeQueryFile({ ...q, description: 'line one\nline two' });
    expect(parseQueryFile('a.sql', text).description).toBe('line one line two');
  });

  it('ignores a malformed variable line without losing the query', () => {
    const text = '-- plasma:query\n-- name: x\n-- var n: {oops}\n\nSELECT 1;\n';
    const r = parseQueryFile('x.sql', text);
    expect(r.variables).toEqual({});
    expect(r.sql).toBe('SELECT 1;');
  });
});

describe('paths and tree', () => {
  it('slugifies names', () => {
    expect(slugify('Top 10 Customers!')).toBe('top-10-customers');
    expect(slugify('  ')).toBe('query');
    expect(slugify('Ünïcode café')).toBe('unicode-cafe');
  });

  it('builds a unique path, dropping traversal segments from the folder', () => {
    expect(newQueryPath('Top', 'reports/q1', new Set())).toBe('reports/q1/top.sql');
    expect(newQueryPath('Top', '../../etc', new Set())).toBe('etc/top.sql');
    expect(newQueryPath('Top', '', new Set(['top.sql', 'top-2.sql']))).toBe('top-3.sql');
  });

  it('groups queries by folder, sorted', () => {
    const mk = (path: string, name: string) => ({ path, name, variables: {}, sql: '' });
    const tree = buildQueryTree([
      mk('b/z.sql', 'Z'),
      mk('a/x/y.sql', 'Y'),
      mk('root.sql', 'Root'),
      mk('b/a.sql', 'A'),
    ]);
    expect(tree.queries.map((q) => q.name)).toEqual(['Root']);
    expect(tree.folders.map((f) => f.name)).toEqual(['a', 'b']);
    expect(tree.folders[0]?.node.folders[0]?.path).toBe('a/x');
    expect(tree.folders[1]?.node.queries.map((q) => q.name)).toEqual(['A', 'Z']);
  });
});

describe('snippets.json', () => {
  it('round-trips, sorts and is stable', () => {
    const snippets = [
      { name: 'b', prefix: 'zz', description: '', body: 'SELECT 2' },
      { name: 'a', prefix: 'aa', description: 'first', body: 'SELECT ${1:x}' },
    ];
    const text = serializeSnippetsFile(snippets);
    const parsed = parseSnippetsFile(text);
    expect(parsed.problems).toEqual([]);
    expect(parsed.snippets.map((s) => s.prefix)).toEqual(['aa', 'zz']);
    expect(serializeSnippetsFile(parsed.snippets)).toBe(text);
    expect(text.endsWith('}\n')).toBe(true);
  });

  it('skips invalid entries', () => {
    const r = parseSnippetsFile(
      JSON.stringify({
        version: 1,
        snippets: [
          { name: '', prefix: 'x', body: 'y' },
          { name: 'n', prefix: 'p', body: 'b' },
        ],
      }),
    );
    expect(r.snippets).toHaveLength(1);
    expect(r.problems).toHaveLength(1);
  });
});

describe('notebooks', () => {
  it('round-trips and is stable', () => {
    const nb = {
      name: 'Incident 42',
      connection: 'prod-ro',
      cells: [
        { id: 'c1', kind: 'md' as const, content: '# Notes' },
        { id: 'c2', kind: 'sql' as const, content: 'SELECT 1' },
      ],
    };
    const text = serializeNotebookFile(nb);
    expect(parseNotebookFile(text)).toEqual(nb);
    expect(serializeNotebookFile(parseNotebookFile(text) as typeof nb)).toBe(text);
    expect(text.endsWith('}\n')).toBe(true);
    expect(notebookFileName('Incident 42')).toBe('incident-42.plasma-notebook.json');
  });

  it('rejects garbage', () => {
    expect(parseNotebookFile('{"version":1}')).toBeNull();
    expect(parseNotebookFile('x')).toBeNull();
  });
});
