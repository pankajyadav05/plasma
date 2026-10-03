import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  allowSqlitePath,
  assertSqlitePathAllowed,
  createSqliteFile,
  resetPickedSqlitePaths,
  sqliteFileProblem,
} from './sqlite-files';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plasma-sqlfiles-'));
  resetPickedSqlitePaths();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('SQLite path allowlist', () => {
  it('refuses a path nobody picked', () => {
    expect(() => assertSqlitePathAllowed(join(dir, 'a.db'))).toThrow(/file picker/);
  });

  it('accepts a picked path, normalised', () => {
    allowSqlitePath(join(dir, 'x', '..', 'a.db'));
    expect(() => assertSqlitePathAllowed(join(dir, 'a.db'))).not.toThrow();
  });

  it('accepts the path already saved for the connection, and only that one', () => {
    const saved = join(dir, 'saved.db');
    expect(() => assertSqlitePathAllowed(saved, saved)).not.toThrow();
    expect(() => assertSqlitePathAllowed(join(dir, 'other.db'), saved)).toThrow();
  });

  it('refuses relative paths, NUL bytes and empty strings even when saved', () => {
    expect(() => assertSqlitePathAllowed('a.db', 'a.db')).toThrow();
    expect(() => assertSqlitePathAllowed(`${dir}/a.db\0.txt`, `${dir}/a.db\0.txt`)).toThrow();
    expect(() => assertSqlitePathAllowed('', '')).toThrow();
  });
});

describe('SQLite file checks', () => {
  it('creates a valid empty database and leaves an existing one alone', () => {
    const p = join(dir, 'new.db');
    createSqliteFile(p);
    expect(sqliteFileProblem(p)).toBeNull();
    const db = new Database(p);
    db.exec('CREATE TABLE t (a)');
    db.close();
    createSqliteFile(p);
    const again = new Database(p, { readonly: true });
    expect(again.prepare("select count(*) n from sqlite_schema where name = 't'").get()).toEqual({
      n: 1,
    });
    again.close();
  });

  it('rejects files that are not databases', () => {
    const p = join(dir, 'text.db');
    writeFileSync(p, 'hello world, definitely not sqlite');
    expect(sqliteFileProblem(p)).toMatch(/not a SQLite database/);
    expect(() => createSqliteFile(p)).toThrow(/not a SQLite database/);
    expect(sqliteFileProblem(dir)).toMatch(/not a file/);
    expect(sqliteFileProblem(join(dir, 'missing'))).toMatch(/does not exist/);
  });

  it('treats an empty file as a fresh database', () => {
    const p = join(dir, 'empty.db');
    writeFileSync(p, '');
    expect(sqliteFileProblem(p)).toBeNull();
  });
});
