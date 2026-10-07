import { createServer as createHttpServer } from 'node:http';
import { type Server, createServer } from 'node:net';
import { errorInfoOf } from '@shared/error-info';
import type { ConnectionConfig } from '@shared/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenSearchDriver } from './opensearch';
import { RedisDriver } from './redis';

/**
 * What a failed connect says. The drivers used to hide the reason: Redis
 * answered every failure with "Connection is closed.", and OpenSearch accepted
 * any HTTP server that answered GET /. These run against tiny local servers,
 * no real database needed.
 */

const config = (engine: 'redis' | 'opensearch', port: number): ConnectionConfig =>
  ({
    id: 'c',
    name: 'c',
    engine,
    host: '127.0.0.1',
    port,
    database: engine === 'redis' ? '0' : '',
    user: '',
    password: '',
    ssl: false,
    readOnly: false,
  }) as ConnectionConfig;

const servers: Array<{ close(cb?: () => void): unknown }> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function listen(server: Server | ReturnType<typeof createHttpServer>): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}

async function failure(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the connect to fail');
}

describe('Redis connect errors keep their reason', () => {
  it('a server that refuses the password says WRONGPASS, not "Connection is closed"', async () => {
    const port = await listen(
      createServer((socket) => {
        socket.on('data', () => {
          socket.write('-WRONGPASS invalid username-password pair or user is disabled.\r\n');
        });
        socket.on('error', () => undefined);
      }),
    );
    const err = await failure(
      new RedisDriver().connect({ ...config('redis', port), password: 'x' }),
    );
    expect(err.message).toMatch(/WRONGPASS/);
    expect(err.message).not.toMatch(/Connection is closed/);
  });

  it('a port nobody listens on carries the refused code', async () => {
    const port = await listen(createServer());
    await new Promise<void>((r) => (servers.pop() as Server).close(() => r()));
    const err = await failure(new RedisDriver().connect(config('redis', port)));
    expect(errorInfoOf(err)?.code).toBe('ECONNREFUSED');
  });
});

describe('OpenSearch connect', () => {
  it('refuses an HTTP server that is not OpenSearch', async () => {
    const port = await listen(
      createHttpServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('Ok.\n');
      }),
    );
    const err = await failure(new OpenSearchDriver().connect(config('opensearch', port)));
    expect(err.message).toMatch(/not OpenSearch/);
  });

  it('accepts a server that says which version it is', async () => {
    const port = await listen(
      createHttpServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ name: 'n', version: { number: '2.17.1', distribution: 'opensearch' } }),
        );
      }),
    );
    const driver = new OpenSearchDriver();
    expect(await driver.connect(config('opensearch', port))).toBe('2.17.1');
    await driver.disconnect();
  });

  it('carries the HTTP status of a refusal', async () => {
    const port = await listen(
      createHttpServer((_req, res) => {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { type: 'security_exception', reason: 'Unauthorized' },
            status: 401,
          }),
        );
      }),
    );
    const err = await failure(new OpenSearchDriver().connect(config('opensearch', port)));
    expect(errorInfoOf(err)?.status).toBe(401);
  });
});
