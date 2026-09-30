import { describe, expect, it } from 'vitest';
import {
  type BackupRequest,
  type PgEndpoint,
  buildPgDumpInvocation,
  buildPgRestoreInvocation,
  checkToolVersion,
  defaultBackupName,
  detectRestoreKind,
  isSafeRestoreDatabaseName,
  parseServerMajor,
  parseToolMajor,
  quotePattern,
} from './pg-backup';

const ep: PgEndpoint = {
  host: '127.0.0.1',
  port: 5432,
  user: 'me',
  password: 's3cret',
  ssl: false,
};
const base = { database: 'app', outputPath: '/tmp/out.dump' } as BackupRequest;

describe('buildPgDumpInvocation', () => {
  it('builds custom-format args with the password only in env', () => {
    const inv = buildPgDumpInvocation(base, ep);
    expect(inv.args).toContain('--format=c');
    expect(inv.args).toContain('--file=/tmp/out.dump');
    expect(inv.args).toContain('--no-password');
    expect(inv.env).toEqual({ PGPASSWORD: 's3cret', PGDATABASE: 'app' });
    expect(inv.display).not.toContain('s3cret');
    expect(inv.args.join(' ')).not.toContain('s3cret');
  });

  it('handles scope, ownership and gzip flags', () => {
    const inv = buildPgDumpInvocation(
      {
        ...base,
        format: 'plain',
        scope: 'schemaOnly',
        noOwner: true,
        noPrivileges: true,
        gzip: true,
      },
      ep,
    );
    expect(inv.args).toEqual(
      expect.arrayContaining([
        '--format=p',
        '--schema-only',
        '--no-owner',
        '--no-privileges',
        '--compress=6',
      ]),
    );
    const data = buildPgDumpInvocation({ ...base, scope: 'dataOnly' }, ep);
    expect(data.args).toContain('--data-only');
  });

  it('only compresses plain output and only parallelises directory output', () => {
    const custom = buildPgDumpInvocation({ ...base, gzip: true, jobs: 4 }, ep);
    expect(custom.args.some((a) => a.startsWith('--compress'))).toBe(false);
    expect(custom.args.some((a) => a.startsWith('--jobs'))).toBe(false);
    const dir = buildPgDumpInvocation({ ...base, format: 'directory', jobs: 4 }, ep);
    expect(dir.args).toContain('--jobs=4');
  });

  it('quotes schema and table selections so glob characters stay literal', () => {
    const inv = buildPgDumpInvocation(
      {
        ...base,
        schemas: ['public'],
        tables: [{ schema: 'my schema', table: 'we"ird*' }],
      },
      ep,
    );
    expect(inv.args).toContain('--schema="public"');
    expect(inv.args).toContain('--table="my schema"."we""ird*"');
    expect(quotePattern('a"b')).toBe('"a""b"');
  });

  it('cannot be injected through values: everything is a single --opt=value element', () => {
    const evil = '--file=/etc/passwd';
    const inv = buildPgDumpInvocation(
      {
        ...base,
        database: 'x; rm -rf / && host=evil',
        schemas: [evil, '; touch /tmp/pwn'],
        tables: [{ schema: '-h', table: '$(reboot)' }],
        outputPath: '-o evil',
      },
      { ...ep, user: '-U root', host: '-evil' },
    );
    for (const a of inv.args) expect(a.startsWith('--')).toBe(true);
    // The database never reaches argv (no libpq connection-string expansion).
    expect(inv.args.some((a) => a.includes('rm -rf'))).toBe(false);
    expect(inv.env.PGDATABASE).toBe('x; rm -rf / && host=evil');
    expect(inv.args).toContain('--file=-o evil');
    expect(inv.args.filter((a) => a.startsWith('--file='))).toHaveLength(1);
  });

  it('rejects NUL bytes and an empty output path', () => {
    expect(() => buildPgDumpInvocation({ ...base, database: 'a\0b' }, ep)).toThrow();
    expect(() => buildPgDumpInvocation({ ...base, outputPath: '' }, ep)).toThrow();
  });

  it('sets sslmode when the connection uses TLS', () => {
    expect(buildPgDumpInvocation(base, { ...ep, ssl: true }).env.PGSSLMODE).toBe('require');
  });
});

describe('buildPgRestoreInvocation', () => {
  const r = { filePath: '/tmp/a.dump', database: 'target', kind: 'archive' as const };

  it('builds pg_restore args with the file last, after --', () => {
    const inv = buildPgRestoreInvocation(
      { ...r, clean: true, ifExists: true, noOwner: true, jobs: 4 } as never,
      ep,
    );
    expect(inv.tool).toBe('pg_restore');
    expect(inv.args.slice(-2)).toEqual(['--', '/tmp/a.dump']);
    expect(inv.args).toEqual(
      expect.arrayContaining([
        '--dbname=target',
        '--clean',
        '--if-exists',
        '--no-owner',
        '--jobs=4',
      ]),
    );
    expect(inv.env.PGPASSWORD).toBe('s3cret');
  });

  it('drops --if-exists without --clean and --jobs with --single-transaction', () => {
    const inv = buildPgRestoreInvocation(
      { ...r, ifExists: true, singleTransaction: true, jobs: 4 } as never,
      ep,
    );
    expect(inv.args).not.toContain('--if-exists');
    expect(inv.args).not.toContain('--jobs=4');
    expect(inv.args).toContain('--single-transaction');
  });

  it('refuses target names libpq would parse as a connection string', () => {
    expect(isSafeRestoreDatabaseName('host=evil dbname=x')).toBe(false);
    expect(isSafeRestoreDatabaseName('postgresql://evil/x')).toBe(false);
    expect(isSafeRestoreDatabaseName('normal_db')).toBe(true);
    expect(() => buildPgRestoreInvocation({ ...r, database: 'a=b' } as never, ep)).toThrow();
  });

  it('a file named like an option stays a positional argument', () => {
    const inv = buildPgRestoreInvocation({ ...r, filePath: '--clean' } as never, ep);
    expect(inv.args.slice(-2)).toEqual(['--', '--clean']);
  });

  it('plain restores use psql reading stdin with the database in env', () => {
    const inv = buildPgRestoreInvocation(
      { ...r, kind: 'plain', singleTransaction: true } as never,
      ep,
    );
    expect(inv.tool).toBe('psql');
    expect(inv.args).toEqual(
      expect.arrayContaining(['--file=-', '--single-transaction', '--set=ON_ERROR_STOP=1']),
    );
    expect(inv.env.PGDATABASE).toBe('target');
    expect(inv.args.some((a) => a.includes('a.dump'))).toBe(false);
  });
});

describe('versions and detection', () => {
  it('parses tool and server majors', () => {
    expect(parseToolMajor('pg_dump (PostgreSQL) 16.3 (Ubuntu 16.3-1)')).toBe(16);
    expect(parseToolMajor('psql (PostgreSQL) 9.6.24')).toBe(9.6);
    expect(parseServerMajor('15.4')).toBe(15);
    expect(parseServerMajor('nothing')).toBeNull();
  });

  it('errors for an older pg_dump, warns for other mismatches', () => {
    expect(checkToolVersion('pg_dump', 14, 16).level).toBe('error');
    expect(checkToolVersion('pg_dump', 17, 16).level).toBe('warn');
    expect(checkToolVersion('pg_restore', 14, 16).level).toBe('warn');
    expect(checkToolVersion('psql', 16, 16).level).toBe('ok');
    expect(checkToolVersion('psql', null, 16).level).toBe('ok');
  });

  it('detects archives by magic, directory or extension', () => {
    const magic = new TextEncoder().encode('PGDMP\u0001');
    expect(detectRestoreKind('x.bin', magic)).toBe('archive');
    expect(detectRestoreKind('x', null, true)).toBe('archive');
    expect(detectRestoreKind('x.sql', new TextEncoder().encode('-- dump'))).toBe('plain');
    expect(detectRestoreKind('x.dump', null)).toBe('archive');
  });

  it('suggests file names', () => {
    expect(defaultBackupName('my db', 'custom', false)).toBe('my_db.dump');
    expect(defaultBackupName('a', 'plain', true)).toBe('a.sql.gz');
  });
});

describe('toolCandidates', () => {
  it('lists the configured folder first, then PATH, without duplicates', async () => {
    const { toolCandidates } = await import('./pg-backup');
    expect(
      toolCandidates('pg_dump', '/opt/pg/bin/', '/usr/bin:/opt/pg/bin', 'linux', ['/x']),
    ).toEqual(['/opt/pg/bin/pg_dump', '/usr/bin/pg_dump', '/x/pg_dump']);
    expect(toolCandidates('psql', 'C:\\pg\\bin', 'C:\\Windows', 'win32')).toEqual([
      'C:\\pg\\bin\\psql.exe',
      'C:\\Windows\\psql.exe',
    ]);
    expect(toolCandidates('psql', '', '', 'linux')).toEqual([]);
  });
});
