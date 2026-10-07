import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cellToText } from '@shared/cell-edit';
import type { GuardValue } from '@shared/edit-guard';
import type { ConnectionConfig } from '@shared/protocol';
import { dialectFor } from '@shared/sql-dialect';
import { buildDeleteSql, buildUpdateSql } from '@shared/table-query';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteDriver, normalizeSqliteCell, sqliteTypeName, toSqliteBinding } from './sqlite';

/**
 * Workbench flows against a real SQLite file (no server needed): browse,
 * filter / sort / page, edits in a transaction (PK and rowid), insert, delete,
 * export, introspection, EXPLAIN, read-only mode, backup.
 */

let dir: string;
let file: string;
let drv: SqliteDriver;

function config(over: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: 't',
    name: 't',
    engine: 'sqlite',
    host: 'local',
    port: 1,
    database: file,
    user: '',
    password: '',
    ssl: false,
    readOnly: false,
    ...over,
  } as ConnectionConfig;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'plasma-sqlite-'));
  file = join(dir, 'test.db');
  const seed = new Database(file);
  seed.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER DEFAULT 18, bio TEXT);
    CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT);
    CREATE TABLE tags (label TEXT, weight REAL);
    CREATE TABLE pair (a INTEGER, b INTEGER, v TEXT, PRIMARY KEY (a, b)) WITHOUT ROWID;
    CREATE VIEW adults AS SELECT * FROM users WHERE age >= 18;
    CREATE INDEX posts_title ON posts (title);
    CREATE TRIGGER users_touch AFTER UPDATE ON users BEGIN
      UPDATE users SET bio = 'touched' WHERE id = NEW.id AND bio IS NULL;
    END;
    INSERT INTO users (name, age) VALUES ('ada', 36), ('bob', 12), ('cy', 41);
    INSERT INTO posts (user_id, title) VALUES (1, 'hello'), (1, 'world');
    INSERT INTO tags VALUES ('x', 1.5), ('y', 2.5);
  `);
  seed.close();
  drv = new SqliteDriver();
  await drv.connect(config());
  drv.setConnectionGen(1);
});

afterEach(async () => {
  await drv.disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe('values', () => {
  it('names declared types by affinity', () => {
    expect(sqliteTypeName('INTEGER')).toBe('integer');
    expect(sqliteTypeName('VARCHAR(40)')).toBe('text');
    expect(sqliteTypeName('BLOB')).toBe('bytea');
    expect(sqliteTypeName('DOUBLE PRECISION')).toBe('real');
    expect(sqliteTypeName('DATETIME')).toBe('timestamp');
    expect(sqliteTypeName(null)).toBe('');
  });

  it('keeps big integers and blobs lossless for the grid', () => {
    expect(normalizeSqliteCell(5n)).toBe(5);
    expect(normalizeSqliteCell(9007199254740993n)).toBe('9007199254740993');
    expect(normalizeSqliteCell(Buffer.from([1, 255]))).toBe('\\x01ff');
    expect(toSqliteBinding(true)).toBe(1);
    expect(toSqliteBinding({ a: 1 })).toBe('{"a":1}');
  });
});

describe('queries', () => {
  it('returns typed columns, rows and the server version', async () => {
    const r = await drv.query('SELECT id, name, age FROM users ORDER BY id');
    expect(r.columns.map((c) => c.name)).toEqual(['id', 'name', 'age']);
    expect(r.columns.map((c) => c.dataTypeName)).toEqual(['integer', 'text', 'integer']);
    expect(r.rows).toEqual([
      [1, 'ada', 36],
      [2, 'bob', 12],
      [3, 'cy', 41],
    ]);
    expect(r.rowCount).toBe(3);
    expect(r.txnState).toBe('none');
  });

  it('binds $n placeholders, including a repeated one', async () => {
    const r = await drv.query(
      'SELECT name FROM users WHERE age > $1 OR name = $2 OR age = $1 ORDER BY id',
      ['30', 'bob'],
    );
    expect(r.rows).toEqual([['ada'], ['bob'], ['cy']]);
  });

  it('runs several statements and returns the last result', async () => {
    const r = await drv.query("INSERT INTO tags VALUES ('z', 3); SELECT count(*) AS n FROM tags;");
    expect(r.rows).toEqual([[3]]);
  });

  it('reports command and rowCount for writes', async () => {
    const r = await drv.query("UPDATE users SET age = age + 1 WHERE name != 'zzz'");
    expect(r.command).toBe('UPDATE');
    expect(r.rowCount).toBe(3);
  });

  it('infers a type for expression columns', async () => {
    const r = await drv.query("SELECT 1 AS i, 1.5 AS f, 'x' AS s");
    expect(r.columns.map((c) => c.dataTypeName)).toEqual(['integer', 'real', 'text']);
  });

  it('caps rows and flags the result as truncated', async () => {
    const r = await drv.query(
      'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 50) SELECT x FROM c',
      [],
      { maxRows: 10 },
    );
    expect(r.rows).toHaveLength(10);
    expect(r.truncated).toBe(true);
  });

  it('surfaces SQL errors', async () => {
    await expect(drv.query('SELECT * FROM nope')).rejects.toThrow(/no such table/);
  });

  it('keeps trigger bodies in one statement', async () => {
    await drv.query(
      'CREATE TRIGGER posts_log AFTER INSERT ON posts BEGIN SELECT 1; SELECT 2; END; SELECT 7 AS ok',
    );
    const r = await drv.query('SELECT name FROM sqlite_schema WHERE type = $1', ['trigger']);
    expect(r.rows.map((x) => x[0]).sort()).toEqual(['posts_log', 'users_touch']);
  });

  it('tracks explicit transactions', async () => {
    expect(await drv.beginTransaction()).toBe('active');
    await drv.query("INSERT INTO tags VALUES ('t', 0)");
    expect((await drv.query('SELECT 1')).txnState).toBe('active');
    expect(await drv.rollbackTransaction()).toBe('none');
    expect((await drv.query('SELECT count(*) FROM tags')).rows[0]![0]).toBe(2);
  });

  it('auto-begins in transaction mode', async () => {
    const r = await drv.query("INSERT INTO tags VALUES ('t', 0)", [], { autoBegin: true });
    expect(r.txnState).toBe('active');
    await drv.commitTransaction();
  });

  it('serialises overlapping requests on the one connection', async () => {
    const [a, b] = await Promise.all([
      drv.query('SELECT count(*) FROM users'),
      drv.sidebandQuery('SELECT count(*) FROM posts'),
    ]);
    expect([a.rows[0]![0], b.rows[0]![0]]).toEqual([3, 2]);
  });

  it('sideband and AI queries refuse writes', async () => {
    await expect(drv.sidebandQuery('DELETE FROM users')).rejects.toThrow(/read-only/);
    await expect(drv.aiQuery('DROP TABLE users')).rejects.toThrow(/read-only/);
    await expect(drv.aiQuery('SELECT 1; SELECT 2')).rejects.toThrow(/single/);
    expect((await drv.aiQuery('SELECT count(*) FROM users')).rows[0]![0]).toBe(3);
    // query_only was restored: ordinary writes still work afterwards.
    await drv.query("INSERT INTO tags VALUES ('ok', 1)");
  });

  it('stops a long SELECT when cancelled', async () => {
    const run = drv.query(
      'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 3000000) SELECT x FROM c',
      [],
      { maxRows: 10_000_000, maxBytes: 1 << 30 },
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(await drv.cancelQuery()).toBe(true);
    await expect(run).rejects.toThrow(/cancel/);
    expect((await drv.query('SELECT 1')).rows).toEqual([[1]]);
  });
});

describe('edit batches', () => {
  it('applies updates, inserts and deletes atomically by primary key', async () => {
    const r = await drv.commitEditBatch(1, [
      {
        sql: 'UPDATE "main"."users" SET "name" = $1 WHERE "id" = $2',
        params: ['ADA', '1'],
        label: 'update',
      },
      { sql: 'INSERT INTO "main"."users" ("name") VALUES ($1)', params: ['dee'] },
      { sql: 'DELETE FROM "main"."users" WHERE "id" = $1', params: ['2'] },
    ]);
    expect(r.applied).toBe(3);
    const rows = (await drv.query('SELECT id, name FROM users ORDER BY id')).rows;
    expect(rows).toEqual([
      [1, 'ADA'],
      [3, 'cy'],
      [4, 'dee'],
    ]);
  });

  it('rolls everything back when one statement matches no row', async () => {
    const r = await drv.commitEditBatch(1, [
      { sql: 'UPDATE users SET name = $1 WHERE id = $2', params: ['X', '1'] },
      { sql: 'UPDATE users SET name = $1 WHERE id = $2', params: ['Y', '999'] },
    ]);
    expect(r.applied).toBe(0);
    expect(r.conflicts).toEqual([{ index: 1, reason: 'no-match' }]);
    expect((await drv.query("SELECT count(*) FROM users WHERE name = 'X'")).rows[0]![0]).toBe(0);
    expect(drv.getTxnState()).toBe('none');
  });

  it('edits a table without a primary key through rowid', async () => {
    const before = await drv.query('SELECT rowid, label FROM tags ORDER BY rowid');
    expect(before.columns[0]!.name).toBe('rowid');
    await drv.commitEditBatch(1, [
      { sql: 'UPDATE "main"."tags" SET "weight" = $1 WHERE "rowid" = $2', params: ['9.5', '2'] },
    ]);
    expect((await drv.query("SELECT weight FROM tags WHERE label = 'y'")).rows).toEqual([[9.5]]);
  });

  it('uses a savepoint inside the user transaction and leaves it open', async () => {
    await drv.beginTransaction();
    await drv.commitEditBatch(1, [
      { sql: 'UPDATE users SET name = $1 WHERE id = $2', params: ['Q', '1'] },
    ]);
    expect(drv.getTxnState()).toBe('active');
    await drv.rollbackTransaction();
    expect((await drv.query('SELECT name FROM users WHERE id = 1')).rows).toEqual([['ada']]);
  });

  it('refuses a stale connection generation', async () => {
    await expect(
      drv.commitEditBatch(7, [{ sql: 'DELETE FROM users WHERE id = $1', params: ['1'] }]),
    ).rejects.toThrow(/generation mismatch/);
  });

  it('enforces foreign keys', async () => {
    await expect(
      drv.query('INSERT INTO posts (user_id, title) VALUES (999, $1)', ['orphan']),
    ).rejects.toThrow(/FOREIGN KEY/);
    await drv.query('DELETE FROM users WHERE id = 1');
    expect((await drv.query('SELECT count(*) FROM posts')).rows[0]![0]).toBe(0);
  });
});

describe('concurrent edits (B1)', () => {
  const sqlite = dialectFor('sqlite');
  /** A second client changing the file between "grid loaded" and "commit". */
  function other(sql: string, ...args: unknown[]): void {
    const db = new Database(file);
    try {
      db.prepare(sql).run(...args);
    } finally {
      db.close();
    }
  }
  const guarded = (set: Record<string, unknown>, id: string, guards: GuardValue[]) => {
    const { sql, params } = buildUpdateSql({
      schema: 'main',
      table: 'users',
      set,
      pkValues: { id },
      guards,
      dialect: sqlite,
    });
    return { sql, params: params as unknown[], kind: 'update' as const };
  };

  it('commits when nothing changed since the load (integer column compared as text)', async () => {
    const r = await drv.commitEditBatch(1, [
      guarded({ age: '37' }, '1', [{ column: 'age', value: '36', type: 'integer' }]),
    ]);
    expect(r).toMatchObject({ applied: 1, conflicts: [] });
    expect((await drv.query('SELECT age FROM users WHERE id = 1')).rows).toEqual([[37]]);
  });

  it('refuses to overwrite a value somebody else changed, and keeps theirs', async () => {
    other("UPDATE users SET name = 'ADA (theirs)' WHERE id = 1");
    const r = await drv.commitEditBatch(1, [
      guarded({ name: 'mine' }, '1', [{ column: 'name', value: 'ada', type: 'text' }]),
    ]);
    expect(r.applied).toBe(0);
    expect(r.conflicts).toEqual([{ index: 0, reason: 'no-match' }]);
    expect((await drv.query('SELECT name FROM users WHERE id = 1')).rows).toEqual([
      ['ADA (theirs)'],
    ]);
    expect(drv.getTxnState()).toBe('none');
  });

  it('does not conflict when somebody changed a column this edit leaves alone', async () => {
    other('UPDATE users SET age = 99 WHERE id = 1');
    const r = await drv.commitEditBatch(1, [
      guarded({ name: 'mine' }, '1', [{ column: 'name', value: 'ada', type: 'text' }]),
    ]);
    expect(r.conflicts).toEqual([]);
    expect((await drv.query('SELECT name, age FROM users WHERE id = 1')).rows).toEqual([
      ['mine', 99],
    ]);
  });

  it('compares NULL to NULL (IS, not =)', async () => {
    const ok = await drv.commitEditBatch(1, [
      guarded({ bio: 'x' }, '2', [{ column: 'bio', value: null, type: 'text' }]),
    ]);
    expect(ok.conflicts).toEqual([]);
    other("UPDATE users SET bio = 'taken' WHERE id = 3");
    const bad = await drv.commitEditBatch(1, [
      guarded({ bio: 'y' }, '3', [{ column: 'bio', value: null, type: 'text' }]),
    ]);
    expect(bad.conflicts).toHaveLength(1);
  });

  it('rolls the whole batch back when only one row conflicts, and reports every conflict', async () => {
    other("UPDATE users SET name = 'theirs' WHERE id = 2");
    other("UPDATE users SET name = 'theirs too' WHERE id = 3");
    const r = await drv.commitEditBatch(1, [
      guarded({ name: 'one' }, '1', [{ column: 'name', value: 'ada', type: 'text' }]),
      guarded({ name: 'two' }, '2', [{ column: 'name', value: 'bob', type: 'text' }]),
      guarded({ name: 'three' }, '3', [{ column: 'name', value: 'cy', type: 'text' }]),
    ]);
    expect(r.applied).toBe(0);
    expect(r.conflicts.map((c) => c.index)).toEqual([1, 2]);
    expect((await drv.query('SELECT name FROM users ORDER BY id')).rows).toEqual([
      ['ada'],
      ['theirs'],
      ['theirs too'],
    ]);
  });

  it('a DELETE of a row that changed, or is already gone, is a conflict', async () => {
    const del = (id: string, cols: GuardValue[]) => {
      const { sql, params } = buildDeleteSql({
        schema: 'main',
        table: 'users',
        pkValues: { id },
        guards: cols,
        dialect: sqlite,
      });
      return { sql, params: params as unknown[], kind: 'delete' as const };
    };
    const row = (name: string, age: string): GuardValue[] => [
      { column: 'id', value: '2', type: 'integer' },
      { column: 'name', value: name, type: 'text' },
      { column: 'age', value: age, type: 'integer' },
      { column: 'bio', value: null, type: 'text' },
    ];
    other('UPDATE users SET age = 13 WHERE id = 2');
    const changed = await drv.commitEditBatch(1, [del('2', row('bob', '12'))]);
    expect(changed.conflicts).toEqual([{ index: 0, reason: 'no-match' }]);
    other('DELETE FROM posts WHERE user_id = 3');
    other('DELETE FROM users WHERE id = 3');
    const gone = await drv.commitEditBatch(1, [del('3', row('cy', '41'))]);
    expect(gone.conflicts).toEqual([{ index: 0, reason: 'no-match' }]);
    expect((await drv.query('SELECT count(*) FROM users WHERE id = 2')).rows[0]![0]).toBe(1);
    // (the users_touch trigger set bio when the other client changed the row)
    const nowRow = row('bob', '13').map((c) =>
      c.column === 'bio' ? { ...c, value: 'touched' } : c,
    );
    const fine = await drv.commitEditBatch(1, [del('2', nowRow)]);
    expect(fine).toMatchObject({ applied: 1, conflicts: [] });
  });

  it('a row holding a BLOB is deleted and updated without a false conflict (P1-3)', async () => {
    await drv.query('CREATE TABLE blobs (id INTEGER PRIMARY KEY, data BLOB, loose, note TEXT)');
    await drv.query("INSERT INTO blobs VALUES (1, x'deadbeef', x'00', 'n')");
    await drv.query("INSERT INTO blobs VALUES (2, x'cafe', x'01', 'm')");
    const load = async (id: number) => {
      const res = await drv.query(`SELECT * FROM blobs WHERE id = ${id}`);
      return res.columns.map((c, i) => ({
        column: c.name,
        value: cellToText(res.rows[0]?.[i], c.dataTypeName),
        type: c.dataTypeName,
      }));
    };
    const del = buildDeleteSql({
      schema: 'main',
      table: 'blobs',
      pkValues: { id: '1' },
      guards: await load(1),
      dialect: sqlite,
    });
    const r1 = await drv.commitEditBatch(1, [
      { sql: del.sql, params: del.params as unknown[], kind: 'delete' },
    ]);
    expect(r1).toMatchObject({ applied: 1, conflicts: [] });
    const guards = (await load(2)).filter((g) => g.column !== 'id');
    const upd = buildUpdateSql({
      schema: 'main',
      table: 'blobs',
      set: { note: 'z' },
      pkValues: { id: '2' },
      guards,
      dialect: sqlite,
    });
    const r2 = await drv.commitEditBatch(1, [
      { sql: upd.sql, params: upd.params as unknown[], kind: 'update' },
    ]);
    expect(r2).toMatchObject({ applied: 1, conflicts: [] });
  });

  it('an INSERT with a key that now exists is reported as a duplicate; nothing else is saved', async () => {
    const r = await drv.commitEditBatch(1, [
      guarded({ name: 'fine' }, '1', [{ column: 'name', value: 'ada', type: 'text' }]),
      {
        sql: 'INSERT INTO "main"."users" ("id", "name") VALUES ($1, $2)',
        params: ['2', 'dup'],
        kind: 'insert',
      },
    ]);
    expect(r.applied).toBe(0);
    expect(r.conflicts).toEqual([{ index: 1, reason: 'duplicate' }]);
    expect((await drv.query('SELECT name FROM users WHERE id = 1')).rows).toEqual([['ada']]);
  });

  it('inside the user transaction a conflict rolls back to the savepoint and leaves it open', async () => {
    await drv.beginTransaction();
    await drv.query('UPDATE users SET age = 50 WHERE id = 3');
    await drv.query("UPDATE users SET name = 'changed in my transaction' WHERE id = 1");
    const r = await drv.commitEditBatch(1, [
      guarded({ name: 'mine' }, '1', [{ column: 'name', value: 'ada', type: 'text' }]),
    ]);
    expect(r.conflicts).toHaveLength(1);
    expect(drv.getTxnState()).toBe('active');
    expect((await drv.query('SELECT age FROM users WHERE id = 3')).rows).toEqual([[50]]);
    await drv.rollbackTransaction();
  });
});

describe('introspection', () => {
  it('lists tables, views, columns, keys, indexes and triggers', async () => {
    const info = await drv.introspect();
    const tables = Object.fromEntries(info.tables.map((t) => [t.name, t]));
    expect(Object.keys(tables).sort()).toEqual(['adults', 'pair', 'posts', 'tags', 'users']);
    expect(tables.adults!.kind).toBe('view');
    expect(tables.tags!.implicitRowid).toBe('rowid');
    expect(tables.users!.implicitRowid).toBeUndefined();
    expect(tables.pair!.implicitRowid).toBeUndefined();

    const col = (t: string, c: string) => info.columns.find((x) => x.table === t && x.name === c)!;
    expect(col('users', 'id')).toMatchObject({
      isPrimaryKey: true,
      isNullable: false,
      dataType: 'INTEGER',
    });
    expect(col('users', 'name')).toMatchObject({ isNullable: false, hasDefault: false });
    expect(col('users', 'age')).toMatchObject({
      hasDefault: true,
      defaultExpr: '18',
      isNullable: true,
    });
    expect(
      info.columns.filter((c) => c.table === 'pair' && c.isPrimaryKey).map((c) => c.name),
    ).toEqual(['a', 'b']);

    expect(info.foreignKeys).toEqual([
      expect.objectContaining({
        table: 'posts',
        column: 'user_id',
        refTable: 'users',
        refColumn: 'id',
        onDelete: 'CASCADE',
        onUpdate: 'NO ACTION',
      }),
    ]);
    expect(info.indexes!.find((i) => i.name === 'posts_title')).toMatchObject({
      table: 'posts',
      unique: false,
      definition: 'CREATE INDEX posts_title ON posts (title)',
    });
    expect(info.triggers).toEqual([
      expect.objectContaining({ name: 'users_touch', table: 'users' }),
    ]);
    expect(info.schemas).toEqual([{ name: 'main' }]);
  });

  it('falls back to another rowid alias when a column shadows rowid', async () => {
    await drv.query('CREATE TABLE shadow (rowid TEXT, v TEXT)');
    const info = await drv.introspect();
    expect(info.tables.find((t) => t.name === 'shadow')!.implicitRowid).toBe('_rowid_');
  });
});

describe('explain and export', () => {
  it('turns EXPLAIN QUERY PLAN into a plan tree', async () => {
    const r = await drv.explain('SELECT * FROM posts WHERE title = $1', false, ['x']);
    const plan = JSON.parse(String(r.rows[0]![0]));
    expect(plan[0].Plan['Node Type']).toBe('Query plan');
    expect(plan[0].Plan.Plans[0]['Relation Name']).toBe('posts');
    expect(plan[0].Plan.Plans[0]['Index Name']).toBe('posts_title');
  });

  it('streams a query for export in batches', async () => {
    await drv.query(
      'INSERT INTO tags SELECT hex(randomblob(4)), 1.0 FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 1200) SELECT x FROM c)',
    );
    let n = 0;
    let batches = 0;
    let cols = 0;
    for await (const b of drv.streamQueryForExport('SELECT * FROM tags')) {
      n += b.rows.length;
      batches++;
      cols = b.columns.length;
    }
    expect(n).toBe(1202);
    expect(batches).toBeGreaterThan(1);
    expect(cols).toBe(2);
    // The connection is usable again once the export is done.
    expect((await drv.query('SELECT 1')).rows).toEqual([[1]]);
  });

  it('still exports the header of an empty result', async () => {
    const out: number[] = [];
    for await (const b of drv.streamQueryForExport('SELECT * FROM tags WHERE 0'))
      out.push(b.columns.length);
    expect(out).toEqual([2]);
  });
});

describe('read-only and backup', () => {
  it('opens read-only: reads work, writes fail', async () => {
    await drv.disconnect();
    const ro = new SqliteDriver();
    await ro.connect(config({ readOnly: true }));
    expect((await ro.query('SELECT count(*) FROM users')).rows[0]![0]).toBe(3);
    await expect(ro.query("INSERT INTO tags VALUES ('n', 1)")).rejects.toThrow(
      /readonly|read-only/i,
    );
    // Flipping query_only does not help on a read-only file handle.
    await ro.query('PRAGMA query_only = OFF').catch(() => undefined);
    await expect(ro.query('DELETE FROM tags')).rejects.toThrow(/readonly|read-only/i);
    await expect(
      ro.commitEditBatch(0, [{ sql: 'DELETE FROM tags WHERE label = $1', params: ['x'] }]),
    ).rejects.toThrow();
    await ro.disconnect();
  });

  it('refuses a missing file and a non-database file', async () => {
    const d = new SqliteDriver();
    await expect(d.connect(config({ database: join(dir, 'missing.db') }))).rejects.toThrow(
      /not found/,
    );
    const bad = join(dir, 'bad.db');
    new Database(bad).close();
    const fs = await import('node:fs');
    fs.writeFileSync(bad, 'this is not a sqlite file at all, just text padding.....');
    await expect(d.connect(config({ database: bad }))).rejects.toThrow(/not a database/i);
  });

  it('copies the database with the backup API', async () => {
    const copy = join(dir, 'copy.db');
    const { bytes } = await drv.backupTo(copy);
    expect(bytes).toBeGreaterThan(0);
    expect(existsSync(copy)).toBe(true);
    const c = new Database(copy, { readonly: true });
    expect(c.prepare('select count(*) n from users').get()).toEqual({ n: 3 });
    c.close();
    await expect(drv.backupTo(file)).rejects.toThrow(/different file/);
  });
});
