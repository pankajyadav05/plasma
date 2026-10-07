import { createServer } from 'node:net';
import { decodeDiagnosedMessage } from '@shared/connect-diagnosis';
import type { ConnectionConfig } from '@shared/protocol';
import { describe, expect, it } from 'vitest';
import {
  type StagedTestDeps,
  diagnoseFailure,
  diagnosedError,
  isDialableHost,
  probeDns,
  probeTcp,
  runStagedTest,
  secretsOf,
} from './connect-diagnose';

const config = (over: Partial<ConnectionConfig> = {}): ConnectionConfig =>
  ({
    id: 'c1',
    name: 'prod',
    engine: 'postgres',
    host: 'db.example.com',
    port: 5432,
    database: 'orders',
    user: 'app',
    password: 'hunter2-secret',
    ssl: false,
    readOnly: false,
    ...over,
  }) as ConnectionConfig;

const ok = { serverVersion: 'PostgreSQL 16.2', engine: 'postgres' };
const deps = (over: Partial<StagedTestDeps> = {}): StagedTestDeps => ({
  connect: async () => ok,
  dns: async () => ({ notes: { dns: '10.0.0.5' } }),
  tcp: async () => undefined,
  ...over,
});
const coded = (message: string, info: Record<string, unknown>) =>
  Object.assign(new Error(message), info);
const statuses = (r: Awaited<ReturnType<typeof runStagedTest>>) =>
  (r.stages ?? []).map((s) => `${s.id}:${s.status}`);

describe('runStagedTest', () => {
  it('walks host, port, login and database and says so', async () => {
    const r = await runStagedTest(config(), deps());
    expect(r.ok).toBe(true);
    expect(statuses(r)).toEqual(['dns:ok', 'tcp:ok', 'login:ok', 'database:ok']);
    expect(r.stages?.[0]?.note).toBe('10.0.0.5');
    expect(r.stages?.at(-1)?.note).toBe('PostgreSQL 16.2');
    if (r.ok) expect(r.serverVersion).toBe('PostgreSQL 16.2');
  });

  it('stops at a host that does not resolve, without trying the port or the driver', async () => {
    let driverCalled = false;
    const r = await runStagedTest(
      config(),
      deps({
        dns: async () => {
          throw coded('getaddrinfo ENOTFOUND db.example.com', { code: 'ENOTFOUND' });
        },
        connect: async () => {
          driverCalled = true;
          return ok;
        },
      }),
    );
    expect(r.ok).toBe(false);
    expect(driverCalled).toBe(false);
    expect(statuses(r)).toEqual(['dns:failed', 'tcp:skipped', 'login:skipped', 'database:skipped']);
    if (!r.ok) {
      expect(r.diagnosis?.cause).toBe('dns');
      expect(r.diagnosis?.field).toBe('host');
    }
  });

  it('stops at a port nobody listens on', async () => {
    const r = await runStagedTest(
      config(),
      deps({
        tcp: async () => {
          throw coded('connect ECONNREFUSED 10.0.0.5:5432', { code: 'ECONNREFUSED' });
        },
      }),
    );
    expect(statuses(r)).toEqual(['dns:ok', 'tcp:failed', 'login:skipped', 'database:skipped']);
    if (!r.ok) expect(r.diagnosis?.cause).toBe('refused');
  });

  it('puts a wrong password on the login step', async () => {
    const r = await runStagedTest(
      config(),
      deps({
        connect: async () => {
          throw coded('password authentication failed for user "app"', { code: '28P01' });
        },
      }),
    );
    expect(statuses(r)).toEqual(['dns:ok', 'tcp:ok', 'login:failed', 'database:skipped']);
    if (!r.ok) {
      expect(r.diagnosis?.cause).toBe('auth-failed');
      expect(r.diagnosis?.field).toBe('password');
    }
  });

  it('puts a missing database on the last step: the login worked', async () => {
    const r = await runStagedTest(
      config(),
      deps({
        connect: async () => {
          throw coded('database "orders" does not exist', { code: '3D000' });
        },
      }),
    );
    expect(statuses(r)).toEqual(['dns:ok', 'tcp:ok', 'login:ok', 'database:failed']);
    if (!r.ok) expect(r.diagnosis?.cause).toBe('database-missing');
  });

  it('shows the TLS step, and fails it for a certificate problem', async () => {
    const r = await runStagedTest(
      config({ ssl: true, tls: { mode: 'verify-full' } }),
      deps({
        connect: async () => {
          throw coded('self-signed certificate', { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
        },
      }),
    );
    expect(statuses(r)).toEqual([
      'dns:ok',
      'tcp:ok',
      'tls:failed',
      'login:skipped',
      'database:skipped',
    ]);
    if (!r.ok) expect(r.diagnosis?.cause).toBe('tls-untrusted');
  });

  it('opens the SSH tunnel first and connects through it', async () => {
    const seen: Array<{ host: string; port: number }> = [];
    const r = await runStagedTest(
      config(),
      deps({
        openTunnel: async () => ({ host: '127.0.0.1', port: 40001 }),
        connect: async (target) => {
          seen.push(target);
          return ok;
        },
      }),
      { host: 'jump', user: 'me', password: 'ssh-pw' },
    );
    expect(statuses(r)).toEqual(['ssh:ok', 'login:ok', 'database:ok']);
    expect(seen).toEqual([{ host: '127.0.0.1', port: 40001 }]);
  });

  it('stops at an SSH login failure and names the jump host, not the database', async () => {
    let driverCalled = false;
    const r = await runStagedTest(
      config(),
      deps({
        openTunnel: async () => {
          throw coded('All configured authentication methods failed', {
            source: 'ssh',
            level: 'client-authentication',
          });
        },
        connect: async () => {
          driverCalled = true;
          return ok;
        },
      }),
      { host: 'jump', user: 'me', password: 'ssh-pw' },
    );
    expect(driverCalled).toBe(false);
    expect(statuses(r)).toEqual(['ssh:failed', 'login:skipped', 'database:skipped']);
    if (!r.ok) {
      expect(r.diagnosis?.cause).toBe('ssh-auth');
      expect(r.diagnosis?.field).toBe('ssh');
    }
  });

  it('explains a socket the jump host closed with the reason the jump host gave', async () => {
    const r = await runStagedTest(
      config(),
      deps({
        openTunnel: async () => ({ host: '127.0.0.1', port: 40001 }),
        connect: async () => {
          throw new Error('Connection terminated unexpectedly');
        },
        forwardError: () => '(SSH) Channel open failure: Connection refused',
      }),
      { host: 'jump', user: 'me', password: 'ssh-pw' },
    );
    expect(statuses(r)).toEqual(['ssh:ok', 'login:failed', 'database:skipped']);
    if (!r.ok) {
      expect(r.diagnosis?.cause).toBe('ssh-forward-refused');
      expect(r.diagnosis?.detail).toContain('Connection refused');
    }
  });

  it('has a single step for a file, and no host probes', async () => {
    const r = await runStagedTest(
      config({ engine: 'sqlite', host: 'local', port: 1, database: '/tmp/x.db' }),
      deps({
        dns: async () => {
          throw new Error('must not run');
        },
        connect: async () => {
          throw new Error('database file not found: /tmp/x.db');
        },
      }),
    );
    expect(statuses(r)).toEqual(['database:failed']);
    if (!r.ok) expect(r.diagnosis?.cause).toBe('file-missing');
  });

  it('connects, and warns, when an OpenSearch cluster is red', async () => {
    const r = await runStagedTest(
      config({ engine: 'opensearch', port: 9200 }),
      deps({
        connect: async () => ({
          serverVersion: '2.17.1',
          engine: 'opensearch',
          clusterStatus: 'red',
        }),
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.warning?.cause).toBe('os-cluster-red');
      expect(statuses(r)).toEqual(['dns:ok', 'tcp:ok', 'login:ok', 'database:ok']);
    }
    const green = await runStagedTest(
      config({ engine: 'opensearch', port: 9200 }),
      deps({
        connect: async () => ({
          serverVersion: '2.17.1',
          engine: 'opensearch',
          clusterStatus: 'green',
        }),
      }),
    );
    if (green.ok) expect(green.warning).toBeUndefined();
  });

  it('never returns the password, in the message or the diagnosis', async () => {
    const r = await runStagedTest(
      config(),
      deps({
        connect: async () => {
          throw new Error(
            'could not connect to postgres://app:hunter2-secret@db.example.com/orders',
          );
        },
      }),
    );
    expect(JSON.stringify(r)).not.toContain('hunter2-secret');
  });
});

describe('hosts that are not one name and one port', () => {
  const cases: Array<[string, string]> = [
    ['redis', 'sentinel://h1:26379,h2:26379/master'],
    ['redis', 'cluster://h1:7000,h2:7001'],
    ['redis', '/var/run/redis/redis.sock'],
    ['redis', 'unix:/tmp/redis.sock'],
    ['postgres', '/var/run/postgresql'],
    ['postgres', 'host=/var/run/postgresql'],
    ['mysql', '/tmp/mysql.sock'],
  ];
  it.each(cases)(
    '%s host %s goes straight to the driver, with no lookup or dial',
    async (engine, host) => {
      const probes: string[] = [];
      const r = await runStagedTest(
        config({ engine: engine as ConnectionConfig['engine'], host }),
        deps({
          dns: async () => {
            probes.push('dns');
            throw coded('getaddrinfo ENOTFOUND', { code: 'ENOTFOUND' });
          },
          tcp: async () => {
            probes.push('tcp');
            throw coded('connect ECONNREFUSED', { code: 'ECONNREFUSED' });
          },
        }),
      );
      expect(probes).toEqual([]);
      expect(r.ok).toBe(true);
      expect(statuses(r)).toEqual(['login:ok', 'database:ok']);
    },
  );

  it('still reports a driver failure of such a host on the right step', async () => {
    const r = await runStagedTest(
      config({ engine: 'redis', host: 'sentinel://h1:26379/master' }),
      deps({
        connect: async () => {
          throw coded('WRONGPASS invalid username-password pair', { name: 'ReplyError' });
        },
      }),
    );
    expect(statuses(r)).toEqual(['login:failed', 'database:skipped']);
  });

  it('tells plain host names from the other forms', () => {
    expect(isDialableHost('postgres', 'db.example.com')).toBe(true);
    expect(isDialableHost('redis', 'cache.internal')).toBe(true);
    expect(isDialableHost('postgres', '[::1]')).toBe(true);
    expect(isDialableHost('postgres', '/var/run/postgresql')).toBe(false);
    expect(isDialableHost('redis', 'cluster://a:1')).toBe(false);
    expect(isDialableHost('opensearch', 'https://x')).toBe(false);
  });
});

describe('diagnosedError', () => {
  it('rejects with a readable message that carries the diagnosis', () => {
    const err = diagnosedError(
      coded('connect ECONNREFUSED 127.0.0.1:5432', { code: 'ECONNREFUSED' }),
      config(),
    );
    expect(err.message.startsWith('Nothing is listening there. ')).toBe(true);
    const back = decodeDiagnosedMessage(err.message);
    expect(back.diagnosis?.cause).toBe('refused');
    expect(back.diagnosis?.field).toBe('port');
  });

  it('keeps the password out of everything it says', () => {
    const err = diagnosedError(
      new Error('FATAL: password authentication failed for user "app" (hunter2-secret)'),
      config(),
    );
    expect(err.message).not.toContain('hunter2-secret');
  });

  it('uses the codes the worker attached', () => {
    const d = diagnoseFailure(
      coded('x', { errno: 1045, code: 'ER_ACCESS_DENIED_ERROR' }),
      config({ engine: 'mysql' }),
    );
    expect(d.cause).toBe('auth-failed');
  });

  it('knows every secret of a connection', () => {
    expect(
      secretsOf(config({ opensearch: { apiKey: 'k1', awsSecretAccessKey: 'k2' } }), {
        password: 's1',
        passphrase: 's2',
        privateKey: 's3',
      }),
    ).toEqual(['hunter2-secret', 'k1', 'k2', 's1', 's2', 's3']);
  });
});

describe('the probes', () => {
  it('resolves an IP address without a lookup and a real name', async () => {
    expect((await probeDns('127.0.0.1')).notes.dns).toBe('IP address');
    expect((await probeDns('localhost')).notes.dns).toMatch(/127\.0\.0\.1|::1/);
    await expect(probeDns('no-such-host.invalid')).rejects.toMatchObject({ code: 'ENOTFOUND' });
  });

  it('reaches a listening port and reports a closed one as refused', async () => {
    const server = createServer((s) => s.destroy());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    await expect(probeTcp('127.0.0.1', port)).resolves.toBeUndefined();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(probeTcp('127.0.0.1', port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });
});
