import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptDataFiles,
  assertDuckdbConfigAllowed,
  buildDuckdbAttachments,
  canonicalDataPath,
  dataFileProblem,
  isEphemeralDuckdbSession,
  resetAllowedDataFiles,
  sanitizeDuckdbOptions,
} from './data-files';

let dir: string;
let csv: string;
let parquet: string;
let db: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plasma-datafiles-'));
  csv = join(dir, 'a.csv');
  parquet = join(dir, 'b.parquet');
  db = join(dir, 'w.duckdb');
  for (const f of [csv, parquet, db]) writeFileSync(f, 'x');
  mkdirSync(join(dir, 'folder.csv'));
  writeFileSync(join(dir, 'notes.txt'), 'x');
  writeFileSync(join(dir, 'we[ir]d.csv'), 'x');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => resetAllowedDataFiles());

describe('acceptDataFiles', () => {
  it('accepts supported files and reports each refusal', () => {
    const r = acceptDataFiles([
      csv,
      parquet,
      join(dir, 'notes.txt'),
      join(dir, 'folder.csv'),
      join(dir, 'missing.csv'),
      join(dir, 'we[ir]d.csv'),
      'relative.csv',
      42,
    ]);
    expect(r.accepted).toEqual([csv, parquet]);
    expect(r.problems).toHaveLength(6);
    expect(r.problems.join('\n')).toMatch(/notes\.txt: Unsupported/);
    expect(r.problems.join('\n')).toMatch(/folder\.csv: That path is not a regular file/);
    expect(r.problems.join('\n')).toMatch(/missing\.csv: That file does not exist/);
    expect(r.problems.join('\n')).toMatch(/patterns/);
  });

  it('ignores non-arrays and caps the batch', () => {
    expect(acceptDataFiles('nope')).toEqual({ accepted: [], problems: [] });
    expect(acceptDataFiles(Array.from({ length: 200 }, () => csv)).accepted).toEqual([csv]);
  });

  it('dataFileProblem is null for a good file', () => {
    expect(dataFileProblem(csv)).toBeNull();
    expect(dataFileProblem(undefined)).toMatch(/not valid/);
  });
});

describe('assertDuckdbConfigAllowed', () => {
  it('refuses files that were never picked or dropped', () => {
    expect(() =>
      assertDuckdbConfigAllowed({ database: ':memory:', duckdb: { files: [csv] } }),
    ).toThrow(/file picker/);
    acceptDataFiles([csv]);
    expect(() =>
      assertDuckdbConfigAllowed({ database: ':memory:', duckdb: { files: [csv] } }),
    ).not.toThrow();
  });

  it('refuses a database path unless picked or saved for this connection', () => {
    expect(() => assertDuckdbConfigAllowed({ database: db })).toThrow(/file picker/);
    expect(() => assertDuckdbConfigAllowed({ database: db }, db)).not.toThrow();
    acceptDataFiles([db]);
    expect(() => assertDuckdbConfigAllowed({ database: db })).not.toThrow();
    expect(() => assertDuckdbConfigAllowed({ database: '' })).not.toThrow();
  });

  it('refuses relative paths, wrong kinds and a .duckdb in the file list', () => {
    acceptDataFiles([csv, db]);
    expect(() => assertDuckdbConfigAllowed({ database: 'w.duckdb' })).toThrow();
    expect(() => assertDuckdbConfigAllowed({ database: csv })).toThrow();
    expect(() =>
      assertDuckdbConfigAllowed({ database: ':memory:', duckdb: { files: [db] } }),
    ).toThrow(/not a data file/);
    expect(() =>
      assertDuckdbConfigAllowed({ database: ':memory:', duckdb: { files: ['../etc/passwd'] } }),
    ).toThrow();
  });

  it('follows a symlink to the file that was allowed, not to anything else', () => {
    acceptDataFiles([csv]);
    const link = join(dir, 'link.csv');
    symlinkSync(csv, link);
    expect(canonicalDataPath(link)).toBe(canonicalDataPath(csv));
    expect(() =>
      assertDuckdbConfigAllowed({ database: ':memory:', duckdb: { files: [link] } }),
    ).not.toThrow();
    const other = join(dir, 'other.csv');
    writeFileSync(other, 'x');
    const evil = join(dir, 'evil.csv');
    symlinkSync(other, evil);
    expect(() =>
      assertDuckdbConfigAllowed({ database: ':memory:', duckdb: { files: [evil] } }),
    ).toThrow();
  });
});

describe('sanitizeDuckdbOptions', () => {
  it('drops a renderer-supplied attach list', () => {
    const out = sanitizeDuckdbOptions({
      files: [csv],
      attachConnectionIds: ['c1'],
      attach: [{ alias: 'x', host: 'h', port: 1, database: 'd', user: 'u', password: 'p' }],
    });
    expect(out).toEqual({ files: [csv], attachConnectionIds: ['c1'] });
    expect(sanitizeDuckdbOptions(undefined)).toBeUndefined();
  });
});

describe('buildDuckdbAttachments', () => {
  const pg = (over: Record<string, unknown> = {}) => ({
    id: 'p1',
    name: 'Prod DB',
    engine: 'postgres' as const,
    host: 'db.example.com',
    port: 5432,
    database: 'app',
    user: 'reader',
    password: 'secret',
    ssl: true,
    tls: { mode: 'verify-full' as const, caFile: '/etc/ca.pem' },
    ...over,
  });

  it('maps a saved Postgres connection to an attachment with its TLS mode', () => {
    const [a] = buildDuckdbAttachments(['p1'], { load: () => pg(), sshFor: () => false });
    expect(a).toEqual({
      alias: 'pg_Prod_DB',
      host: 'db.example.com',
      port: 5432,
      database: 'app',
      user: 'reader',
      password: 'secret',
      sslmode: 'verify-full',
      sslrootcert: '/etc/ca.pem',
    });
    const [plain] = buildDuckdbAttachments(['p1'], {
      load: () => pg({ ssl: false, tls: undefined }),
      sshFor: () => false,
    });
    expect(plain?.sslmode).toBe('disable');
    expect(plain?.sslrootcert).toBeUndefined();
  });

  it('refuses missing, non-Postgres and SSH-tunnelled connections', () => {
    expect(() => buildDuckdbAttachments(['x'], { load: () => null, sshFor: () => false })).toThrow(
      /no longer exists/,
    );
    expect(() =>
      buildDuckdbAttachments(['p1'], { load: () => pg({ engine: 'mysql' }), sshFor: () => false }),
    ).toThrow(/only Postgres/);
    expect(() => buildDuckdbAttachments(['p1'], { load: () => pg(), sshFor: () => true })).toThrow(
      /SSH tunnel/,
    );
  });

  it('gives two connections with the same name different aliases', () => {
    const out = buildDuckdbAttachments(['a', 'b'], { load: () => pg(), sshFor: () => false });
    expect(out.map((x) => x.alias)).toEqual(['pg_Prod_DB', 'pg_Prod_DB_2']);
  });
});

describe('isEphemeralDuckdbSession', () => {
  it('only data-file sessions are kept out of the connection list', () => {
    expect(isEphemeralDuckdbSession({ engine: 'duckdb', id: 'duckdb-abc' })).toBe(true);
    expect(isEphemeralDuckdbSession({ engine: 'duckdb', id: 'f3a1-uuid' })).toBe(false);
    expect(isEphemeralDuckdbSession({ engine: 'postgres', id: 'duckdb-abc' })).toBe(false);
  });
});
