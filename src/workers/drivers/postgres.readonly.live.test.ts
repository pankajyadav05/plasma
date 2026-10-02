import type { ConnectionConfig } from '@shared/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresDriver } from './postgres';

/**
 * SC-02 opt-in live checks: a read-only connection stays read-only after
 * RESET ALL / DISCARD ALL / set_config / DO, including escapes the text
 * screen cannot see (a function that flips the setting at run time).
 *
 *   PLASMA_LIVE_PG=postgres://postgres@127.0.0.1:5501/postgres pnpm vitest run \
 *     src/workers/drivers/postgres.readonly.live.test.ts
 */
const url = process.env.PLASMA_LIVE_PG;
const suite = url ? describe : describe.skip;

function configFrom(raw: string, readOnly: boolean): ConnectionConfig {
  const u = new URL(raw);
  return {
    id: 'live-ro',
    name: 'live-ro',
    engine: 'postgres',
    host: u.hostname,
    port: Number(u.port || 5432),
    database: u.pathname.slice(1) || 'postgres',
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    ssl: false,
    readOnly,
  } as ConnectionConfig;
}

suite('postgres driver (live): read-only survives session resets (SC-02)', () => {
  const writer = new PostgresDriver();
  const ro = new PostgresDriver();

  const countRows = async () =>
    Number((await writer.query('SELECT count(*) FROM plasma_ro_t')).rows[0]?.[0]);
  const writeFails = async () => {
    await expect(ro.query('INSERT INTO plasma_ro_t VALUES (1)')).rejects.toThrow(/read-only/i);
    expect(await countRows()).toBe(0);
  };

  beforeAll(async () => {
    await writer.connect(configFrom(url as string, false), 0);
    writer.setConnectionGen(1);
    await writer.query('DROP TABLE IF EXISTS plasma_ro_t');
    await writer.query('CREATE TABLE plasma_ro_t (a int)');
    await writer.query(
      `CREATE OR REPLACE FUNCTION plasma_ro_flip() RETURNS void LANGUAGE plpgsql AS $f$
       BEGIN EXECUTE 'set default_' || 'transaction_read_only = off'; END $f$`,
    );
    await writer.query(
      `CREATE OR REPLACE FUNCTION plasma_ro_reset() RETURNS void LANGUAGE plpgsql AS $f$
       BEGIN RESET ALL; END $f$`,
    );
    await writer.query(
      `CREATE OR REPLACE FUNCTION plasma_ro_cfg() RETURNS text LANGUAGE sql AS $f$
       SELECT set_config('default_transaction_' || 'read_only', 'off', false) $f$`,
    );
    await ro.connect(configFrom(url as string, true), 0);
    ro.setConnectionGen(1);
  });

  afterAll(async () => {
    await writer.query('DROP TABLE IF EXISTS plasma_ro_t');
    await writer.query(
      'DROP FUNCTION IF EXISTS plasma_ro_flip(), plasma_ro_reset(), plasma_ro_cfg()',
    );
    await writer.disconnect();
    await ro.disconnect();
  });

  it('refuses a plain write', async () => {
    await writeFails();
  });

  it.each([
    'RESET ALL',
    'DISCARD ALL',
    "SELECT set_config('default_transaction_read_only', 'off', false)",
    "DO $$ BEGIN EXECUTE 'set default_' || 'transaction_read_only = off'; END $$",
    'SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE',
    'SET default_transaction_read_only = off',
  ])('text screen refuses %s, and a write still fails', async (sql) => {
    await expect(ro.query(sql)).rejects.toThrow(/read-only/i);
    await writeFails();
  });

  it.each(['SELECT plasma_ro_flip()', 'SELECT plasma_ro_reset()', 'SELECT plasma_ro_cfg()'])(
    'server re-assert wins after %s (invisible to the text screen)',
    async (sql) => {
      // The function runs inside a read-only transaction, so it may even fail
      // or succeed; what matters is that the next write is refused.
      await ro.query(sql).catch(() => undefined);
      await writeFails();
      await writeFails();
    },
  );

  it('keeps explicit transactions read-only too', async () => {
    await ro.query('BEGIN');
    await expect(ro.query('INSERT INTO plasma_ro_t VALUES (1)')).rejects.toThrow(/read-only/i);
    await ro.query('ROLLBACK');
    await writeFails();
  });

  it('still reads', async () => {
    const res = await ro.query('SELECT 1 AS one');
    expect(res.rows[0]?.[0]).toBe(1);
  });

  it('applies bootstrap SQL (SET ROLE) to the aux / AI connection too (SC-14)', async () => {
    await writer.query('DROP ROLE IF EXISTS plasma_boot_role');
    await writer.query('CREATE ROLE plasma_boot_role');
    const boot = new PostgresDriver();
    try {
      await boot.connect(
        { ...configFrom(url as string, true), bootstrapSql: 'SET ROLE plasma_boot_role' },
        0,
      );
      boot.setConnectionGen(1);
      const ai = await boot.aiQuery('SELECT current_user');
      expect(ai.rows[0]?.[0]).toBe('plasma_boot_role');
      const side = await boot.sidebandQuery('SELECT current_user');
      expect(side.rows[0]?.[0]).toBe('plasma_boot_role');
    } finally {
      await boot.disconnect();
      await writer.query('DROP ROLE IF EXISTS plasma_boot_role');
    }
  });
});
