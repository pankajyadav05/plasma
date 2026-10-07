import { type ConnectCause, diagnoseConnectError } from '@shared/connect-diagnosis';
import { errorInfoOf } from '@shared/error-info';
import type { ConnectionConfig, ConnectionEngine } from '@shared/protocol';
import { describe, expect, it } from 'vitest';
import { ClickhouseDriver } from './drivers/clickhouse';
import { MysqlDriver } from './drivers/mysql';
import { OpenSearchDriver } from './drivers/opensearch';
import { PostgresDriver } from './drivers/postgres';
import { RedisDriver } from './drivers/redis';
import type { TestableDriver } from './test-connect';

/**
 * Opt-in: the diagnosis against what the REAL drivers throw at real servers
 * (not hand-written samples). Each engine runs when its PLASMA_LIVE_* variable
 * is set, like the other live suites:
 *
 *   PLASMA_LIVE_PG=postgres://user:pass@host:port/db
 *   PLASMA_LIVE_MARIADB=1 PLASMA_MARIADB_HOST/PORT/USER/PASSWORD   (or the MYSQL twin)
 *   PLASMA_LIVE_CLICKHOUSE=1 PLASMA_CLICKHOUSE_HOST/PORT/USER/PASSWORD
 *   PLASMA_LIVE_REDIS=redis://host:port     PLASMA_LIVE_OS=http://host:port
 */

interface Target {
  engine: ConnectionEngine;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  make: () => TestableDriver;
}

const pgUrl = process.env.PLASMA_LIVE_PG ? new URL(process.env.PLASMA_LIVE_PG) : null;
const my = process.env.PLASMA_LIVE_MARIADB
  ? 'MARIADB'
  : process.env.PLASMA_LIVE_MYSQL
    ? 'MYSQL'
    : null;
const env = process.env;

const targets: Target[] = [];
if (pgUrl) {
  targets.push({
    engine: 'postgres',
    host: pgUrl.hostname,
    port: Number(pgUrl.port || 5432),
    user: decodeURIComponent(pgUrl.username),
    password: decodeURIComponent(pgUrl.password),
    database: pgUrl.pathname.slice(1) || 'postgres',
    make: () => new PostgresDriver(),
  });
}
if (my) {
  targets.push({
    engine: 'mysql',
    host: env[`PLASMA_${my}_HOST`] ?? '127.0.0.1',
    port: Number(env[`PLASMA_${my}_PORT`] ?? 3306),
    user: env[`PLASMA_${my}_USER`] ?? 'root',
    password: env[`PLASMA_${my}_PASSWORD`] ?? '',
    database: '',
    make: () => new MysqlDriver(),
  });
}
if (env.PLASMA_LIVE_CLICKHOUSE) {
  targets.push({
    engine: 'clickhouse',
    host: env.PLASMA_CLICKHOUSE_HOST ?? '127.0.0.1',
    port: Number(env.PLASMA_CLICKHOUSE_PORT ?? 8123),
    user: env.PLASMA_CLICKHOUSE_USER ?? 'default',
    password: env.PLASMA_CLICKHOUSE_PASSWORD ?? '',
    database: '',
    make: () => new ClickhouseDriver(),
  });
}
if (env.PLASMA_LIVE_REDIS) {
  const u = new URL(env.PLASMA_LIVE_REDIS);
  targets.push({
    engine: 'redis',
    host: u.hostname,
    port: Number(u.port || 6379),
    user: '',
    password: '',
    database: '0',
    make: () => new RedisDriver(),
  });
}
if (env.PLASMA_LIVE_OS) {
  const u = new URL(env.PLASMA_LIVE_OS);
  targets.push({
    engine: 'opensearch',
    host: u.hostname,
    port: Number(u.port || 9200),
    user: '',
    password: '',
    database: '',
    make: () => new OpenSearchDriver(),
  });
}

/** A free port nothing listens on. */
const DEAD_PORT = 1;

async function diagnose(
  t: Target,
  over: Partial<ConnectionConfig>,
): Promise<{ cause: ConnectCause; text: string; raw: string }> {
  const config = {
    id: 'live',
    name: 'live',
    engine: t.engine,
    host: t.host,
    port: t.port,
    user: t.user,
    password: t.password,
    database: t.database,
    ssl: false,
    readOnly: false,
    ...over,
  } as ConnectionConfig;
  const driver = t.make();
  try {
    await driver.connect(config);
  } catch (err) {
    const d = diagnoseConnectError(
      { message: err instanceof Error ? err.message : String(err), ...errorInfoOf(err) },
      {
        engine: t.engine,
        host: config.host,
        port: config.port,
        user: config.user,
        database: config.database,
        ssl: config.ssl,
        secrets: [config.password],
      },
    );
    return { cause: d.cause, text: `${d.title}. ${d.detail}`, raw: d.raw };
  } finally {
    await driver.disconnect().catch(() => undefined);
  }
  throw new Error('expected the connect to fail');
}

describe.skipIf(targets.length === 0 && !process.env.PLASMA_LIVE_REDIS_AUTH)(
  'connection errors from real servers',
  () => {
    for (const t of targets) {
      describe(t.engine, () => {
        it('a host that does not exist is "Host not found"', async () => {
          const d = await diagnose(t, { host: 'no-such-host.invalid' });
          expect(d.cause).toBe('dns');
        }, 30_000);

        it('a port nobody listens on is "Nothing is listening there"', async () => {
          const d = await diagnose(t, { port: DEAD_PORT });
          expect(d.cause).toBe('refused');
          expect(d.text).toContain(`${t.host}:${DEAD_PORT}`);
        }, 30_000);

        it('TLS asked of a plain server is a TLS cause, not a bare socket error', async () => {
          const d = await diagnose(t, { ssl: true, tls: { mode: 'require' } });
          // Postgres, MySQL and ClickHouse are told outright; Redis and OpenSearch just stop answering.
          expect(['tls-not-supported', 'tls-handshake', 'tls-required', 'timeout']).toContain(
            d.cause,
          );
        }, 30_000);
      });
    }

    const byEngine = (engine: ConnectionEngine) => targets.find((t) => t.engine === engine);

    for (const engine of ['postgres', 'mysql', 'clickhouse'] as const) {
      const t = byEngine(engine);
      if (!t) continue;
      describe(`${engine} login`, () => {
        it('a wrong password is a login refusal that does not echo the password', async () => {
          const wrong = 'definitely-wrong-9f3a';
          const d = await diagnose(t, { password: wrong });
          expect(d.cause).toBe('auth-failed');
          expect(d.raw).not.toContain(wrong);
        }, 30_000);

        it('a database that does not exist is "Database not found"', async () => {
          if (engine === 'mysql') {
            const d = await diagnose(t, { database: 'plasma_no_such_db' });
            expect(d.cause).toBe('database-missing');
          } else {
            const d = await diagnose(t, { database: 'plasma_no_such_db' });
            expect(d.cause).toBe('database-missing');
          }
        }, 30_000);
      });
    }

    const pg = byEngine('postgres');
    if (pg) {
      it('postgres: a server that is not Postgres is "not like PostgreSQL"', async () => {
        const other = targets.find((x) => x.engine !== 'postgres');
        if (!other) return;
        const d = await diagnose(pg, { host: other.host, port: other.port });
        expect(['wrong-service', 'timeout']).toContain(d.cause);
      }, 30_000);
    }

    const os = byEngine('opensearch');
    if (os) {
      it('opensearch: an HTTP server that is not OpenSearch is refused', async () => {
        const other = targets.find((x) => x.engine === 'clickhouse');
        if (!other) return;
        const d = await diagnose(os, { host: other.host, port: other.port });
        expect(d.cause).toBe('wrong-service');
      }, 30_000);
    }

    // A Redis that wants a password: PLASMA_LIVE_REDIS_AUTH=redis://:password@host:port
    const authUrl = process.env.PLASMA_LIVE_REDIS_AUTH
      ? new URL(process.env.PLASMA_LIVE_REDIS_AUTH)
      : null;
    if (authUrl) {
      const redisAuth: Target = {
        engine: 'redis',
        host: authUrl.hostname,
        port: Number(authUrl.port || 6379),
        user: '',
        password: decodeURIComponent(authUrl.password),
        database: '0',
        make: () => new RedisDriver(),
      };
      describe('redis with a password', () => {
        it('no password at all is "needs a password"', async () => {
          const d = await diagnose(redisAuth, { password: '' });
          expect(d.cause).toBe('redis-auth');
          expect(d.text).toMatch(/needs a password/i);
        }, 30_000);

        it('a wrong password is "refused the login" and is never echoed', async () => {
          const d = await diagnose(redisAuth, { password: 'definitely-wrong-9f3a' });
          expect(d.cause).toBe('redis-auth');
          expect(d.text).toMatch(/refused the login/i);
          expect(d.raw).not.toContain('definitely-wrong-9f3a');
        }, 30_000);
      });
    }
  },
);
