/**
 * Live checks for backup/restore, search and roles against a
 * real Postgres. Opt-in:
 *   PLASMA_LIVE_PG=postgres://postgres:postgres@127.0.0.1:5432/postgres pnpm vitest run src/main/pg-admin.live.test.ts
 * Creates scratch databases (and roles) with random names and drops them afterwards.
 * The pg_dump / pg_restore part is skipped when the client tools are not installed.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AdminJobEvent,
  type PgEndpoint,
  buildPgDumpInvocation,
  buildPgRestoreInvocation,
} from '@shared/pg-backup';
import {
  DEFAULT_ROLE_ATTRS,
  LIST_ROLES_SQL,
  ROLE_PRIVILEGES_SQL,
  alterRoleStatements,
  createRoleStatements,
  diffPrivileges,
  dropRoleStatements,
  parsePrivilegeRows,
  parseRoleRows,
  privKey,
  privilegeStatements,
} from '@shared/pg-roles';
import { buildTableSearch } from '@shared/pg-search';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectTools, startJob } from './pg-admin';

const url = process.env.PLASMA_LIVE_PG;
const suffix = randomBytes(4).toString('hex');
const DB = `plasma_admin_${suffix}`;
const DB2 = `plasma_admin_${suffix}_r`;
const ROLE = `plasma_role_${suffix}`;
const GROUP = `plasma_group_${suffix}`;

function withDb(base: string, db: string): string {
  const u = new URL(base);
  u.pathname = `/${db}`;
  return u.toString();
}

describe.skipIf(!url)('admin features (live)', () => {
  const root = new pg.Client({ connectionString: url });
  let db: pg.Client;
  let dir = '';

  beforeAll(async () => {
    await root.connect();
    await root.query(`CREATE DATABASE ${DB}`);
    await root.query(`CREATE DATABASE ${DB2}`);
    db = new pg.Client({ connectionString: withDb(url as string, DB) });
    await db.connect();
    await db.query(`
      CREATE TABLE users (id serial PRIMARY KEY, email text NOT NULL, age int);
      CREATE TABLE "Or""ders" (id int PRIMARY KEY, user_id int REFERENCES users(id), note text);
      INSERT INTO users (email, age) VALUES ('ann@example.com', 41), ('bob@example.com', 7), ('50%_off', 99);
      INSERT INTO "Or""ders" VALUES (1, 1, 'first order'), (2, 2, 'ann was here');
      CREATE TABLE lonely (id int);
    `);
    dir = await mkdtemp(join(tmpdir(), 'plasma-admin-'));
  });

  afterAll(async () => {
    await db?.end().catch(() => undefined);
    await root.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await root.query(`DROP DATABASE IF EXISTS ${DB2} WITH (FORCE)`);
    await root.query(`DROP ROLE IF EXISTS ${ROLE}`).catch(() => undefined);
    await root.query(`DROP ROLE IF EXISTS ${GROUP}`).catch(() => undefined);
    await root.end();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const readOnly = async (sql: string, params: string[]) => {
    await db.query('BEGIN READ ONLY');
    try {
      await db.query('SET LOCAL statement_timeout = 5000');
      return await db.query({ text: sql, values: params, rowMode: 'array' });
    } finally {
      await db.query('ROLLBACK');
    }
  };

  describe('search', () => {
    const cols = (t: string, list: [string, string][]) =>
      list.map(([name, dataType]) => ({ name, dataType, t }));

    it('finds text, numbers and regex matches; literals never execute', async () => {
      const users = cols('users', [
        ['id', 'integer'],
        ['email', 'text'],
        ['age', 'integer'],
      ]);
      const contains = buildTableSearch('public', 'users', users, { term: 'ann', op: 'contains' });
      expect((await readOnly(contains?.sql ?? '', contains?.params ?? [])).rowCount).toBe(1);

      const num = buildTableSearch('public', 'users', users, { term: '99', op: 'equals' });
      expect((await readOnly(num?.sql ?? '', num?.params ?? [])).rowCount).toBe(1);

      const wildcard = buildTableSearch('public', 'users', users, {
        term: '50%_',
        op: 'startsWith',
      });
      expect((await readOnly(wildcard?.sql ?? '', wildcard?.params ?? [])).rowCount).toBe(1);

      const re = buildTableSearch('public', 'users', users, { term: '^bob@', op: 'regex' });
      expect((await readOnly(re?.sql ?? '', re?.params ?? [])).rowCount).toBe(1);

      const evil = buildTableSearch('public', 'users', users, {
        term: `'; DROP TABLE users; --`,
        op: 'contains',
      });
      expect((await readOnly(evil?.sql ?? '', evil?.params ?? [])).rowCount).toBe(0);
      expect((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(3);
    });

    it('handles hostile identifiers and the per-table LIMIT', async () => {
      const q = buildTableSearch('public', 'Or"ders', [{ name: 'note', dataType: 'text' }], {
        term: 'o',
        op: 'contains',
        limit: 1,
      });
      expect((await readOnly(q?.sql ?? '', q?.params ?? [])).rowCount).toBe(1);
    });

    it('a numeric equals term mixed with text columns runs (separate param types)', async () => {
      const q = buildTableSearch(
        'public',
        'users',
        cols('users', [
          ['id', 'integer'],
          ['email', 'text'],
        ]),
        {
          term: '2',
          op: 'equals',
        },
      );
      expect((await readOnly(q?.sql ?? '', q?.params ?? [])).rowCount).toBe(1);
    });
  });

  describe('roles and privileges', () => {
    const run = async (stmts: { sql: string }[]) => {
      for (const s of stmts) await root.query(s.sql);
    };
    const list = async () => {
      const r = await root.query({ text: LIST_ROLES_SQL, rowMode: 'array' });
      return parseRoleRows(
        r.fields.map((f) => ({ name: f.name })),
        r.rows,
      );
    };

    it('creates, alters, grants membership and drops a role', async () => {
      await run(
        createRoleStatements({ name: GROUP, attrs: { ...DEFAULT_ROLE_ATTRS }, memberOf: [] }),
      );
      await run(
        createRoleStatements({
          name: ROLE,
          attrs: {
            ...DEFAULT_ROLE_ATTRS,
            login: true,
            connLimit: 3,
            validUntil: '2099-01-01 00:00:00+00',
          },
          memberOf: [GROUP],
          password: `pa'ss\\word`,
        }),
      );
      let rows = await list();
      const created = rows.find((r) => r.name === ROLE);
      expect(created?.attrs).toMatchObject({ login: true, connLimit: 3 });
      expect(created?.attrs.validUntil).toContain('2099');
      expect(created?.memberOf).toEqual([GROUP]);
      expect(rows.find((r) => r.name === GROUP)?.members).toEqual([ROLE]);

      const prev = { name: ROLE, attrs: created?.attrs ?? DEFAULT_ROLE_ATTRS, memberOf: [GROUP] };
      await run(
        alterRoleStatements(prev, {
          ...prev,
          attrs: { ...prev.attrs, createdb: true, connLimit: -1 },
          memberOf: [],
        }),
      );
      rows = await list();
      expect(rows.find((r) => r.name === ROLE)).toMatchObject({ memberOf: [] });
      expect(rows.find((r) => r.name === ROLE)?.attrs).toMatchObject({
        createdb: true,
        connLimit: -1,
      });
    });

    it('stages table privileges as a diff and applies them', async () => {
      const grantRole = async (sql: string) => db.query(sql);
      const load = async () => {
        const r = await db.query({
          text: ROLE_PRIVILEGES_SQL,
          values: [ROLE, 'public', ''],
          rowMode: 'array',
        });
        return parsePrivilegeRows(r.rows);
      };
      let rows = await load();
      expect(rows.find((r) => r.table === 'users')?.privileges).toEqual([]);

      const staged = new Map([
        [privKey('public', 'users'), new Set(['SELECT', 'UPDATE'] as const)],
      ]);
      for (const s of privilegeStatements(ROLE, diffPrivileges(rows, staged as never)))
        await grantRole(s.sql);
      rows = await load();
      expect(rows.find((r) => r.table === 'users')?.privileges.sort()).toEqual([
        'SELECT',
        'UPDATE',
      ]);

      const revoke = new Map([[privKey('public', 'users'), new Set(['SELECT'] as const)]]);
      for (const s of privilegeStatements(ROLE, diffPrivileges(rows, revoke as never)))
        await grantRole(s.sql);
      rows = await load();
      expect(rows.find((r) => r.table === 'users')?.privileges).toEqual(['SELECT']);
      // Revoke everything so the role can be dropped.
      await db.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${ROLE}`);
      await run(dropRoleStatements(ROLE));
      await run(dropRoleStatements(GROUP));
      expect((await list()).some((r) => r.name === ROLE || r.name === GROUP)).toBe(false);
    });
  });

  describe('pg_dump / pg_restore', () => {
    it('round-trips a custom-format backup', async (ctx) => {
      const tools = await detectTools('');
      if (tools.some((t) => !t.path)) return ctx.skip();
      const u = new URL(url as string);
      const ep: PgEndpoint = {
        host: u.hostname,
        port: Number(u.port || 5432),
        user: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
        ssl: false,
      };
      const wait = (job: Promise<string>, events: AdminJobEvent[]) =>
        job.then(
          (id) =>
            new Promise<Extract<AdminJobEvent, { type: 'done' }>>((resolve) => {
              const poll = setInterval(() => {
                const done = events.find((e) => e.jobId === id && e.type === 'done');
                if (done && done.type === 'done') {
                  clearInterval(poll);
                  resolve(done);
                }
              }, 25);
            }),
        );

      const out = join(dir, 'a.dump');
      const events: AdminJobEvent[] = [];
      const dump = buildPgDumpInvocation(
        {
          database: DB,
          format: 'custom',
          scope: 'all',
          noOwner: true,
          noPrivileges: true,
          gzip: false,
          schemas: [],
          tables: [],
          outputPath: out,
        },
        ep,
      );
      const dumped = await wait(
        startJob({ invocation: dump, binDir: '', emit: (e) => events.push(e), outputPath: out }),
        events,
      );
      expect(dumped.ok).toBe(true);
      expect((await stat(out)).size).toBeGreaterThan(0);

      const restore = buildPgRestoreInvocation(
        {
          filePath: out,
          database: DB2,
          kind: 'archive',
          clean: false,
          ifExists: false,
          noOwner: true,
          noPrivileges: true,
          singleTransaction: true,
        },
        ep,
      );
      const restored = await wait(
        startJob({ invocation: restore, binDir: '', emit: (e) => events.push(e) }),
        events,
      );
      expect(restored.ok).toBe(true);
      const copy = new pg.Client({ connectionString: withDb(url as string, DB2) });
      await copy.connect();
      try {
        expect((await copy.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(3);
      } finally {
        await copy.end();
      }
    });
  });
});
