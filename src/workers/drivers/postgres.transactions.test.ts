import type { ConnectionConfig } from '@shared/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakePostgres } from '../../../test/fake-postgres';
import { PostgresDriver } from './postgres';

/**
 * U44 — explicit BEGIN/COMMIT transaction blocks run from the editor.
 *
 * The driver reads transaction state off the wire (the ReadyForQuery
 * status byte) instead of sniffing SQL prefixes, so every form of
 * BEGIN/COMMIT/ROLLBACK is tracked, an error inside the block flips the
 * state to 'error', and the idle liveness probe can no longer tear the
 * session down inside an aborted transaction (its SELECT 1 gets a 25P02
 * *server answer*, which proves the transport is alive).
 */

let server: FakePostgres;

function config(port: number): ConnectionConfig {
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
    readOnly: false,
  };
}

/** No idle probing — statements must not be preceded by a SELECT 1. */
function driverUnderTest(): PostgresDriver {
  return new PostgresDriver({ idleProbeAfterMs: 3_600_000, probeTimeoutMs: 250 });
}

beforeEach(async () => {
  server = await FakePostgres.start();
});

afterEach(async () => {
  await server.stop();
});

describe('postgres driver transaction state', () => {
  it('tracks BEGIN / UPDATE / COMMIT run as separate editor statements', async () => {
    const driver = driverUnderTest();
    await driver.connect(config(server.port), 0);

    const begin = await driver.query('BEGIN');
    expect(driver.getTxnState()).toBe('active');
    expect(begin.txnState).toBe('active');

    const update = await driver.query('UPDATE t SET a = 1');
    expect(update.txnState).toBe('active');
    expect(update.command).toBe('UPDATE');

    const commit = await driver.query('COMMIT');
    expect(commit.txnState).toBe('none');
    expect(commit.command).toBe('COMMIT');
    expect(driver.getTxnState()).toBe('none');

    // All three statements went down the one primary session, in order.
    expect(server.queries.slice(-3)).toEqual(['BEGIN', 'UPDATE t SET a = 1', 'COMMIT']);
    await driver.disconnect();
  });

  it('maps every transaction keyword form, not just BEGIN/COMMIT prefixes', async () => {
    const driver = driverUnderTest();
    await driver.connect(config(server.port), 0);

    await driver.query('START TRANSACTION');
    expect(driver.getTxnState()).toBe('active');
    await driver.query('ROLLBACK');
    expect(driver.getTxnState()).toBe('none');

    // Leading comment defeats prefix sniffing; the wire status does not care.
    await driver.query('-- a note\nBEGIN');
    expect(driver.getTxnState()).toBe('active');
    await driver.query('END');
    expect(driver.getTxnState()).toBe('none');

    await driver.query('BEGIN');
    expect(driver.getTxnState()).toBe('active');
    await driver.query('ABORT');
    expect(driver.getTxnState()).toBe('none');

    // ROLLBACK TO SAVEPOINT keeps the transaction open.
    await driver.query('BEGIN');
    await driver.query('SAVEPOINT s1');
    await driver.query('ROLLBACK TO SAVEPOINT s1');
    expect(driver.getTxnState()).toBe('active');
    await driver.query('COMMIT');
    expect(driver.getTxnState()).toBe('none');
    await driver.disconnect();
  });

  it('reports the aborted state after an error mid-transaction and recovers via ROLLBACK', async () => {
    const driver = driverUnderTest();
    await driver.connect(config(server.port), 0);

    await driver.query('BEGIN');
    server.failNext('22012', 'division by zero');
    await expect(driver.query('SELECT 1/0')).rejects.toThrow(/division by zero/);
    expect(driver.getTxnState()).toBe('error');
    expect(driver.isConnected()).toBe(true);

    // Every statement but COMMIT/ROLLBACK is rejected while aborted.
    await expect(driver.query('SELECT 1')).rejects.toThrow(/current transaction is aborted/);
    expect(driver.getTxnState()).toBe('error');

    await driver.query('ROLLBACK');
    expect(driver.getTxnState()).toBe('none');
    expect(driver.isConnected()).toBe(true);
    await driver.disconnect();
  });

  it('reports COMMIT inside an aborted transaction as a ROLLBACK', async () => {
    const driver = driverUnderTest();
    await driver.connect(config(server.port), 0);

    await driver.query('BEGIN');
    server.failNext('22012', 'division by zero');
    await expect(driver.query('SELECT 1/0')).rejects.toThrow(/division by zero/);
    expect(driver.getTxnState()).toBe('error');

    const commit = await driver.query('COMMIT');
    expect(commit.command).toBe('ROLLBACK');
    expect(commit.txnState).toBe('none');
    expect(driver.getTxnState()).toBe('none');
    await driver.disconnect();
  });

  it('does not let the idle probe tear the session down inside an aborted transaction', async () => {
    // Every statement is preceded by the liveness probe (SELECT 1).
    const driver = new PostgresDriver({ idleProbeAfterMs: 0, probeTimeoutMs: 250 });
    await driver.connect(config(server.port), 0);
    const socketsAtStart = server.openSockets;

    await driver.query('BEGIN');
    server.failOn(/1\/0/, '22012', 'division by zero');
    await expect(driver.query('SELECT 1/0')).rejects.toThrow(/division by zero/);
    expect(driver.getTxnState()).toBe('error');

    // The probe's SELECT 1 now gets 25P02 — a server answer, not a dead
    // socket. Before the fix this marked the connection lost and the
    // ROLLBACK below never reached the server.
    await driver.query('ROLLBACK');
    expect(driver.getTxnState()).toBe('none');
    expect(driver.isConnected()).toBe(true);
    expect(server.openSockets).toBe(socketsAtStart);
    await driver.disconnect();
  });

  it('runs a multi-statement string sequentially on one session', async () => {
    const driver = driverUnderTest();
    await driver.connect(config(server.port), 0);

    const result = await driver.query('BEGIN; SELECT 1; COMMIT');
    // The statement that produced rows wins the grid.
    expect(result.rows).toEqual([['1']]);
    expect(result.command).toBe('SELECT');
    expect(result.txnState).toBe('none');
    // The fake saw exactly the three statements, parsed in order.
    expect(server.queries.slice(-3)).toEqual(['BEGIN', 'SELECT 1', 'COMMIT']);
    await driver.disconnect();
  });

  it('stops a multi-statement string at the first error, tagged with its position', async () => {
    const driver = driverUnderTest();
    await driver.connect(config(server.port), 0);

    server.failOn(/1\/0/, '22012', 'division by zero');
    await expect(driver.query('BEGIN; SELECT 1/0; COMMIT')).rejects.toThrow(
      /division by zero \(statement 2 of 3\)/,
    );
    // The open transaction is aborted, not silently committed.
    expect(driver.getTxnState()).toBe('error');
    await driver.query('ROLLBACK');
    expect(driver.getTxnState()).toBe('none');
    await driver.disconnect();
  });

  it('rejects parameters combined with a multi-statement string', async () => {
    const driver = driverUnderTest();
    await driver.connect(config(server.port), 0);
    await expect(driver.query('SELECT $1; SELECT 1', [1])).rejects.toThrow(
      /parameters are not supported with multiple statements/,
    );
    await driver.disconnect();
  });

  it('refuses grid edits while the transaction is aborted', async () => {
    const driver = driverUnderTest();
    await driver.connect(config(server.port), 0);
    driver.setConnectionGen(1);

    await driver.query('BEGIN');
    server.failNext('22012', 'division by zero');
    await expect(driver.query('SELECT 1/0')).rejects.toThrow(/division by zero/);
    expect(driver.getTxnState()).toBe('error');

    const queriesBefore = server.queries.length;
    await expect(
      driver.commitEditBatch(1, [{ sql: 'UPDATE t SET a = 2 WHERE id = 1' }]),
    ).rejects.toThrow(/roll it back before applying edits/);
    // No SAVEPOINT / UPDATE ever reached the server.
    expect(server.queries.length).toBe(queriesBefore);

    await driver.query('ROLLBACK');
    // After rollback, edits go through again — wrapped in a user-facing
    // transaction still open? No: state is 'none', so BEGIN/COMMIT.
    const applied = await driver.commitEditBatch(1, [{ sql: 'UPDATE t SET a = 2 WHERE id = 1' }]);
    expect(applied).toBe('none');
    expect(server.queries.slice(-3)).toEqual([
      'BEGIN',
      'UPDATE t SET a = 2 WHERE id = 1',
      'COMMIT',
    ]);
    await driver.disconnect();
  });
});
