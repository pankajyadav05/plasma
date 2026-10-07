import { isConnectionLostError } from '@shared/connection-loss';
import type { QueryResult, SchemaInfo } from '@shared/protocol';
import { MAX_RESULT_ROWS } from '@shared/result-bounds';
import { dialectFor, engineCaps } from '@shared/sql-dialect';
import { splitSqlStatements } from '@shared/sql-statements';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type BuiltSql,
  buildDeleteSql,
  buildInsertSql,
  buildUpdateSql,
} from '../../../renderer/lib/table-query';
import type { SqlEngineDriver } from '../sql-engine';
import { optOutReason } from './capabilities';
import type { EngineEnv, SqlFixture } from './fixture';
import { scenarioFor } from './scenario';
import { EDIT_TABLES_CHILD_FIRST, seedStatements } from './seed';

/**
 * The scenarios every SQL engine runs. They go through `SqlEngineDriver`
 * only, the same surface the worker dispatches to, and use the app's own
 * SQL builders for row edits. An engine skips a scenario only through a
 * capability flag in its fixture; the skip is reported with the reason.
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The error a promise rejects with (fails the test when it resolves). */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    return err as Error;
  }
  throw new Error('expected the call to be rejected, but it resolved');
}

/**
 * The editor's script pipeline, minus the tab: split with the shared tokenizer, run statement
 * by statement, stop at the first failure (see renderer/lib/run-statements.ts).
 */
async function runScript(
  script: string,
  run: (sql: string) => Promise<QueryResult>,
): Promise<{ results: QueryResult[]; error?: { message: string; statementIndex: number } }> {
  const results: QueryResult[] = [];
  const statements = splitSqlStatements(script);
  for (let i = 0; i < statements.length; i++) {
    try {
      results.push(await run(statements[i] as string));
    } catch (err) {
      return {
        results,
        error: { message: err instanceof Error ? err.message : String(err), statementIndex: i },
      };
    }
  }
  return { results };
}

const first = (r: QueryResult): unknown => r.rows[0]?.[0];

/** Count rows of `table` through the separate admin session (what other clients see). */
async function countOf(env: EngineEnv, table: string): Promise<number> {
  return Number(first(await env.admin(`SELECT count(*) AS c FROM ${table}`)));
}

/**
 * Count rows where the data really is: through the separate admin session when every session
 * shares the data, else through the session that ran the statements under test.
 */
async function truthCount(
  env: EngineEnv,
  session: SqlEngineDriver,
  table: string,
): Promise<number> {
  if (env.shared) return countOf(env, table);
  return Number(first(await session.query(`SELECT count(*) AS c FROM ${table}`)));
}

/** Tables the probes try to create; none of them may exist afterwards. */
const PROBE_TABLES = ['ro_probe', 'ai_probe'];

async function leakedProbeTables(env: EngineEnv, session: SqlEngineDriver): Promise<string[]> {
  const info = await session.introspect({ objects: true, columns: false });
  return info.tables
    .filter((t) => t.schema === env.schema && PROBE_TABLES.includes(t.name))
    .map((t) => t.name);
}

/** Rows of `sql` as a plain array, through the admin session. */
async function rowsOf(env: EngineEnv, sql: string): Promise<unknown[][]> {
  return (await env.admin(sql)).rows;
}

function pairs(info: SchemaInfo, schema: string, table: string) {
  return info.columns.filter((c) => c.schema === schema && c.table === table);
}

export interface SqlSuiteOpts {
  /** False when the engine's server is not reachable (env unset): the suite is skipped. */
  enabled: boolean;
}

export function registerSqlConformance(fx: SqlFixture, opts: SqlSuiteOpts): void {
  const suite = opts.enabled ? describe : describe.skip;
  suite(`conformance: ${fx.id}`, () => {
    let env: EngineEnv;
    let drv: SqlEngineDriver;
    const sessions: SqlEngineDriver[] = [];

    const scenario = scenarioFor(fx.caps);

    const tableOf = (name: string, valueType: string) =>
      fx.tableOf?.(name, valueType) ?? `CREATE TABLE ${name} (id INTEGER NOT NULL, v ${valueType})`;

    async function open(o?: Parameters<EngineEnv['open']>[0]) {
      const d = await env.open(o);
      sessions.push(d);
      return d;
    }

    /** Put the writable tables back to their seeded content (children first). */
    async function resetEditTables() {
      for (const t of EDIT_TABLES_CHILD_FIRST) await env.admin(`DELETE FROM ${t}`);
      for (const sql of seedStatements('edit_')) await env.admin(sql);
    }

    beforeAll(async () => {
      env = await fx.setup();
      if (env.shared) {
        for (const sql of [...fx.ddl(''), ...fx.ddl('edit_'), ...fx.extraDdl]) await env.admin(sql);
        for (const sql of [...seedStatements(''), ...seedStatements('edit_')]) await env.admin(sql);
      }
      drv = await open();
    }, 120_000);

    afterAll(async () => {
      await Promise.allSettled(sessions.map((s) => s.disconnect()));
      await env?.teardown();
    }, 60_000);

    // ── connect / version / disconnect / reconnect ───────────────────────

    describe('connect', () => {
      scenario('connect resolves with the server version', null, async () => {
        const d = env.create();
        sessions.push(d);
        const version = await d.connect(env.config(), 0);
        expect(version).toMatch(fx.versionPattern);
        await d.disconnect();
      });

      scenario('a connected session answers a trivial query', null, async () => {
        const r = await drv.query('SELECT 1 AS one');
        expect(r.columns.map((c) => c.name)).toEqual(['one']);
        expect(Number(first(r))).toBe(1);
        expect(r.rowCount).toBe(1);
        expect(r.command).toBe('SELECT');
        expect(r.durationMs).toBeGreaterThanOrEqual(0);
      });

      scenario(
        'disconnect is idempotent and a disconnected driver refuses to query',
        null,
        async () => {
          const d = await open();
          await d.disconnect();
          await d.disconnect();
          await rejection(d.query('SELECT 1'));
        },
      );

      scenario('the same driver connects again after disconnect', 'reconnect', async () => {
        const d = await open();
        await d.disconnect();
        const version = await d.connect(env.config(), 0);
        d.setConnectionGen(1);
        expect(version).toMatch(fx.versionPattern);
        expect(Number(first(await d.query('SELECT 2')))).toBe(2);
      });

      scenario('connect() on a live driver replaces its session', 'reconnect', async () => {
        const d = await open();
        const version = await d.connect(env.config(), 0);
        d.setConnectionGen(1);
        expect(version).toMatch(fx.versionPattern);
        expect(Number(first(await d.query('SELECT 3')))).toBe(3);
      });

      scenario('a wrong password is refused and never echoed', 'badCredentials', async () => {
        const wrong = 'definitely-not-the-password-9f3a';
        const d = env.create();
        sessions.push(d);
        const err = await rejection(d.connect(env.config({ password: wrong }), 0));
        expect(err.message).not.toContain(wrong);
        expect(isConnectionLostError(err)).toBe(false);
      });
    });

    // ── introspection ────────────────────────────────────────────────────

    describe('introspection', () => {
      let info: SchemaInfo;
      beforeAll(async () => {
        info = await drv.introspect();
      });

      scenario('lists the schema, the tables and the view', null, async () => {
        expect(info.schemas.map((s) => s.name)).toContain(env.schema);
        const mine = info.tables.filter((t) => t.schema === env.schema);
        const kinds = Object.fromEntries(mine.map((t) => [t.name, t.kind]));
        expect(kinds.users).toBe('table');
        expect(kinds.posts).toBe('table');
        expect(kinds.pair).toBe('table');
        expect(kinds.nokey).toBe('table');
        expect(kinds.adults).toBe('view');
      });

      scenario('columns come with order, type, nullability and defaults', null, async () => {
        const cols = pairs(info, env.schema, 'users');
        expect(cols.map((c) => c.name)).toEqual(['id', 'name', 'age', 'bio']);
        const ordinals = cols.map((c) => c.ordinal);
        expect([...ordinals].sort((a, b) => a - b)).toEqual(ordinals);
        expect(new Set(ordinals).size).toBe(cols.length);
        const by = Object.fromEntries(cols.map((c) => [c.name, c]));
        expect(by.name?.isNullable).toBe(false);
        expect(by.bio?.isNullable).toBe(true);
        expect(by.age?.hasDefault).toBe(true);
        expect(by.name?.hasDefault).toBe(false);
        for (const c of cols) expect(c.dataType).not.toBe('');
      });

      scenario('primary keys, single and composite', 'primaryKeys', async () => {
        const pk = (t: string) =>
          pairs(info, env.schema, t)
            .filter((c) => c.isPrimaryKey)
            .map((c) => c.name);
        expect(pk('users')).toEqual(['id']);
        expect(pk('pair')).toEqual(['a', 'b']);
        expect(pk('nokey')).toEqual([]);
      });

      scenario('foreign keys', 'foreignKeys', async () => {
        const fks = info.foreignKeys.filter((f) => f.schema === env.schema && f.table === 'posts');
        expect(fks).toHaveLength(1);
        expect(fks[0]).toMatchObject({
          column: 'user_id',
          refTable: 'users',
          refColumn: 'id',
        });
        expect(fks[0]?.refSchema).toBe(env.schema);
      });

      scenario('a narrower request returns fewer columns, not an error', null, async () => {
        const slim = await drv.introspect({ objects: true, columns: false });
        expect(slim.tables.some((t) => t.name === 'users')).toBe(true);
        expect(slim.columns).toEqual([]);
      });
    });

    // ── type round trip ──────────────────────────────────────────────────

    describe('types', () => {
      fx.typeCases.forEach((tc, i) => {
        const table = `ty_${i}`;
        const title = `${tc.name}: literal and bound value round-trip`;
        scenario(title, tc.needs ?? null, async () => {
          await drv.query(tableOf(table, tc.sqlType));
          try {
            await drv.query(`INSERT INTO ${table} (id, v) VALUES (1, ${tc.literal})`);
            const lit = await drv.query(`SELECT v FROM ${table} WHERE id = 1`);
            tc.expect(first(lit));
            if (tc.typeName) expect(lit.columns[0]?.dataTypeName).toMatch(tc.typeName);
            if (tc.param !== undefined) {
              await drv.query(`INSERT INTO ${table} (id, v) VALUES (2, $1)`, [tc.param]);
              const bound = await drv.query(`SELECT v FROM ${table} WHERE id = 2`);
              tc.expect(first(bound));
            }
          } finally {
            await drv.query(`DROP TABLE ${table}`).catch(() => undefined);
          }
        });
      });

      scenario('empty string and NULL stay different', null, async () => {
        await drv.query(tableOf('ty_empty', fx.textType));
        try {
          await drv.query(`INSERT INTO ty_empty (id, v) VALUES (1, '')`);
          await drv.query('INSERT INTO ty_empty (id, v) VALUES (2, NULL)');
          await drv.query('INSERT INTO ty_empty (id, v) VALUES (3, $1)', ['']);
          await drv.query('INSERT INTO ty_empty (id, v) VALUES (4, $1)', [null]);
          const r = await drv.query('SELECT id, v FROM ty_empty ORDER BY id');
          expect(r.rows).toEqual([
            [1, ''],
            [2, null],
            [3, ''],
            [4, null],
          ]);
        } finally {
          await drv.query('DROP TABLE ty_empty').catch(() => undefined);
        }
      });

      scenario('unicode, emoji and quotes survive text and bound values', null, async () => {
        const text = `héllo 日本語 🎉 é "double" 'single' back\\slash`;
        await drv.query(tableOf('ty_text', fx.textType));
        try {
          await drv.query('INSERT INTO ty_text (id, v) VALUES (1, $1)', [text]);
          const r = await drv.query('SELECT v, length(v) AS n FROM ty_text WHERE id = $1', [1]);
          expect(first(r)).toBe(text);
        } finally {
          await drv.query('DROP TABLE ty_text').catch(() => undefined);
        }
      });
    });

    // ── statements, scripts, errors ──────────────────────────────────────

    describe('statements and errors', () => {
      scenario('DML reports the command and the affected rows', null, async () => {
        await drv.query(tableOf('st_dml', 'INTEGER'));
        try {
          const ins = await drv.query('INSERT INTO st_dml (id, v) VALUES (1, 1), (2, 2)');
          expect(ins.command).toBe('INSERT');
          expect(ins.rowCount).toBe(2);
          expect(ins.rows).toEqual([]);
        } finally {
          await drv.query('DROP TABLE st_dml').catch(() => undefined);
        }
      });

      scenario(
        'a script runs statement by statement and the last one answers',
        'multiStatement',
        async () => {
          const out = await runScript('SELECT 1 AS a; SELECT 1 AS a, 2 AS b;', (sql) =>
            drv.query(sql),
          );
          expect(out.error).toBeUndefined();
          expect(out.results).toHaveLength(2);
          expect(out.results[1]?.columns.map((c) => c.name)).toEqual(['a', 'b']);
          expect(out.results[1]?.rows.map((r) => r.map(Number))).toEqual([[1, 2]]);
        },
      );

      scenario(
        'a semicolon inside a string is not a statement boundary',
        'multiStatement',
        async () => {
          const out = await runScript(`SELECT 'a;b' AS s; SELECT 2 AS two`, (sql) =>
            drv.query(sql),
          );
          expect(out.error).toBeUndefined();
          expect(first(out.results[0]!)).toBe('a;b');
        },
      );

      scenario(
        'a failing statement stops the script and names the statement',
        'multiStatement',
        async () => {
          const out = await runScript(`SELECT 1; ${fx.runtimeErrorSql}; SELECT 3`, (sql) =>
            drv.query(sql),
          );
          expect(out.results).toHaveLength(1);
          expect(out.error?.statementIndex).toBe(1);
          expect(out.error?.message).not.toBe('');
        },
      );

      scenario('a syntax error is reported with the server message', null, async () => {
        const err = await rejection(drv.query(fx.syntaxErrorSql));
        expect(err.message).toMatch(fx.syntaxErrorPattern);
        fx.syntaxErrorExtra?.(err);
        // A bad statement is not a dead connection: nothing may reconnect or retry.
        expect(isConnectionLostError(err)).toBe(false);
        expect(Number(first(await drv.query('SELECT 1')))).toBe(1);
      });

      scenario('a runtime error keeps the connection usable', 'errorKeepsSession', async () => {
        const err = await rejection(drv.query(fx.runtimeErrorSql));
        expect(err.message).not.toBe('');
        expect(isConnectionLostError(err)).toBe(false);
        expect(Number(first(await drv.query('SELECT 2')))).toBe(2);
      });

      scenario(
        'a unique-key violation is an error and writes nothing',
        ['constraints', 'errorKeepsSession'],
        async () => {
          const before = await truthCount(env, drv, 'users');
          const err = await rejection(drv.query(`INSERT INTO users (id, name) VALUES (1, 'dup')`));
          expect(isConnectionLostError(err)).toBe(false);
          expect(await truthCount(env, drv, 'users')).toBe(before);
        },
      );

      scenario(
        'a failed statement in a transaction can be rolled back',
        'transactions',
        async () => {
          const d = await open();
          expect(await d.beginTransaction()).toBe('active');
          await rejection(d.query(fx.runtimeErrorSql));
          const state = await d.rollbackTransaction();
          expect(state).toBe('none');
          expect(Number(first(await d.query('SELECT 1')))).toBe(1);
        },
      );
    });

    // ── transactions ─────────────────────────────────────────────────────

    describe('transactions', () => {
      beforeEach(async () => {
        if (fx.caps.transactions === true) await resetEditTables();
      }, 30_000);

      scenario(
        'begin, write, rollback leaves nothing; commit keeps it',
        'transactions',
        async () => {
          const d = await open();
          expect(await d.beginTransaction()).toBe('active');
          const r = await d.query(`INSERT INTO edit_pair (a, b, v) VALUES (9, 9, 'rolled')`);
          expect(r.txnState).toBe('active');
          expect(await countOf(env, 'edit_pair')).toBe(2);
          expect(await d.rollbackTransaction()).toBe('none');
          expect(await countOf(env, 'edit_pair')).toBe(2);

          await d.beginTransaction();
          await d.query(`INSERT INTO edit_pair (a, b, v) VALUES (9, 9, 'kept')`);
          expect(await d.commitTransaction()).toBe('none');
          expect(await countOf(env, 'edit_pair')).toBe(3);
        },
      );

      scenario(
        'autoBegin opens a transaction for the first statement',
        'transactions',
        async () => {
          const d = await open();
          const r = await d.query(
            `INSERT INTO edit_pair (a, b, v) VALUES (8, 8, 'auto')`,
            undefined,
            {
              autoBegin: true,
            },
          );
          expect(r.txnState).toBe('active');
          expect(await countOf(env, 'edit_pair')).toBe(2);
          await d.rollbackTransaction();
          expect(await countOf(env, 'edit_pair')).toBe(2);
        },
      );
    });

    // ── a transaction the user typed ─────────────────────────────────────

    describe('user transactions', () => {
      scenario(
        'lookups and AI reads leave a BEGIN the user typed alone, and its COMMIT keeps everything',
        'userTransactions',
        async () => {
          const d = await open();
          await d.query(tableOf('tx_probe', 'INTEGER'));
          try {
            await d.query('BEGIN');
            await d.query('INSERT INTO tx_probe (id, v) VALUES (1, 1)');
            // What opening a table does, and an agent read, while the transaction is open.
            const opts = { timeoutMs: 5000 };
            await d.sidebandQuery('SELECT 1', undefined, opts);
            await d.aiQuery('SELECT 2');
            await d.introspect({ objects: true, columns: false });
            await d.query('INSERT INTO tx_probe (id, v) VALUES (2, 2)');
            await d.query('COMMIT');
            expect(await truthCount(env, d, 'tx_probe')).toBe(2);
          } finally {
            await d.query('ROLLBACK').catch(() => undefined);
            await d.query('DROP TABLE tx_probe').catch(() => undefined);
          }
        },
      );
    });

    // ── cancellation ─────────────────────────────────────────────────────

    describe('cancellation', () => {
      scenario('cancelQuery with nothing running reports false', 'cancel', async () => {
        const d = await open();
        expect(await d.cancelQuery()).toBe(false);
        expect(Number(first(await d.query('SELECT 1')))).toBe(1);
      });

      scenario(
        'a long statement is cancelled within 2 s and the session survives',
        'cancel',
        async () => {
          const d = await open();
          const slow = d.query(fx.sleepSql);
          const settled = slow.then(
            () => null,
            (e: Error) => e,
          );
          await sleep(400);
          const asked = Date.now();
          expect(await d.cancelQuery()).toBe(true);
          const err = await settled;
          expect(Date.now() - asked).toBeLessThan(2000);
          expect(err).toBeInstanceOf(Error);
          expect(err?.message).toMatch(/cancel/i);
          expect(isConnectionLostError(err)).toBe(false);
          expect(Number(first(await d.query('SELECT 7')))).toBe(7);
        },
      );

      scenario('the statement timeout stops a slow statement', 'statementTimeout', async () => {
        const d = await open({ statementTimeoutMs: 500 });
        const started = Date.now();
        const err = await rejection(d.query(fx.sleepSql));
        expect(Date.now() - started).toBeLessThan(5000);
        expect(err.message).toMatch(/timeout|timed out|cancel/i);
        expect(Number(first(await d.query('SELECT 8')))).toBe(8);
      });
    });

    // ── read-only ────────────────────────────────────────────────────────

    describe('read-only', () => {
      scenario(
        'a read-only connection reads and refuses every write and DDL',
        'readOnlyConnection',
        async () => {
          const ro = await open({ readOnly: true });
          expect(Number(first(await ro.query('SELECT count(*) FROM users')))).toBe(3);
          const before = await truthCount(env, ro, 'users');
          for (const sql of fx.writeProbes) {
            const err = await rejection(ro.query(sql));
            expect(err.message, sql).not.toBe('');
          }
          expect(await truthCount(env, ro, 'users')).toBe(before);
          expect(await leakedProbeTables(env, ro)).toEqual([]);
          expect(Number(first(await ro.query('SELECT 1')))).toBe(1);
        },
      );

      scenario(
        'a read-only connection cannot be flipped back to read-write',
        'readOnlyBypass',
        async () => {
          for (const calls of fx.bypassProbes) {
            const ro = await open({ readOnly: true });
            const before = await truthCount(env, ro, 'users');
            for (const sql of calls) {
              try {
                await ro.query(sql);
              } catch {
                // refusing is the point; keep going so a later call is tried too
              }
            }
            expect(await truthCount(env, ro, 'users'), calls.join(' ; ')).toBe(before);
            await ro.disconnect();
          }
        },
      );

      scenario('aiQuery runs a read', 'aiQuery', async () => {
        const r = await drv.aiQuery(fx.aiReadSql);
        expect(r.rows.length).toBeGreaterThan(0);
      });

      scenario('aiQuery refuses scripts of several statements', 'aiQuery', async () => {
        await rejection(drv.aiQuery('SELECT 1; SELECT 2'));
      });

      scenario(
        'aiQuery refuses writes, also hidden in a CTE, function or procedure',
        'aiQuery',
        async () => {
          const before = await truthCount(env, drv, 'users');
          const logBefore = await truthCount(env, drv, 'write_log');
          for (const sql of fx.aiWriteProbes) {
            // Resolving is only acceptable when nothing was written: checked below.
            await drv.aiQuery(sql).catch(() => undefined);
            expect(await truthCount(env, drv, 'users'), sql).toBe(before);
            expect(await truthCount(env, drv, 'write_log'), sql).toBe(logBefore);
          }
          expect(await leakedProbeTables(env, drv)).toEqual([]);
          expect(await fx.probeSideEffects?.(env, drv)).toBeUndefined();
          // The probes must not have damaged the session either.
          expect((await drv.aiQuery(fx.aiReadSql)).rows.length).toBeGreaterThan(0);
          // And a plain write is a hard error, not a silent no-op.
          await rejection(drv.aiQuery(`INSERT INTO users (id, name) VALUES (99, 'ai')`));
          expect(await truthCount(env, drv, 'users')).toBe(before);
        },
      );

      // Postgres runs un-timed sideband statements as management writes (roles, health fixes);
      // with a timeout - the form every lookup uses - every engine is read-only.
      scenario('sidebandQuery with a timeout reads and refuses a write', 'aiQuery', async () => {
        const before = await truthCount(env, drv, 'users');
        const opts = { timeoutMs: 5000 };
        expect(
          Number(first(await drv.sidebandQuery('SELECT count(*) FROM users', undefined, opts))),
        ).toBe(before);
        await rejection(
          drv.sidebandQuery(`INSERT INTO users (id, name) VALUES (98, 'side')`, undefined, opts),
        );
        await rejection(drv.sidebandQuery('DELETE FROM users', undefined, opts));
        expect(await truthCount(env, drv, 'users')).toBe(before);
        expect(Number(first(await drv.sidebandQuery('SELECT 1', undefined, opts)))).toBe(1);
      });
    });

    // ── row editing ──────────────────────────────────────────────────────

    describe('row editing', () => {
      const dialect = dialectFor(fx.engine);
      const batch = (...stmts: BuiltSql[]) =>
        stmts.map((s) => ({ sql: s.sql, params: s.params, label: 'edit' }));
      const upd = (
        set: Record<string, unknown>,
        pk: Record<string, unknown>,
        table = 'edit_users',
      ) => buildUpdateSql({ schema: env.schema, table, set, pkValues: pk, dialect });
      const ins = (values: Record<string, unknown>, table = 'edit_users') =>
        buildInsertSql({ schema: env.schema, table, values, dialect });
      const del = (pk: Record<string, unknown>, table = 'edit_users') =>
        buildDeleteSql({ schema: env.schema, table, pkValues: pk, dialect });
      const userRows = () => rowsOf(env, 'SELECT id, name, age, bio FROM edit_users ORDER BY id');

      beforeEach(async () => {
        if (fx.caps.rowEdit === true) await resetEditTables();
      }, 30_000);

      it('the capabilities match what the app tells the UI', () => {
        expect(engineCaps(fx.engine).rowEdits).toBe(fx.caps.rowEdit === true);
        // A row locator (ctid / rowid) is what makes a key-less table editable.
        if (fx.caps.rowEdit === true) {
          expect(dialect.rowLocator !== null).toBe(fx.caps.keylessEdit === true);
        }
      });

      if (fx.caps.rowEdit !== true) {
        it(`refuses a batch plainly (rowEdit: ${optOutReason(fx.caps.rowEdit)})`, async () => {
          const err = await rejection(drv.commitEditBatch(1, batch(upd({ name: 'x' }, { id: 1 }))));
          expect(err.message).toMatch(/cannot be edited|can't be edited|not supported|read-only/i);
        });
      }

      scenario('update by key touches exactly the one row', 'rowEdit', async () => {
        const before = await userRows();
        const res = await drv.commitEditBatch(
          1,
          batch(upd({ name: 'ada2', age: '37' }, { id: 1 })),
        );
        expect(res.applied).toBe(1);
        const after = await userRows();
        expect(after[0]).toEqual([1, 'ada2', 37, null]);
        expect(after.slice(1)).toEqual(before.slice(1));
      });

      scenario(
        'setting a column to the value it already has still counts as a match',
        'rowEdit',
        async () => {
          const res = await drv.commitEditBatch(1, batch(upd({ name: 'ada' }, { id: 1 })));
          expect(res.applied).toBe(1);
        },
      );

      scenario('NULL in non-key columns, set and cleared', 'rowEdit', async () => {
        await drv.commitEditBatch(1, batch(upd({ bio: 'now set' }, { id: 1 })));
        await drv.commitEditBatch(1, batch(upd({ bio: null }, { id: 3 })));
        const rows = await userRows();
        expect(rows[0]?.[3]).toBe('now set');
        expect(rows[2]?.[3]).toBeNull();
      });

      scenario('insert and delete by key', 'rowEdit', async () => {
        await drv.commitEditBatch(1, batch(ins({ id: 10, name: 'new', age: '5', bio: null })));
        expect(await countOf(env, 'edit_users')).toBe(4);
        expect(
          await rowsOf(env, 'SELECT id, name, age, bio FROM edit_users WHERE id = 10'),
        ).toEqual([[10, 'new', 5, null]]);
        await drv.commitEditBatch(1, batch(del({ id: 10 })));
        expect(await countOf(env, 'edit_users')).toBe(3);
      });

      scenario(
        'a composite key addresses one row of two that share a part',
        'rowEdit',
        async () => {
          await drv.commitEditBatch(1, batch(upd({ v: 'changed' }, { a: 1, b: 2 }, 'edit_pair')));
          expect(await rowsOf(env, 'SELECT a, b, v FROM edit_pair ORDER BY a, b')).toEqual([
            [1, 1, 'x'],
            [1, 2, 'changed'],
          ]);
          await drv.commitEditBatch(1, batch(del({ a: 1, b: 1 }, 'edit_pair')));
          expect(await rowsOf(env, 'SELECT a, b FROM edit_pair')).toEqual([[1, 2]]);
        },
      );

      scenario(
        'a batch is all or nothing: the second edit fails, the first is undone',
        'rowEdit',
        async () => {
          const before = await userRows();
          const err = await rejection(
            drv.commitEditBatch(
              1,
              batch(upd({ name: 'changed' }, { id: 1 }), upd({ name: 'ghost' }, { id: 404 })),
            ),
          );
          expect(err.message).toMatch(/Edit 2 of 2/);
          expect(err.message).toMatch(/Nothing was saved/);
          expect(await userRows()).toEqual(before);
        },
      );

      scenario('a database error mid-batch rolls the whole batch back', 'rowEdit', async () => {
        const before = await userRows();
        const err = await rejection(
          drv.commitEditBatch(
            1,
            batch(upd({ name: 'changed' }, { id: 2 }), ins({ id: 1, name: 'duplicate key' })),
          ),
        );
        expect(err.message).toMatch(/Edit 2 of 2/);
        expect(await userRows()).toEqual(before);
      });

      scenario('a key that matches no row is refused', 'rowEdit', async () => {
        const err = await rejection(drv.commitEditBatch(1, batch(del({ id: 404 }))));
        expect(err.message).toMatch(/matched no row/);
      });

      scenario('a statement matching several rows is refused and undone', 'rowEdit', async () => {
        // edit_nokey has two identical rows: addressing them by value is not a key.
        const err = await rejection(
          drv.commitEditBatch(1, [
            { sql: 'UPDATE edit_nokey SET b = $1 WHERE a = $2', params: ['z', 1], label: 'nokey' },
          ]),
        );
        expect(err.message).toMatch(/matched 2 rows/);
        expect(await rowsOf(env, 'SELECT a, b FROM edit_nokey ORDER BY b')).toEqual([
          [1, 'x'],
          [1, 'x'],
        ]);
      });

      scenario(
        'a table without a key is edited through its row locator, one row',
        'keylessEdit',
        async () => {
          const locator = dialect.rowLocator;
          expect(locator).not.toBeNull();
          const col = locator === 'ctid' ? 'ctid::text' : locator;
          const located = await rowsOf(env, `SELECT ${col}, b FROM edit_nokey ORDER BY ${locator}`);
          expect(located).toHaveLength(2);
          const target = located[0]![0];
          const res = await drv.commitEditBatch(1, [
            {
              sql: `UPDATE edit_nokey SET b = $1 WHERE ${locator} = $2`,
              params: ['only-one', target],
              label: 'nokey',
            },
          ]);
          expect(res.applied).toBe(1);
          const after = await rowsOf(env, 'SELECT b FROM edit_nokey ORDER BY b');
          expect(after).toEqual([['only-one'], ['x']]);
        },
      );

      scenario(
        'inside the user transaction the batch is a savepoint and nothing is committed',
        ['rowEdit', 'transactions'],
        async () => {
          const d = await open();
          await d.beginTransaction();
          const res = await d.commitEditBatch(1, batch(upd({ name: 'in-txn' }, { id: 1 })));
          expect(res.state).toBe('active');
          expect(await rowsOf(env, 'SELECT name FROM edit_users WHERE id = 1')).toEqual([['ada']]);
          await d.rollbackTransaction();
          expect(await rowsOf(env, 'SELECT name FROM edit_users WHERE id = 1')).toEqual([['ada']]);
        },
      );

      scenario('a batch for another connection generation is refused', 'rowEdit', async () => {
        const before = await userRows();
        const err = await rejection(
          drv.commitEditBatch(2, batch(upd({ name: 'stale' }, { id: 1 }))),
        );
        expect(err.message).toMatch(/generation/);
        expect(await userRows()).toEqual(before);
      });
    });

    // ── result caps and export ───────────────────────────────────────────

    describe('result caps', () => {
      scenario('a result over the editor limit is cut and flagged', 'resultCap', async () => {
        const r = await drv.query(fx.rowsSql(500), undefined, { maxRows: 100 });
        expect(r.rowCount).toBe(100);
        expect(r.rows).toHaveLength(100);
        expect(r.truncated).toBe(true);
        expect(r.rows[0]?.[0]).toBe(1);
        expect(r.rows[99]?.[0]).toBe(100);
      });

      scenario('a result exactly at the limit is not flagged', 'resultCap', async () => {
        const r = await drv.query(fx.rowsSql(100), undefined, { maxRows: 100 });
        expect(r.rowCount).toBe(100);
        expect(r.truncated).toBeFalsy();
      });

      scenario(
        'the safety cap holds without any limit',
        'resultCap',
        async () => {
          const r = await drv.query(fx.rowsSql(MAX_RESULT_ROWS + 50));
          expect(r.rowCount).toBe(MAX_RESULT_ROWS);
          expect(r.rows).toHaveLength(MAX_RESULT_ROWS);
          expect(r.truncated).toBe(true);
          expect(r.rows[MAX_RESULT_ROWS - 1]?.[0]).toBe(MAX_RESULT_ROWS);
        },
        60_000,
      );

      scenario('the byte cap cuts wide rows and flags the result', 'byteCap', async () => {
        const r = await drv.query(fx.wideRowsSql(200, 1000), undefined, { maxBytes: 50_000 });
        expect(r.truncated).toBe(true);
        expect(r.rowCount).toBeGreaterThan(0);
        expect(r.rowCount).toBeLessThan(200);
        expect(r.rows).toHaveLength(r.rowCount);
      });

      scenario('an empty result keeps its columns', null, async () => {
        const r = await drv.query('SELECT id, name FROM users WHERE id < 0');
        expect(r.rows).toEqual([]);
        expect(r.rowCount).toBe(0);
        expect(r.columns.map((c) => c.name)).toEqual(['id', 'name']);
        expect(r.truncated).toBeFalsy();
      });

      scenario(
        'export streams past the display cap',
        'exportStream',
        async () => {
          const total = MAX_RESULT_ROWS + 2500;
          let rows = 0;
          let lastValue: unknown;
          let batches = 0;
          let columns = '';
          for await (const b of drv.streamQueryForExport(fx.rowsSql(total))) {
            batches++;
            if (!columns) columns = b.columns.map((c) => c.name).join(',');
            rows += b.rows.length;
            lastValue = b.rows[b.rows.length - 1]?.[0] ?? lastValue;
          }
          expect(rows).toBe(total);
          expect(lastValue).toBe(total);
          expect(columns).toBe('n');
          expect(batches).toBeGreaterThan(1);
        },
        60_000,
      );

      scenario('exporting an empty result still yields the header', 'exportStream', async () => {
        const seen: string[] = [];
        let rows = 0;
        for await (const b of drv.streamQueryForExport('SELECT id, name FROM users WHERE id < 0')) {
          rows += b.rows.length;
          seen.push(b.columns.map((c) => c.name).join(','));
        }
        expect(rows).toBe(0);
        expect(seen[0]).toBe('id,name');
      });
    });

    // ── connection loss ──────────────────────────────────────────────────

    describe('connection loss', () => {
      scenario(
        'an idle session that loses its server reports it, and reconnect works',
        'connectionLoss',
        async () => {
          const d = await open({ viaProxy: true });
          expect(Number(first(await d.query('SELECT 1')))).toBe(1);
          await env.proxy!.kill();
          await sleep(300);
          const err = await rejection(d.query('SELECT 1'));
          expect(isConnectionLostError(err), err.message).toBe(true);
          // Still reported as lost, not hanging, on the next call.
          const again = await rejection(d.query('SELECT 1'));
          expect(isConnectionLostError(again), again.message).toBe(true);
          await env.proxy!.restart();
          const version = await d.connect(env.config({ viaProxy: true }), 0);
          d.setConnectionGen(1);
          expect(version).toMatch(fx.versionPattern);
          expect(Number(first(await d.query('SELECT 5')))).toBe(5);
        },
        40_000,
      );

      scenario(
        'losing the server mid-query rejects with a connection-lost error',
        'connectionLoss',
        async () => {
          const d = await open({ viaProxy: true });
          const running = d.query(fx.sleepSql);
          const settled = running.then(
            () => null,
            (e: Error) => e,
          );
          await sleep(500);
          const killedAt = Date.now();
          await env.proxy!.kill();
          const err = await settled;
          expect(Date.now() - killedAt).toBeLessThan(15_000);
          expect(err).toBeInstanceOf(Error);
          expect(isConnectionLostError(err), err?.message).toBe(true);
          await env.proxy!.restart();
          await d.connect(env.config({ viaProxy: true }), 0);
          d.setConnectionGen(1);
          expect(Number(first(await d.query('SELECT 6')))).toBe(6);
          await fx.cleanupAfterLoss?.(env);
        },
        60_000,
      );

      scenario(
        'a transaction open when the server vanishes is reported as lost',
        ['connectionLoss', 'transactions'],
        async () => {
          const d = await open({ viaProxy: true });
          await d.beginTransaction();
          await d.query('SELECT 1');
          await env.proxy!.kill();
          await sleep(300);
          await rejection(d.query('SELECT 1'));
          expect(d.lostDuringTransaction()).toBe(true);
          await env.proxy!.restart();
          await d.connect(env.config({ viaProxy: true }), 0);
        },
        40_000,
      );
    });
  });
}
