import type { ConnectionConfig } from '@shared/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakePostgres } from '../../../test/fake-postgres';
import { PostgresDriver } from './postgres';

/**
 * C1 / C5 — connect-time session setup: read-only connections are
 * enforced by the server, and a transport loss inside an open
 * transaction is remembered so main never replays into a fresh session.
 */

let server: FakePostgres;

function config(port: number, readOnly: boolean): ConnectionConfig {
  return {
    id: 'fake',
    name: 'fake',
    engine: 'postgres',
    host: '127.0.0.1',
    port,
    database: 'plasma',
    user: 'plasma',
    password: 'plasma',
    ssl: false,
    readOnly,
  };
}

beforeEach(async () => {
  server = await FakePostgres.start();
});

afterEach(async () => {
  await server.stop();
});

describe('postgres driver connect', () => {
  it('turns on default_transaction_read_only for read-only connections', async () => {
    const driver = new PostgresDriver();
    await driver.connect(config(server.port, true), 0);
    const sets = server.queries.filter((q) => /default_transaction_read_only/i.test(q));
    // primary + aux (control only ever cancels)
    expect(sets).toHaveLength(2);
    await driver.disconnect();
  });

  it('leaves writable connections alone', async () => {
    const driver = new PostgresDriver();
    await driver.connect(config(server.port, false), 0);
    expect(server.queries.some((q) => /read_only/i.test(q))).toBe(false);
    await driver.disconnect();
  });

  it('remembers that the session died inside a transaction', async () => {
    const driver = new PostgresDriver({ idleProbeAfterMs: 0, probeTimeoutMs: 250 });
    await driver.connect(config(server.port, false), 0);
    await driver.beginTransaction();
    server.killSockets();
    await expect(driver.query('SELECT 1')).rejects.toThrow(/connection lost/i);
    expect(driver.lostDuringTransaction()).toBe(true);
    await driver.disconnect();
    expect(driver.lostDuringTransaction()).toBe(false);
  });

  it('does not flag a loss outside a transaction', async () => {
    const driver = new PostgresDriver({ idleProbeAfterMs: 0, probeTimeoutMs: 250 });
    await driver.connect(config(server.port, false), 0);
    server.killSockets();
    await expect(driver.query('SELECT 1')).rejects.toThrow(/connection lost/i);
    expect(driver.lostDuringTransaction()).toBe(false);
    await driver.disconnect();
  });
});
