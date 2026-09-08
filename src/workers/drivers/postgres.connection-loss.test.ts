import { isConnectionLostError } from '@shared/connection-loss';
import type { ConnectionConfig } from '@shared/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakePostgres } from '../../../test/fake-postgres';
import { PostgresDriver } from './postgres';

/**
 * U27 — a VPN reconnect (or sleep, or Wi-Fi switch) leaves the worker
 * holding sockets whose peer is gone. Before this, the driver kept
 * `primary` non-null, reported `isConnected() === true`, and every later
 * query failed forever ("Client has encountered a connection error and
 * is not queryable") until the whole app was restarted.
 *
 * Both shapes the transport dies in are covered:
 *   - reset: the socket errors out
 *   - half-open: the socket stays writable and nothing ever answers
 *
 * `idleProbeAfterMs: 0` makes every statement probe first, which is what
 * a real session hitting a query after minutes of idling does.
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

function driverUnderTest(): PostgresDriver {
  return new PostgresDriver({ idleProbeAfterMs: 0, probeTimeoutMs: 250 });
}

beforeEach(async () => {
  server = await FakePostgres.start();
});

afterEach(async () => {
  await server.stop();
});

describe('postgres driver transport loss', () => {
  it('reports a reset connection as lost instead of staying "connected"', async () => {
    const driver = driverUnderTest();
    await driver.connect(config(server.port), 0);
    expect(driver.isConnected()).toBe(true);

    server.killSockets();

    const err = await driver.query('SELECT 1').catch((e: unknown) => e);
    expect(isConnectionLostError(err)).toBe(true);
    expect(driver.isConnected()).toBe(false);
    await driver.disconnect();
  });

  it('fails a half-open socket on the liveness probe instead of hanging', async () => {
    const driver = driverUnderTest();
    await driver.connect(config(server.port), 0);

    // Peer accepts bytes and never answers: no error event, and
    // server-side statement_timeout is unreachable, so without the probe
    // this call waits on TCP retransmits.
    server.stallSockets();

    const err = await driver.query('SELECT 1').catch((e: unknown) => e);
    expect(isConnectionLostError(err)).toBe(true);
    expect(String(err)).toMatch(/liveness probe failed/);
    expect(driver.isConnected()).toBe(false);
    await driver.disconnect();
  });

  it('keeps refusing statements after the loss rather than half-working', async () => {
    const driver = driverUnderTest();
    await driver.connect(config(server.port), 0);
    server.stallSockets();
    await expect(driver.query('SELECT 1')).rejects.toThrow(/connection lost/i);

    // Still lost even though the server itself is fine: the session those
    // sockets belonged to is gone, so callers must reconnect.
    await expect(driver.introspect()).rejects.toThrow(/connection lost/i);
    await driver.disconnect();
  });

  it('serves statements again after reconnecting to the returned network', async () => {
    const driver = driverUnderTest();
    await driver.connect(config(server.port), 0);
    server.stallSockets();
    await expect(driver.query('SELECT 1')).rejects.toThrow(/connection lost/i);

    // "VPN came back": the connect path main retries with must rebuild a
    // usable session — no app restart involved.
    const version = await driver.connect(config(server.port), 0);
    expect(version).toMatch(/PostgreSQL 16\.6/);
    expect(driver.isConnected()).toBe(true);
    const result = await driver.query('SELECT 1');
    expect(result.rows).toEqual([['1']]);
    await driver.disconnect();
  });
});
