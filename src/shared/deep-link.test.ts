import { describe, expect, it } from 'vitest';
import {
  cliActionsFromArgv,
  deepLinksFromArgv,
  looksLikeConnectionUrl,
  parseDeepLink,
  parsePasted,
  parseTargetTable,
  redactSecrets,
  sameEndpoint,
} from './deep-link';

const link = (params: Record<string, string>, action = 'connect') =>
  `plasma://${action}?${new URLSearchParams(params).toString()}`;

describe('plasma://connect', () => {
  it('pre-fills the form from a postgres url', () => {
    const r = parseDeepLink(
      link({
        url: 'postgres://app:pw@db.example.com:6432/shop?sslmode=require',
        name: 'Shop',
        readonly: '1',
      }),
    );
    expect(r).toMatchObject({
      kind: 'connect',
      prefill: {
        name: 'Shop',
        engine: 'postgres',
        host: 'db.example.com',
        port: 6432,
        database: 'shop',
        user: 'app',
        password: 'pw',
        readOnly: true,
      },
    });
  });

  it('moves the password into the password field only', () => {
    const r = parseDeepLink(link({ url: 'postgres://u:p%40ss@h/db' }));
    if (r.kind !== 'connect') throw new Error('expected connect');
    expect(r.prefill.password).toBe('p@ss');
    const { password: _pw, ...rest } = r.prefill;
    expect(JSON.stringify(rest)).not.toContain('p@ss');
    expect(JSON.stringify(rest)).not.toContain('p%40ss');
  });

  it('defaults the name to the host and read-only to false', () => {
    const r = parseDeepLink(link({ url: 'redis://cache.local:6379/0' }));
    expect(r).toMatchObject({
      kind: 'connect',
      prefill: { name: 'cache.local', readOnly: false, engine: 'redis' },
    });
  });

  it.each(['0', 'no', '', 'false'])('readonly=%j is not read-only', (v) => {
    const r = parseDeepLink(link({ url: 'postgres://u@h/db', readonly: v }));
    expect(r).toMatchObject({ kind: 'connect', prefill: { readOnly: false } });
  });

  it('truncates a very long name', () => {
    const r = parseDeepLink(link({ url: 'postgres://u@h/db', name: 'x'.repeat(500) }));
    if (r.kind !== 'connect') throw new Error('expected connect');
    expect(r.prefill.name).toHaveLength(80);
  });

  it.each([
    'javascript://x/%0aalert(1)',
    'file:///etc/passwd',
    'ftp://h/x',
    'ssh://u@h',
    'data://x',
    'plasma://connect?url=notaurl',
    'postgres:/missing-slashes',
  ])('refuses the scheme / shape %s', (target) => {
    const r = parseDeepLink(link({ url: target }));
    expect(r.kind).toBe('invalid');
  });

  it('refuses a missing url, unknown actions, huge links and non-plasma links', () => {
    expect(parseDeepLink('plasma://connect').kind).toBe('invalid');
    expect(parseDeepLink('plasma://run?sql=drop').kind).toBe('invalid');
    expect(parseDeepLink(link({ url: `postgres://u@h/${'a'.repeat(5000)}` })).kind).toBe('invalid');
    expect(parseDeepLink('https://example.com').kind).toBe('invalid');
    expect(parseDeepLink('plasma://').kind).toBe('invalid');
  });

  it('never connects by itself: the action only carries a prefill', () => {
    const r = parseDeepLink(link({ url: 'postgres://u:p@h/db' }));
    expect(Object.keys(r).sort()).toEqual(['kind', 'prefill']);
  });
});

describe('plasma://open', () => {
  it('returns an absolute workspace path to confirm', () => {
    expect(parseDeepLink(link({ workspace: '/home/me/proj' }, 'open'))).toEqual({
      kind: 'workspace',
      path: '/home/me/proj',
    });
    expect(parseDeepLink(link({ workspace: 'C:\\Users\\me\\proj' }, 'open')).kind).toBe(
      'workspace',
    );
  });

  it('refuses relative or missing paths', () => {
    expect(parseDeepLink(link({ workspace: 'proj' }, 'open')).kind).toBe('invalid');
    expect(parseDeepLink(link({ workspace: '../proj' }, 'open')).kind).toBe('invalid');
    expect(parseDeepLink('plasma://open').kind).toBe('invalid');
  });
});

describe('pasted connection strings', () => {
  it('accepts a url and a link, refuses unknown schemes', () => {
    expect(parsePasted('  postgres://u:p@h:5/db ')).toMatchObject({
      kind: 'connect',
      prefill: { port: 5 },
    });
    expect(parsePasted(link({ url: 'mysql://u@h/db' }))).toMatchObject({ kind: 'connect' });
    expect(parsePasted('ftp://h')).toMatchObject({ kind: 'error' });
    expect(parsePasted('select 1')).toMatchObject({ kind: 'error' });
  });

  it('does not open workspaces from pasted text', () => {
    expect(parsePasted(link({ workspace: '/tmp/x' }, 'open'))).toMatchObject({ kind: 'error' });
  });
});

describe('redactSecrets', () => {
  it('hides url passwords, including percent-encoded links', () => {
    expect(redactSecrets('postgres://app:hunter2@db/x')).toBe('postgres://app:***@db/x');
    const enc = redactSecrets(link({ url: 'postgres://app:hunter2@db/x' }));
    expect(enc).not.toContain('hunter2');
  });
});

describe('argv', () => {
  it('finds deep links among arguments', () => {
    expect(
      deepLinksFromArgv(['/app/plasma', '--flag', 'plasma://connect?url=x', 'file.sql']),
    ).toEqual(['plasma://connect?url=x']);
    expect(deepLinksFromArgv(['PLASMA://open?workspace=/x'])).toHaveLength(1);
    expect(deepLinksFromArgv(['https://x', 'plasma:/x'])).toEqual([]);
  });

  it('reads the launcher flags', () => {
    expect(cliActionsFromArgv(['/app', '--plasma-open=/home/me/db.sqlite'])).toEqual([
      { kind: 'open', target: '/home/me/db.sqlite' },
    ]);
    expect(
      cliActionsFromArgv([
        '/app',
        '--plasma-import=/tmp/a.csv',
        '--plasma-into=postgres://h/db',
        '--plasma-table=public.t',
      ]),
    ).toEqual([{ kind: 'import', file: '/tmp/a.csv', into: 'postgres://h/db', table: 'public.t' }]);
  });

  it('ignores an incomplete import and empty values', () => {
    expect(cliActionsFromArgv(['--plasma-import=/tmp/a.csv', '--plasma-table=t'])).toEqual([]);
    expect(cliActionsFromArgv(['--plasma-open='])).toEqual([]);
    expect(cliActionsFromArgv(['--other'])).toEqual([]);
  });
});

describe('helpers', () => {
  it('tells urls from paths', () => {
    expect(looksLikeConnectionUrl('postgresql://h/db')).toBe(true);
    expect(looksLikeConnectionUrl('/home/me/postgres://x')).toBe(false);
    expect(looksLikeConnectionUrl('./db.sqlite')).toBe(false);
  });

  it('validates table names', () => {
    expect(parseTargetTable('users')).toEqual({ schema: null, table: 'users' });
    expect(parseTargetTable('public.users')).toEqual({ schema: 'public', table: 'users' });
    for (const bad of ['', 'a;drop', 'a b', '1abc', 'a.b.c', '"quoted"', 'a-b']) {
      expect(parseTargetTable(bad)).toBeNull();
    }
  });

  it('compares endpoints', () => {
    const a = { host: 'DB', port: 5432, database: 'x', user: 'u', engine: 'postgres' };
    expect(sameEndpoint(a, { ...a, host: 'db' })).toBe(true);
    expect(sameEndpoint(a, { ...a, port: 1 })).toBe(false);
    expect(sameEndpoint(a, { ...a, engine: 'mysql' })).toBe(false);
  });
});
