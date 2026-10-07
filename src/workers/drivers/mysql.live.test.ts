import type { ConnectionConfig } from '@shared/protocol';
import { dialectFor } from '@shared/sql-dialect';
import { buildUpdateSql } from '@shared/table-query';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MysqlDriver } from './mysql';

/**
 * Opt-in: needs a MySQL / MariaDB server.
 *   PLASMA_LIVE_MYSQL=1 [PLASMA_MYSQL_HOST/PORT/USER/PASSWORD]
 * Creates and drops its own database (`plasma_live_<pid>`).
 */
const live = process.env.PLASMA_LIVE_MYSQL ? describe : describe.skip;

const base = (): ConnectionConfig =>
  ({
    id: 'm',
    name: 'm',
    engine: 'mysql',
    host: process.env.PLASMA_MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.PLASMA_MYSQL_PORT ?? 3306),
    database: '',
    user: process.env.PLASMA_MYSQL_USER ?? 'root',
    password: process.env.PLASMA_MYSQL_PASSWORD ?? '',
    ssl: false,
    readOnly: false,
  }) as ConnectionConfig;

const DB = `plasma_live_${process.pid}`;

live('mysql driver (live)', () => {
  let drv: MysqlDriver;

  beforeAll(async () => {
    const admin = new MysqlDriver();
    await admin.connect(base());
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    await admin.disconnect();
    drv = new MysqlDriver();
    await drv.connect({ ...base(), database: DB });
    drv.setConnectionGen(1);
    await drv.query(`CREATE TABLE users (
      id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(40) NOT NULL, age INT DEFAULT 18, bio TEXT, born DATE, meta JSON)`);
    await drv.query(`CREATE TABLE posts (
      id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, title VARCHAR(80),
      CONSTRAINT fk_posts_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      INDEX posts_title (title))`);
    await drv.query('CREATE TABLE nokey (a INT, b VARCHAR(10))');
    await drv.query(
      `INSERT INTO users (name, age, born) VALUES ('ada', 36, '1815-12-10'), ('bob', 12, NULL), ('cy', 41, NULL)`,
    );
    await drv.query(`INSERT INTO posts (user_id, title) VALUES (1, 'hello'), (1, 'world')`);
    await drv.query('CREATE VIEW adults AS SELECT * FROM users WHERE age >= 18');
  });

  afterAll(async () => {
    const admin = new MysqlDriver();
    await admin.connect(base());
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.disconnect();
    await drv.disconnect();
  });

  it('reports the server version', async () => {
    const d = new MysqlDriver();
    const v = await d.connect(base());
    expect(v).toMatch(/^(MySQL|MariaDB) \d+\.\d+/);
    await d.disconnect();
  });

  it('returns typed columns and rows, binding $n placeholders', async () => {
    const r = await drv.query(
      'SELECT id, name, age, born FROM users WHERE age > $1 OR name = $2 ORDER BY id',
      ['30', 'bob'],
    );
    expect(r.columns.map((c) => [c.name, c.dataTypeName])).toEqual([
      ['id', 'int'],
      ['name', 'varchar'],
      ['age', 'int'],
      ['born', 'date'],
    ]);
    expect(r.rows).toEqual([
      [1, 'ada', 36, '1815-12-10'],
      [2, 'bob', 12, null],
      [3, 'cy', 41, null],
    ]);
  });

  it('runs several statements, reports write counts, surfaces errors', async () => {
    const w = await drv.query("UPDATE users SET age = age + 1 WHERE name <> 'zz'");
    expect(w.command).toBe('UPDATE');
    expect(w.rowCount).toBe(3);
    const r = await drv.query(
      "INSERT INTO nokey VALUES (1, 'x'); SELECT count(*) AS n FROM nokey;",
    );
    expect(r.rows).toEqual([[1]]);
    await expect(drv.query('SELECT * FROM nope')).rejects.toThrow(/doesn't exist/);
  });

  it('pages, filters and counts like the table tab does', async () => {
    const page = await drv.query(
      'SELECT * FROM `users` WHERE CAST(`name` AS CHAR) LIKE $1 ORDER BY `id` ASC LIMIT 1 OFFSET 0',
      ['%A%'],
    );
    expect(page.rows[0]![1]).toBe('ada');
    const cnt = await drv.sidebandQuery('SELECT COUNT(*) FROM `users`', [], { timeoutMs: 5000 });
    expect(Number(cnt.rows[0]![0])).toBe(3);
  });

  it('caps rows and kills the statement', async () => {
    // MySQL stops recursive CTEs at 1000 levels by default; MariaDB has no such cap.
    await drv.query('SET SESSION cte_max_recursion_depth = 200000').catch(() => {});
    const r = await drv.query(
      'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 100000) SELECT x FROM c',
      [],
      { maxRows: 50 },
    );
    expect(r.rows).toHaveLength(50);
    expect(r.truncated).toBe(true);
    expect((await drv.query('SELECT 1')).rows).toEqual([[1]]);
  });

  it('applies edit batches atomically, with rollback on a miss', async () => {
    const ok = await drv.commitEditBatch(1, [
      { sql: 'UPDATE `users` SET `name` = $1 WHERE `id` = $2', params: ['ADA', '1'], label: 'u' },
      { sql: 'INSERT INTO `users` (`name`) VALUES ($1)', params: ['dee'] },
      { sql: 'DELETE FROM `users` WHERE `id` = $1', params: ['2'] },
    ]);
    expect(ok.applied).toBe(3);
    expect((await drv.query('SELECT name FROM users WHERE id = 1')).rows).toEqual([['ADA']]);
    const missed = await drv.commitEditBatch(1, [
      { sql: 'UPDATE `users` SET `name` = $1 WHERE `id` = $2', params: ['X', '1'] },
      { sql: 'UPDATE `users` SET `name` = $1 WHERE `id` = $2', params: ['Y', '999'] },
    ]);
    expect(missed.applied).toBe(0);
    expect(missed.conflicts).toEqual([{ index: 1, reason: 'no-match' }]);
    expect((await drv.query("SELECT count(*) FROM users WHERE name = 'X'")).rows[0]![0]).toBe(0);
    expect(drv.getTxnState()).toBe('none');
    await expect(
      drv.commitEditBatch(9, [{ sql: 'DELETE FROM `users` WHERE `id` = $1', params: ['1'] }]),
    ).rejects.toThrow(/generation mismatch/);
  });

  it('detects a row changed since it was loaded (guarded WHERE, <=>) and an unchanged one commits', async () => {
    const mysql = dialectFor('mysql');
    const stmt = (value: string | null) => {
      const { sql, params } = buildUpdateSql({
        schema: '',
        table: 'users',
        set: { name: 'mine' },
        pkValues: { id: '1' },
        guards: [{ column: 'name', value, type: 'varchar' }],
        dialect: mysql,
      });
      return { sql, params: params as unknown[], kind: 'update' as const };
    };
    const current = (await drv.query('SELECT name FROM users WHERE id = 1')).rows[0]![0] as string;
    await drv.query("UPDATE users SET name = 'theirs' WHERE id = 1");
    const stale = await drv.commitEditBatch(1, [stmt(current)]);
    expect(stale.conflicts).toEqual([{ index: 0, reason: 'no-match' }]);
    expect((await drv.query('SELECT name FROM users WHERE id = 1')).rows).toEqual([['theirs']]);
    // Writing the same value is not "no row": affected rows count matches (FOUND_ROWS).
    const same = await drv.commitEditBatch(1, [
      { sql: 'UPDATE `users` SET `name` = $1 WHERE `id` = $2', params: ['theirs', '1'] },
    ]);
    expect(same.conflicts).toEqual([]);
    const fresh = await drv.commitEditBatch(1, [stmt('theirs')]);
    expect(fresh.applied).toBe(1);
    const dup = await drv.commitEditBatch(1, [
      {
        sql: 'INSERT INTO `users` (`id`, `name`) VALUES ($1, $2)',
        params: ['1', 'dup'],
        kind: 'insert',
      },
    ]);
    expect(dup.conflicts).toEqual([{ index: 0, reason: 'duplicate' }]);
    await drv.query("UPDATE users SET name = 'ADA' WHERE id = 1");
  });

  it('tracks explicit transactions and uses a savepoint for edit batches inside them', async () => {
    expect(await drv.beginTransaction()).toBe('active');
    await drv.commitEditBatch(1, [
      { sql: 'UPDATE `users` SET `name` = $1 WHERE `id` = $2', params: ['Q', '1'] },
    ]);
    expect(drv.getTxnState()).toBe('active');
    expect(await drv.rollbackTransaction()).toBe('none');
    expect((await drv.query('SELECT name FROM users WHERE id = 1')).rows).toEqual([['ADA']]);
  });

  it('introspects schemas, tables, columns, keys, indexes', async () => {
    const info = await drv.introspect();
    expect(info.schemas.map((s) => s.name)).toContain(DB);
    expect(info.schemas.map((s) => s.name)).not.toContain('mysql');
    const mine = info.tables.filter((t) => t.schema === DB);
    expect(mine.map((t) => [t.name, t.kind]).sort()).toEqual([
      ['adults', 'view'],
      ['nokey', 'table'],
      ['posts', 'table'],
      ['users', 'table'],
    ]);
    const col = (t: string, c: string) =>
      info.columns.find((x) => x.schema === DB && x.table === t && x.name === c)!;
    expect(col('users', 'id')).toMatchObject({
      isPrimaryKey: true,
      isNullable: false,
      identity: 'by default',
    });
    expect(col('users', 'name')).toMatchObject({ isNullable: false, hasDefault: false });
    expect(col('users', 'age').hasDefault).toBe(true);
    expect(info.foreignKeys.find((f) => f.schema === DB)).toMatchObject({
      table: 'posts',
      column: 'user_id',
      refTable: 'users',
      refColumn: 'id',
      onDelete: 'CASCADE',
    });
    expect(info.indexes!.find((i) => i.schema === DB && i.name === 'posts_title')).toBeDefined();
    const scoped = await drv.introspect({ objects: false, columnSchemas: [DB] });
    expect(scoped.tables).toEqual([]);
    expect(scoped.columns.every((c) => c.schema === DB)).toBe(true);
  });

  it('explains a statement as a plan tree', async () => {
    const r = await drv.explain('SELECT * FROM posts WHERE title = $1', false, ['x']);
    const plan = JSON.parse(String(r.rows[0]![0]));
    expect(plan[0].Plan['Node Type']).toBe('Query block');
    expect(JSON.stringify(plan)).toContain('posts');
  });

  it('streams a query for export', async () => {
    let n = 0;
    let cols = 0;
    for await (const b of drv.streamQueryForExport('SELECT * FROM users')) {
      n += b.rows.length;
      cols = b.columns.length;
    }
    expect(n).toBe(3);
    expect(cols).toBe(6);
    expect((await drv.query('SELECT 1')).rows).toEqual([[1]]);
  });

  it('AI and sideband reads refuse writes', async () => {
    await expect(drv.aiQuery('DELETE FROM users')).rejects.toThrow(/read-only|READ ONLY/i);
    await expect(drv.aiQuery('SELECT 1; SELECT 2')).rejects.toThrow(/single/);
    expect((await drv.aiQuery('SELECT count(*) FROM users')).rows).toHaveLength(1);
  });

  it('cancels a running statement', async () => {
    const run = drv.query('SELECT SLEEP(20)');
    await new Promise((r) => setTimeout(r, 200));
    expect(await drv.cancelQuery()).toBe(true);
    const res = await run.catch((e) => e);
    // MySQL reports an interrupted query; MariaDB returns SLEEP's result 1.
    expect(res instanceof Error ? res.message : String(res.rows?.[0]?.[0])).toMatch(/cancel|1/i);
    expect((await drv.query('SELECT 2')).rows).toEqual([[2]]);
  });

  it('enforces and re-asserts read-only', async () => {
    const ro = new MysqlDriver();
    await ro.connect({ ...base(), database: DB, readOnly: true });
    expect((await ro.query('SELECT count(*) FROM users')).rows[0]![0]).toBe(3);
    await expect(ro.query("INSERT INTO nokey VALUES (9, 'z')")).rejects.toThrow(/read.only/i);
    // A statement that flips the session back is undone before the next one.
    await ro.query('SET SESSION TRANSACTION READ WRITE').catch(() => undefined);
    await expect(ro.query("INSERT INTO nokey VALUES (9, 'z')")).rejects.toThrow(/read.only/i);
    await expect(
      ro.commitEditBatch(0, [{ sql: 'DELETE FROM `nokey` WHERE `a` = $1', params: ['1'] }]),
    ).rejects.toThrow();
    await ro.disconnect();
  });
});
