import { describe, expect, it } from 'vitest';
import {
  type ConnectCause,
  type ConnectErrorInput,
  type DiagnoseContext,
  decodeDiagnosedMessage,
  diagnoseClusterStatus,
  diagnoseConnectError,
  encodeDiagnosedMessage,
  stageOfCause,
} from './connect-diagnosis';

/**
 * Samples are what the drivers really throw: the objects below were captured
 * from live servers (PostgreSQL 16, MariaDB 10.11, ClickHouse 24.8, Redis 7,
 * OpenSearch 2.17) and from Node itself; the few that need a server we do not
 * run in tests (a TLS-only listener, an LDAP user, a red cluster) follow the
 * documented wire format of the engine.
 */

const ctx = (over: Partial<DiagnoseContext> = {}): DiagnoseContext => ({
  engine: 'postgres',
  host: 'db.example.com',
  port: 5432,
  user: 'app',
  database: 'orders',
  ssl: false,
  ssh: false,
  secrets: ['hunter2-secret'],
  ...over,
});

interface Sample {
  name: string;
  engine: string;
  err: ConnectErrorInput;
  cause: ConnectCause;
  field?: string;
  over?: Partial<DiagnoseContext>;
}

const NODE = (
  code: string,
  message: string,
  errno?: number,
  syscall = 'connect',
): ConnectErrorInput => ({
  message,
  code,
  ...(errno !== undefined ? { errno } : {}),
  syscall,
});

const SAMPLES: Sample[] = [
  // ── network, the same for every engine ──
  {
    name: 'dns: host not found',
    engine: 'postgres',
    cause: 'dns',
    field: 'host',
    err: NODE('ENOTFOUND', 'getaddrinfo ENOTFOUND no-such-host.invalid', -3008, 'getaddrinfo'),
  },
  {
    name: 'dns: temporary failure',
    engine: 'mysql',
    cause: 'dns',
    field: 'host',
    err: NODE('EAI_AGAIN', 'getaddrinfo EAI_AGAIN db.corp', -3001, 'getaddrinfo'),
  },
  {
    name: 'refused: pg',
    engine: 'postgres',
    cause: 'refused',
    field: 'port',
    err: NODE('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:5498', -111),
  },
  {
    name: 'refused: mysql',
    engine: 'mysql',
    cause: 'refused',
    field: 'port',
    err: NODE('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:3398', -111),
  },
  {
    name: 'refused: opensearch',
    engine: 'opensearch',
    cause: 'refused',
    err: { name: 'ConnectionError', message: 'connect ECONNREFUSED 127.0.0.1:9298' },
  },
  {
    name: 'refused: message only',
    engine: 'clickhouse',
    cause: 'refused',
    err: { message: 'connect ECONNREFUSED 10.0.0.9:8123' },
  },
  {
    name: 'timeout: pg connect timeout',
    engine: 'postgres',
    cause: 'timeout',
    field: 'host',
    err: { message: 'timeout expired' },
  },
  {
    name: 'timeout: pg pool wording',
    engine: 'postgres',
    cause: 'timeout',
    err: { message: 'Connection terminated due to connection timeout' },
  },
  {
    name: 'timeout: node',
    engine: 'redis',
    cause: 'timeout',
    err: NODE('ETIMEDOUT', 'connect ETIMEDOUT 10.255.255.1:6379', -110),
  },
  {
    name: 'unreachable',
    engine: 'postgres',
    cause: 'unreachable',
    err: NODE('EHOSTUNREACH', 'connect EHOSTUNREACH 10.1.2.3:5432', -113),
  },

  // ── PostgreSQL ──
  {
    name: 'pg: wrong password',
    engine: 'postgres',
    cause: 'auth-failed',
    field: 'password',
    err: {
      name: 'error',
      code: '28P01',
      message: 'password authentication failed for user "postgres"',
    },
  },
  {
    name: 'pg: no password given (scram)',
    engine: 'postgres',
    cause: 'auth-failed',
    field: 'password',
    err: { message: 'SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string' },
  },
  {
    name: 'pg: database missing',
    engine: 'postgres',
    cause: 'database-missing',
    field: 'database',
    err: { code: '3D000', message: 'database "nodb" does not exist' },
  },
  {
    name: 'pg: no CONNECT privilege',
    engine: 'postgres',
    cause: 'permission',
    field: 'user',
    err: { code: '42501', message: 'permission denied for database "orders"' },
  },
  {
    name: 'pg: too many clients',
    engine: 'postgres',
    cause: 'too-many-connections',
    err: { code: '53300', message: 'sorry, too many clients already' },
  },
  {
    name: 'pg: reserved slots',
    engine: 'postgres',
    cause: 'too-many-connections',
    err: {
      code: '53300',
      message: 'remaining connection slots are reserved for non-replication superuser connections',
    },
  },
  {
    name: 'pg: starting up',
    engine: 'postgres',
    cause: 'starting-up',
    err: { code: '57P03', message: 'the database system is starting up' },
  },
  {
    name: 'pg: in recovery',
    engine: 'postgres',
    cause: 'starting-up',
    err: { code: '57P03', message: 'the database system is in recovery mode' },
  },
  {
    name: 'pg: pg_hba rejects this host',
    engine: 'postgres',
    cause: 'host-not-allowed',
    field: 'host',
    err: {
      code: '28000',
      message:
        'no pg_hba.conf entry for host "203.0.113.9", user "app", database "orders", no encryption',
    },
  },
  {
    name: 'pg: unsupported auth (gss)',
    engine: 'postgres',
    cause: 'auth-method',
    field: 'user',
    err: { code: '28000', message: 'GSSAPI authentication is not supported' },
  },
  {
    name: 'pg: server has no TLS',
    engine: 'postgres',
    cause: 'tls-not-supported',
    field: 'ssl',
    err: { message: 'The server does not support SSL connections' },
  },
  {
    name: 'pg: self-signed certificate',
    engine: 'postgres',
    cause: 'tls-untrusted',
    field: 'ssl',
    err: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT', message: 'self-signed certificate' },
  },
  {
    name: 'pg: unknown authority',
    engine: 'postgres',
    cause: 'tls-untrusted',
    err: {
      code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      message: 'unable to verify the first certificate',
    },
  },
  {
    name: 'pg: certificate for another host',
    engine: 'postgres',
    cause: 'tls-hostname',
    field: 'ssl',
    err: {
      code: 'ERR_TLS_CERT_ALTNAME_INVALID',
      message:
        "Hostname/IP does not match certificate's altnames: Host: db.example.com. is not in the cert's altnames: DNS:other.example.com",
    },
  },
  {
    name: 'pg: expired certificate',
    engine: 'postgres',
    cause: 'tls-expired',
    err: { code: 'CERT_HAS_EXPIRED', message: 'certificate has expired' },
  },
  {
    name: 'pg: closed at once',
    engine: 'postgres',
    cause: 'wrong-service',
    field: 'port',
    err: { message: 'Connection terminated unexpectedly' },
  },

  // ── MySQL / MariaDB ──
  {
    name: 'mysql: wrong password',
    engine: 'mysql',
    cause: 'auth-failed',
    field: 'password',
    err: {
      code: 'ER_ACCESS_DENIED_ERROR',
      errno: 1045,
      sqlstate: '28000',
      message: "Access denied for user 'root'@'localhost' (using password: YES)",
    },
  },
  {
    name: 'mysql: unknown database',
    engine: 'mysql',
    cause: 'database-missing',
    field: 'database',
    err: {
      code: 'ER_BAD_DB_ERROR',
      errno: 1049,
      sqlstate: '42000',
      message: "Unknown database 'nodb'",
    },
  },
  {
    name: 'mysql: no access to database',
    engine: 'mysql',
    cause: 'permission',
    err: {
      code: 'ER_DBACCESS_DENIED_ERROR',
      errno: 1044,
      message: "Access denied for user 'app'@'%' to database 'orders'",
    },
  },
  {
    name: 'mysql: too many connections',
    engine: 'mysql',
    cause: 'too-many-connections',
    err: { code: 'ER_CON_COUNT_ERROR', errno: 1040, message: 'Too many connections' },
  },
  {
    name: 'mysql: per-user limit',
    engine: 'mysql',
    cause: 'too-many-connections',
    err: { errno: 1226, message: "User 'app' has exceeded the 'max_user_connections' resource" },
  },
  {
    name: 'mysql: host not allowed',
    engine: 'mysql',
    cause: 'host-not-allowed',
    err: {
      code: 'ER_HOST_NOT_PRIVILEGED',
      errno: 1130,
      message: "Host '203.0.113.9' is not allowed to connect to this MariaDB server",
    },
  },
  {
    name: 'mysql: host blocked',
    engine: 'mysql',
    cause: 'host-not-allowed',
    err: {
      errno: 1129,
      message: "Host '203.0.113.9' is blocked because of many connection errors",
    },
  },
  {
    name: 'mysql: server has no TLS',
    engine: 'mysql',
    cause: 'tls-not-supported',
    field: 'ssl',
    err: { code: 'HANDSHAKE_NO_SSL_SUPPORT', message: 'Server does not support secure connection' },
  },
  {
    name: 'mysql: TLS required',
    engine: 'mysql',
    cause: 'tls-required',
    field: 'ssl',
    err: {
      code: 'ER_SECURE_TRANSPORT_REQUIRED',
      errno: 3159,
      message:
        'Connections using insecure transport are prohibited while --require_secure_transport=ON.',
    },
  },
  {
    name: 'mysql: unknown auth plugin',
    engine: 'mysql',
    cause: 'auth-method',
    field: 'user',
    err: {
      code: 'AUTH_SWITCH_PLUGIN_ERROR',
      message: 'Server requests authentication using unknown plugin sha256_password',
    },
  },
  {
    name: 'mysql: auth mode unsupported',
    engine: 'mysql',
    cause: 'auth-method',
    err: {
      code: 'ER_NOT_SUPPORTED_AUTH_MODE',
      errno: 1251,
      message: 'Client does not support authentication protocol requested by server',
    },
  },
  {
    name: 'mysql: shutting down',
    engine: 'mysql',
    cause: 'starting-up',
    err: { errno: 1053, message: 'Server shutdown in progress' },
  },
  {
    name: 'mysql: not a mysql server',
    engine: 'mysql',
    cause: 'wrong-service',
    err: {
      code: 'PROTOCOL_PACKETS_OUT_OF_ORDER',
      message: 'Packets out of order. Got: 71 Expected: 0',
    },
  },

  // ── ClickHouse ──
  {
    name: 'ch: wrong password',
    engine: 'clickhouse',
    cause: 'auth-failed',
    field: 'password',
    err: {
      name: 'ClickHouseError',
      code: '516',
      type: 'AUTHENTICATION_FAILED',
      message:
        'default: Authentication failed: password is incorrect, or there is no user with such name.',
    },
  },
  {
    name: 'ch: wrong password for a user that has one',
    engine: 'clickhouse',
    cause: 'auth-failed',
    err: {
      name: 'ClickHouseError',
      code: '194',
      type: 'REQUIRED_PASSWORD',
      message:
        'default: Authentication failed: password is incorrect, or there is no user with such name.',
    },
  },
  {
    name: 'pg: a MySQL server answered',
    engine: 'postgres',
    cause: 'wrong-service',
    err: { name: 'error', message: 'received invalid response: 59' },
  },
  {
    name: 'ch: unknown database',
    engine: 'clickhouse',
    cause: 'database-missing',
    err: { code: '81', type: 'UNKNOWN_DATABASE', message: 'Database nodb does not exist.' },
  },
  {
    name: 'ch: access denied',
    engine: 'clickhouse',
    cause: 'permission',
    err: { code: '497', type: 'ACCESS_DENIED', message: 'app: Not enough privileges.' },
  },
  {
    name: 'ch: too many queries',
    engine: 'clickhouse',
    cause: 'too-many-connections',
    err: {
      code: '202',
      type: 'TOO_MANY_SIMULTANEOUS_QUERIES',
      message: 'Too many simultaneous queries.',
    },
  },
  {
    name: 'ch: not ready',
    engine: 'clickhouse',
    cause: 'starting-up',
    err: { status: 503, message: 'Service Unavailable' },
  },
  {
    name: 'ch: plain http to an https port',
    engine: 'clickhouse',
    cause: 'tls-required',
    field: 'ssl',
    err: { status: 400, message: 'Client sent an HTTP request to an HTTPS server.' },
  },
  {
    name: 'ch: https to a plain port',
    engine: 'clickhouse',
    cause: 'tls-handshake',
    field: 'ssl',
    over: { ssl: true },
    err: {
      code: 'EPROTO',
      message:
        'write EPROTO 00A9:error:0A0000C6:SSL routines:tls_get_more_records:packet length too long',
    },
  },
  {
    name: 'ch: another service answers',
    engine: 'clickhouse',
    cause: 'wrong-service',
    err: { status: 404, message: 'Not Found' },
  },
  {
    name: 'ch: closed at once',
    engine: 'clickhouse',
    cause: 'wrong-service',
    err: NODE('ECONNRESET', 'socket hang up', undefined, 'read'),
  },

  // ── Redis ──
  {
    name: 'redis: password needed',
    engine: 'redis',
    cause: 'redis-auth',
    field: 'password',
    err: { name: 'ReplyError', message: 'NOAUTH Authentication required.' },
  },
  {
    name: 'redis: wrong password',
    engine: 'redis',
    cause: 'redis-auth',
    field: 'password',
    err: {
      name: 'ReplyError',
      message: 'WRONGPASS invalid username-password pair or user is disabled.',
    },
  },
  {
    name: 'redis: no permission',
    engine: 'redis',
    cause: 'redis-acl',
    field: 'user',
    err: {
      name: 'ReplyError',
      message: "NOPERM this user has no permissions to run the 'info' command",
    },
  },
  {
    name: 'redis: loading',
    engine: 'redis',
    cause: 'starting-up',
    err: { name: 'ReplyError', message: 'LOADING Redis is loading the dataset in memory' },
  },
  {
    name: 'redis: max clients',
    engine: 'redis',
    cause: 'too-many-connections',
    err: { name: 'ReplyError', message: 'ERR max number of clients reached' },
  },
  {
    name: 'redis: db index',
    engine: 'redis',
    cause: 'database-missing',
    field: 'database',
    over: { database: '99' },
    err: { name: 'ReplyError', message: 'ERR DB index is out of range' },
  },
  {
    name: 'redis: closed without a reason',
    engine: 'redis',
    cause: 'connection-closed',
    field: 'password',
    err: { message: 'Connection is closed.' },
  },
  {
    name: 'redis: tls expected',
    engine: 'redis',
    cause: 'tls-handshake',
    over: { ssl: true },
    err: {
      code: 'EPROTO',
      message: 'write EPROTO error:0A00010B:SSL routines::wrong version number',
    },
  },

  // ── OpenSearch ──
  {
    name: 'os: 401',
    engine: 'opensearch',
    cause: 'os-unauthorized',
    field: 'password',
    err: { name: 'ResponseError', status: 401, message: 'security_exception: Unauthorized' },
  },
  {
    name: 'os: 403',
    engine: 'opensearch',
    cause: 'os-forbidden',
    field: 'user',
    err: {
      name: 'ResponseError',
      status: 403,
      message: 'security_exception: no permissions for [cluster:monitor/main]',
    },
  },
  {
    name: 'os: 503',
    engine: 'opensearch',
    cause: 'os-not-ready',
    err: { name: 'ResponseError', status: 503, message: 'cluster_block_exception' },
  },
  {
    name: 'os: tls on a plain port',
    engine: 'opensearch',
    cause: 'tls-handshake',
    over: { ssl: true },
    err: {
      name: 'ConnectionError',
      message:
        'write EPROTO 00A9926EED7A0000:error:0A0000C6:SSL routines:tls_get_more_records:packet length too long:../ssl/record/methods/tls_common.c:660:',
    },
  },
  {
    name: 'os: self-signed',
    engine: 'opensearch',
    cause: 'tls-untrusted',
    over: { ssl: true },
    err: { name: 'ConnectionError', message: 'self signed certificate' },
  },
  {
    name: 'os: not opensearch',
    engine: 'opensearch',
    cause: 'wrong-service',
    err: { message: 'The server answered, but it is not OpenSearch (no version in its reply)' },
  },
  {
    name: 'os: closed at once',
    engine: 'opensearch',
    cause: 'wrong-service',
    err: { name: 'ConnectionError', message: 'socket hang up' },
  },

  // ── files ──
  {
    name: 'sqlite: missing file',
    engine: 'sqlite',
    cause: 'file-missing',
    field: 'database',
    err: { message: 'database file not found: /tmp/x.db' },
  },
  {
    name: 'sqlite: not a database',
    engine: 'sqlite',
    cause: 'file-not-database',
    err: { code: 'SQLITE_NOTADB', message: 'file is not a database' },
  },
  {
    name: 'sqlite: directory',
    engine: 'sqlite',
    cause: 'file-not-database',
    err: { message: 'not a file: /tmp' },
  },
  {
    name: 'sqlite: cannot open',
    engine: 'sqlite',
    cause: 'file-permission',
    err: { code: 'SQLITE_CANTOPEN', message: 'unable to open database file' },
  },
  {
    name: 'duckdb: missing file',
    engine: 'duckdb',
    cause: 'file-missing',
    err: { message: 'data file not found: /tmp/a.csv' },
  },

  // ── SSH tunnel ──
  {
    name: 'ssh: host key changed',
    engine: 'postgres',
    over: { ssh: true },
    cause: 'ssh-host-key',
    field: 'ssh',
    err: { source: 'ssh', hostKey: 'changed', message: 'Host denied (verification failed)' },
  },
  {
    name: 'ssh: host key refused',
    engine: 'postgres',
    over: { ssh: true },
    cause: 'ssh-host-key',
    err: { source: 'ssh', message: 'Host denied (verification failed)' },
  },
  {
    name: 'ssh: auth failed',
    engine: 'postgres',
    over: { ssh: true },
    cause: 'ssh-auth',
    field: 'ssh',
    err: {
      source: 'ssh',
      level: 'client-authentication',
      message: 'All configured authentication methods failed',
    },
  },
  {
    name: 'ssh: key not readable',
    engine: 'postgres',
    over: { ssh: true },
    cause: 'ssh-key',
    err: { source: 'ssh', message: 'Cannot parse privateKey: Unsupported key format' },
  },
  {
    name: 'ssh: passphrase missing',
    engine: 'postgres',
    over: { ssh: true },
    cause: 'ssh-key',
    err: {
      source: 'ssh',
      message: 'Encrypted private OpenSSH key detected, but no passphrase given',
    },
  },
  {
    name: 'ssh: jump host refused',
    engine: 'postgres',
    over: { ssh: true },
    cause: 'ssh-unreachable',
    field: 'ssh',
    err: { source: 'ssh', code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 203.0.113.5:22' },
  },
  {
    name: 'ssh: jump host name',
    engine: 'postgres',
    over: { ssh: true },
    cause: 'ssh-unreachable',
    err: { source: 'ssh', code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND bastion.invalid' },
  },
  {
    name: 'ssh: jump host silent',
    engine: 'postgres',
    over: { ssh: true },
    cause: 'ssh-timeout',
    err: { source: 'ssh', message: 'Timed out while waiting for handshake' },
  },
  {
    name: 'ssh: remote port refused',
    engine: 'postgres',
    over: { ssh: true },
    cause: 'ssh-forward-refused',
    field: 'host',
    err: {
      source: 'driver',
      forwardError: '(SSH) Channel open failure: Connection refused',
      message: 'Connection terminated unexpectedly',
    },
  },
  {
    name: 'ssh: forwarding prohibited',
    engine: 'mysql',
    over: { ssh: true },
    cause: 'ssh-forward-refused',
    err: {
      source: 'ssh',
      message: '(SSH) Channel open failure: open failed (administratively prohibited)',
    },
  },
  {
    name: 'ssh: socket closed through the tunnel',
    engine: 'postgres',
    over: { ssh: true },
    cause: 'ssh-forward-refused',
    err: { message: 'Connection terminated unexpectedly' },
  },
  {
    name: 'ssh: server answers through the tunnel',
    engine: 'postgres',
    over: { ssh: true },
    cause: 'auth-failed',
    err: { code: '28P01', message: 'password authentication failed for user "app"' },
  },

  // ── nothing matches ──
  {
    name: 'unknown',
    engine: 'postgres',
    cause: 'unknown',
    err: { message: 'something nobody has seen\nsecond line' },
  },
];

describe('diagnoseConnectError', () => {
  it.each(SAMPLES)('$name', ({ engine, err, cause, field, over }) => {
    const d = diagnoseConnectError(err, ctx({ engine, ...over }));
    expect(d.cause).toBe(cause);
    if (field) expect(d.field).toBe(field);
    expect(d.title.length).toBeGreaterThan(3);
    expect(d.detail.length).toBeGreaterThan(5);
    expect(d.fixes.length).toBeGreaterThan(0);
    // The raw error is always kept for the Details disclosure.
    expect(d.raw).toContain(err.message.slice(0, 20));
  });

  it('every cause the classifier can return is covered by a sample or a dedicated test', () => {
    const seen = new Set(SAMPLES.map((s) => s.cause));
    const expected: ConnectCause[] = [
      'dns',
      'refused',
      'timeout',
      'unreachable',
      'wrong-service',
      'tls-required',
      'tls-not-supported',
      'tls-untrusted',
      'tls-hostname',
      'tls-expired',
      'tls-handshake',
      'auth-failed',
      'auth-method',
      'host-not-allowed',
      'database-missing',
      'permission',
      'too-many-connections',
      'starting-up',
      'redis-auth',
      'redis-acl',
      'os-unauthorized',
      'os-forbidden',
      'os-not-ready',
      'ssh-host-key',
      'ssh-auth',
      'ssh-key',
      'ssh-unreachable',
      'ssh-timeout',
      'ssh-forward-refused',
      'file-missing',
      'file-not-database',
      'file-permission',
      'unknown',
    ];
    for (const cause of expected) expect(seen, cause).toContain(cause);
  });
});

describe('what the user reads', () => {
  it('names the host and port in the detail of a refused connection', () => {
    const d = diagnoseConnectError(
      NODE('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:5498'),
      ctx({ port: 5498 }),
    );
    expect(d.title).toBe('Nothing is listening there');
    expect(d.detail).toContain('db.example.com:5498');
  });

  it("points at the engine's usual port when the port is not it", () => {
    const d = diagnoseConnectError(NODE('ECONNREFUSED', 'x'), ctx({ port: 5433 }));
    expect(d.fixes[0]).toContain('5432');
  });

  it('names the user in an auth failure and the database in a missing one', () => {
    expect(diagnoseConnectError({ code: '28P01', message: 'x' }, ctx()).detail).toContain('"app"');
    expect(diagnoseConnectError({ code: '3D000', message: 'x' }, ctx()).detail).toContain(
      '"orders"',
    );
  });

  it('suggests turning TLS on when the pg_hba rule mentions encryption and TLS is off', () => {
    const msg = 'no pg_hba.conf entry for host "1.2.3.4", user "app", database "x", no encryption';
    const off = diagnoseConnectError({ code: '28000', message: msg }, ctx({ ssl: false }));
    expect(off.fixes.join(' ')).toMatch(/turn TLS on/i);
    const on = diagnoseConnectError({ code: '28000', message: msg }, ctx({ ssl: true }));
    expect(on.fixes.join(' ')).not.toMatch(/turn TLS on/i);
  });

  it('keeps the fixes short enough to read at a glance', () => {
    for (const s of SAMPLES) {
      const d = diagnoseConnectError(s.err, ctx({ engine: s.engine, ...s.over }));
      expect(d.fixes.length).toBeLessThanOrEqual(4);
      for (const f of d.fixes) expect(f.length, f).toBeLessThan(160);
      expect(d.title.length, d.title).toBeLessThan(60);
    }
  });
});

describe('secrets', () => {
  it('never shows the password, wherever the driver put it', () => {
    const secret = 'hunter2-secret';
    const messages = [
      `password authentication failed for user "app" (password: ${secret})`,
      `connect failed for postgres://app:${secret}@db.example.com:5432/orders`,
      `host=db user=app password=${secret} dbname=orders`,
      `Access denied (using password: YES) ${secret}`,
      `unrecognised: ${encodeURIComponent(`${secret}/x`)}`,
    ];
    for (const message of messages) {
      const d = diagnoseConnectError({ message }, ctx({ secrets: [secret, `${secret}/x`] }));
      const everything = [d.title, d.detail, d.raw, ...d.fixes].join('\n');
      expect(everything, message).not.toContain(secret);
      expect(everything, message).not.toContain(encodeURIComponent(`${secret}/x`));
    }
  });

  it('keeps "using password: YES", which says only that one was sent', () => {
    const d = diagnoseConnectError(
      {
        code: 'ER_ACCESS_DENIED_ERROR',
        errno: 1045,
        message: "Access denied for user 'root'@'localhost' (using password: YES)",
      },
      ctx({ engine: 'mysql' }),
    );
    expect(d.raw).toContain('using password: YES');
  });
});

describe('cluster status', () => {
  it('flags a red cluster and nothing else', () => {
    const red = diagnoseClusterStatus('red', ctx({ engine: 'opensearch' }));
    expect(red?.cause).toBe('os-cluster-red');
    expect(red?.fixes.join(' ')).toMatch(/allocation\/explain/);
    expect(diagnoseClusterStatus('yellow', ctx({ engine: 'opensearch' }))).toBeNull();
    expect(diagnoseClusterStatus('green', ctx({ engine: 'opensearch' }))).toBeNull();
    expect(diagnoseClusterStatus(null, ctx({ engine: 'opensearch' }))).toBeNull();
  });
});

describe('stageOfCause', () => {
  it('puts each cause on the step it belongs to', () => {
    expect(stageOfCause('tls-untrusted')).toBe('tls');
    expect(stageOfCause('tls-required')).toBe('tls');
    expect(stageOfCause('auth-failed')).toBe('login');
    expect(stageOfCause('redis-auth')).toBe('login');
    expect(stageOfCause('too-many-connections')).toBe('login');
    expect(stageOfCause('database-missing')).toBe('database');
    expect(stageOfCause('permission')).toBe('database');
    expect(stageOfCause('unknown')).toBe('login');
  });
});

describe('carrying a diagnosis through an IPC error', () => {
  const d = diagnoseConnectError(
    { code: '28P01', message: 'password authentication failed for user "app"' },
    ctx(),
  );

  it('round-trips, and leaves a readable message for anything that does not know the marker', () => {
    const message = encodeDiagnosedMessage(d);
    expect(message.startsWith(`${d.title}. ${d.detail}`)).toBe(true);
    const back = decodeDiagnosedMessage(message);
    expect(back.diagnosis).toEqual(d);
    expect(back.text).toBe(`${d.title}. ${d.detail}`);
  });

  it('survives the wrapper Electron adds around a rejected invoke', () => {
    const wrapped = `Error invoking remote method 'plasma:conn:connect': Error: ${encodeDiagnosedMessage(d)}`;
    expect(decodeDiagnosedMessage(wrapped).diagnosis?.cause).toBe('auth-failed');
  });

  it('ignores a message without the marker, and a damaged marker', () => {
    expect(decodeDiagnosedMessage('plain failure')).toEqual({
      diagnosis: null,
      text: 'plain failure',
    });
    const broken = `${d.title}\n[[plasma-diagnosis:{"cause":1]]`;
    expect(decodeDiagnosedMessage(broken).diagnosis).toBeNull();
    expect(decodeDiagnosedMessage(broken).text).toBe(d.title);
  });
});
