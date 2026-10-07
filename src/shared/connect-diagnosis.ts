import type { ErrorInfo } from './error-info';
import { redactSecrets } from './redact-secrets';

/**
 * Plain-language connection errors.
 *
 * A failed connect is classified into one cause with a title, what happened,
 * what to try, and the form field most likely to be wrong. Classification goes
 * by the codes the engines and Node really send (SQLSTATE, MySQL error numbers,
 * ClickHouse codes, Redis reply prefixes, HTTP statuses, errno names), and only
 * falls back to the message where an engine has no code for it (pg's
 * "timeout expired", ioredis' "Connection is closed").
 *
 * Pure: no Electron, no I/O. The worker and main attach the codes
 * (`error-info.ts`), the renderer shows the result.
 */

export type ConnectField = 'host' | 'port' | 'user' | 'password' | 'database' | 'ssl' | 'ssh';

export type ConnectCause =
  | 'dns'
  | 'refused'
  | 'timeout'
  | 'unreachable'
  | 'wrong-service'
  | 'connection-closed'
  | 'tls-required'
  | 'tls-not-supported'
  | 'tls-untrusted'
  | 'tls-hostname'
  | 'tls-expired'
  | 'tls-handshake'
  | 'auth-failed'
  | 'auth-method'
  | 'host-not-allowed'
  | 'database-missing'
  | 'permission'
  | 'too-many-connections'
  | 'starting-up'
  | 'redis-auth'
  | 'redis-acl'
  | 'os-unauthorized'
  | 'os-forbidden'
  | 'os-not-ready'
  | 'os-cluster-red'
  | 'ssh-host-key'
  | 'ssh-auth'
  | 'ssh-key'
  | 'ssh-unreachable'
  | 'ssh-timeout'
  | 'ssh-forward-refused'
  | 'file-missing'
  | 'file-not-database'
  | 'file-permission'
  | 'unknown';

export interface ConnectDiagnosis {
  cause: ConnectCause;
  /** A few words: what is wrong. */
  title: string;
  /** One or two sentences: what happened, specific to this connection. */
  detail: string;
  /** What to try, most likely first. */
  fixes: string[];
  /** The form field most likely to be wrong. */
  field?: ConnectField;
  /** The original error text with secrets removed, for the "Details" disclosure. */
  raw: string;
}

/** The failure as the classifier sees it. */
export interface ConnectErrorInput extends ErrorInfo {
  message: string;
}

export interface DiagnoseContext {
  engine: string;
  host: string;
  port: number;
  user?: string;
  database?: string;
  /** TLS is switched on for this connection. */
  ssl?: boolean;
  /** The connection goes through an SSH tunnel. */
  ssh?: boolean;
  /** Values that must never appear in the output (password, SSH password / passphrase). */
  secrets?: readonly string[];
}

const ENGINE_LABEL: Record<string, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  clickhouse: 'ClickHouse',
  redis: 'Redis',
  opensearch: 'OpenSearch',
  sqlite: 'SQLite',
  duckdb: 'DuckDB',
};

const DEFAULT_PORT: Record<string, number> = {
  postgres: 5432,
  mysql: 3306,
  clickhouse: 8123,
  redis: 6379,
  opensearch: 9200,
};

const FILE_ENGINES = new Set(['sqlite', 'duckdb']);

export function isFileEngine(engine: string): boolean {
  return FILE_ENGINES.has(engine);
}

const NETWORK_CODES = {
  dns: new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NODATA', 'EAI_NONAME', 'EAI_FAIL']),
  refused: new Set(['ECONNREFUSED']),
  timeout: new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNABORTED', 'UND_ERR_CONNECT_TIMEOUT']),
  unreachable: new Set(['EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EHOSTDOWN']),
  closed: new Set(['ECONNRESET', 'EPIPE', 'PROTOCOL_CONNECTION_LOST', 'UND_ERR_SOCKET']),
};

/** Node TLS verification codes (`err.code`), by what to tell the user. */
const TLS_CODES = {
  untrusted: new Set([
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UNABLE_TO_GET_ISSUER_CERT',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'CERT_UNTRUSTED',
    'CERT_REVOKED',
    'ERR_TLS_CERT_UNTRUSTED',
  ]),
  hostname: new Set(['ERR_TLS_CERT_ALTNAME_INVALID', 'HOSTNAME_MISMATCH']),
  expired: new Set(['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID']),
  handshake: new Set([
    'EPROTO',
    'ERR_SSL_WRONG_VERSION_NUMBER',
    'ERR_SSL_PACKET_LENGTH_TOO_LONG',
    'ERR_SSL_UNKNOWN_PROTOCOL',
    'ERR_TLS_HANDSHAKE_TIMEOUT',
    'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION',
    'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE',
  ]),
};

const MYSQL = {
  auth: new Set([1045, 1698]), // ER_ACCESS_DENIED_ERROR, ER_ACCESS_DENIED_NO_PASSWORD_ERROR
  db: new Set([1049]), // ER_BAD_DB_ERROR
  permission: new Set([1044, 1142, 1143]), // ER_DBACCESS_DENIED_ERROR, table / column denied
  tooMany: new Set([1040, 1203, 1226]), // ER_CON_COUNT_ERROR, ER_TOO_MANY_USER_CONNECTIONS, ER_USER_LIMIT_REACHED
  hostBlocked: new Set([1129, 1130]), // ER_HOST_IS_BLOCKED, ER_HOST_NOT_PRIVILEGED
  authMethod: new Set([1251, 2059]), // ER_NOT_SUPPORTED_AUTH_MODE, CR_AUTH_PLUGIN_CANNOT_LOAD
  tlsRequired: new Set([3159]), // ER_SECURE_TRANSPORT_REQUIRED
  starting: new Set([1053, 1927, 1047]), // ER_SERVER_SHUTDOWN, ER_CONNECTION_KILLED, ER_UNKNOWN_COM_ERROR (galera not ready)
};

const CLICKHOUSE = {
  // 516 AUTHENTICATION_FAILED; 194 REQUIRED_PASSWORD is what a wrong password for a user with one gives.
  auth: new Set(['516', 'AUTHENTICATION_FAILED', '194', 'REQUIRED_PASSWORD']),
  db: new Set(['81', 'UNKNOWN_DATABASE']),
  permission: new Set(['497', 'ACCESS_DENIED']),
  tooMany: new Set(['202', 'TOO_MANY_SIMULTANEOUS_QUERIES', '201', 'QUOTA_EXCEEDED']),
};

function upper(v: string | undefined): string {
  return (v ?? '').toUpperCase();
}

function firstLine(text: string): string {
  return (text.split('\n').find((l) => l.trim()) ?? text).trim();
}

/** Where the user was trying to get to, for messages. */
function target(ctx: DiagnoseContext): string {
  return `${ctx.host}:${ctx.port}`;
}

function engineName(ctx: DiagnoseContext): string {
  return ENGINE_LABEL[ctx.engine] ?? 'the database';
}

type Core = Omit<ConnectDiagnosis, 'raw'>;

// ── causes ───────────────────────────────────────────────────────────────

function dns(ctx: DiagnoseContext, temporary: boolean): Core {
  return {
    cause: 'dns',
    title: temporary ? 'The name server did not answer' : 'Host not found',
    detail: temporary
      ? `Looking up "${ctx.host}" failed because no DNS server answered.`
      : `"${ctx.host}" does not resolve to an address.`,
    fixes: temporary
      ? [
          'Check your network connection and try again.',
          'If you are on a VPN, make sure it is connected.',
          'Try the server’s IP address instead of its name.',
        ]
      : [
          'Check the host name for typos.',
          'If it is an internal name, connect to the VPN first.',
          'Try the server’s IP address instead of its name.',
        ],
    field: 'host',
  };
}

function refused(ctx: DiagnoseContext): Core {
  const usual = DEFAULT_PORT[ctx.engine];
  return {
    cause: 'refused',
    title: 'Nothing is listening there',
    detail: `${target(ctx)} refused the connection.`,
    fixes: [
      usual && ctx.port !== usual
        ? `Check the port: ${engineName(ctx)} usually listens on ${usual}.`
        : 'Check the port.',
      'Make sure the server is running and accepts connections from this machine.',
      'If the server runs in Docker, check the published port.',
    ],
    field: 'port',
  };
}

function timeout(ctx: DiagnoseContext): Core {
  return {
    cause: 'timeout',
    title: 'The server did not answer',
    detail: `${target(ctx)} did not reply in time.`,
    fixes: [
      'Check the host and port.',
      'A firewall or VPN may be dropping the traffic: connect to the VPN, or ask for this machine to be allowed.',
      'If the server is only reachable from a jump host, use an SSH tunnel.',
      // A server that never answers the handshake looks the same: TLS spoken at a plain port.
      ...(ctx.ssl ? ['If the server does not use TLS, turn TLS off.'] : []),
    ],
    field: 'host',
  };
}

function unreachable(ctx: DiagnoseContext): Core {
  return {
    cause: 'unreachable',
    title: 'No route to the server',
    detail: `This machine has no network path to ${target(ctx)}.`,
    fixes: ['Check your network or VPN connection.', 'Check the host name or IP address.'],
    field: 'host',
  };
}

function wrongService(ctx: DiagnoseContext, what: 'closed' | 'other'): Core {
  const fixes = [
    `Check the port: something other than ${engineName(ctx)} may be listening on ${ctx.port}.`,
  ];
  if (!ctx.ssl) fixes.push('If the server expects TLS, turn TLS on.');
  else fixes.push('If the server is plain (no TLS), turn TLS off.');
  return {
    cause: 'wrong-service',
    title: `That does not look like ${engineName(ctx)}`,
    detail:
      what === 'closed'
        ? `${target(ctx)} accepted the connection and closed it straight away.`
        : `${target(ctx)} answered, but not like ${engineName(ctx)}.`,
    fixes,
    field: 'port',
  };
}

function tls(
  cause:
    | 'tls-required'
    | 'tls-not-supported'
    | 'tls-untrusted'
    | 'tls-hostname'
    | 'tls-expired'
    | 'tls-handshake',
  ctx: DiagnoseContext,
  reason?: string,
): Core {
  switch (cause) {
    case 'tls-required':
      return {
        cause,
        title: 'The server requires TLS',
        detail: `${target(ctx)} only accepts encrypted connections.`,
        fixes: [
          'Turn TLS on for this connection (mode "require", or "verify" with the server’s CA).',
          'Check with the server admin which TLS mode it expects.',
        ],
        field: 'ssl',
      };
    case 'tls-not-supported':
      return {
        cause,
        title: 'The server does not support TLS',
        detail: `${target(ctx)} answered that it cannot encrypt the connection.`,
        fixes: [
          'Turn TLS off for this connection.',
          'Or enable TLS on the server, if the data is sensitive.',
        ],
        field: 'ssl',
      };
    case 'tls-untrusted':
      return {
        cause,
        title: 'The server’s certificate is not trusted',
        detail: reason
          ? `The certificate was refused: ${reason}.`
          : 'The certificate was not signed by an authority this machine trusts.',
        fixes: [
          'Add the server’s CA certificate in the TLS section.',
          'For a test server only: use TLS mode "require", which does not verify the certificate.',
        ],
        field: 'ssl',
      };
    case 'tls-hostname':
      return {
        cause,
        title: 'The certificate is for a different host name',
        detail: `The certificate does not name "${ctx.host}".`,
        fixes: [
          'Connect with the host name written on the certificate.',
          'Or use TLS mode "verify-ca", which checks the authority but not the name.',
        ],
        field: 'ssl',
      };
    case 'tls-expired':
      return {
        cause,
        title: 'The server’s certificate has expired',
        detail: reason ?? 'The certificate is outside its validity dates.',
        fixes: [
          'Ask the server admin to renew the certificate.',
          'Check that this machine’s clock is right.',
        ],
        field: 'ssl',
      };
    default:
      return {
        cause: 'tls-handshake',
        title: 'The TLS handshake failed',
        detail: `${target(ctx)} does not speak TLS the way this connection asked.`,
        fixes: [
          ctx.ssl
            ? 'If the server is plain (no TLS), turn TLS off.'
            : 'If the server expects TLS, turn TLS on.',
          'Check the port: TLS is often on a different port.',
        ],
        field: 'ssl',
      };
  }
}

function authFailed(ctx: DiagnoseContext, noPassword = false): Core {
  const who = ctx.user ? `"${ctx.user}"` : 'this user';
  return {
    cause: 'auth-failed',
    title: noPassword ? 'No password was sent' : 'Login was refused',
    detail: noPassword
      ? `${engineName(ctx)} wants a password for ${who} and none was provided.`
      : `${engineName(ctx)} did not accept the user name or password for ${who}.`,
    fixes: noPassword
      ? ['Enter the password for this connection.']
      : [
          'Re-type the password.',
          'Check the user name: the server does not say which of the two is wrong.',
          'Check that the user may log in from this machine.',
        ],
    field: 'password',
  };
}

function authMethod(ctx: DiagnoseContext, reason?: string): Core {
  return {
    cause: 'auth-method',
    title: 'The login method is not supported',
    detail: reason
      ? `The server asked for a login method Plasma cannot use: ${reason}.`
      : 'The server asked for a login method Plasma cannot use.',
    fixes: [
      ctx.engine === 'postgres'
        ? 'Ask the admin for a password login (scram-sha-256 or md5); gss / sspi / peer logins are not supported.'
        : 'Ask the admin for a password login the client supports (e.g. caching_sha2_password or mysql_native_password).',
      'Check whether the user may use password login at all.',
    ],
    field: 'user',
  };
}

function hostNotAllowed(ctx: DiagnoseContext, encryptionHint: boolean): Core {
  const fixes = [
    'Ask the server admin to allow this machine for this user and database.',
    'Check the user name and database: access rules are per user and database.',
  ];
  if (encryptionHint && !ctx.ssl)
    fixes.unshift('The rule may need an encrypted connection: turn TLS on.');
  return {
    cause: 'host-not-allowed',
    title: 'The server does not allow this login from here',
    detail: `${engineName(ctx)} has no rule that lets ${ctx.user ? `"${ctx.user}"` : 'this user'} in from this machine.`,
    fixes,
    field: 'host',
  };
}

function databaseMissing(ctx: DiagnoseContext): Core {
  const name = ctx.database ? `"${ctx.database}"` : 'that database';
  if (ctx.engine === 'redis') {
    return {
      cause: 'database-missing',
      title: 'No such Redis database',
      detail: ctx.database
        ? `The server has no database number ${ctx.database}.`
        : 'The server has no such database number.',
      fixes: ['Use a number from 0 to 15 (the server’s "databases" setting).'],
      field: 'database',
    };
  }
  return {
    cause: 'database-missing',
    title: 'Database not found',
    detail: `${engineName(ctx)} has no database called ${ctx.database ? `"${ctx.database}"` : 'that name'}.`,
    fixes: [
      `Check the spelling of ${name}.`,
      ctx.engine === 'postgres'
        ? 'Connect to "postgres" first and list the databases there.'
        : 'Leave the database empty to connect first, then pick one.',
      'Create the database, or ask the admin to.',
    ],
    field: 'database',
  };
}

function permission(ctx: DiagnoseContext): Core {
  return {
    cause: 'permission',
    title: 'No permission to open this database',
    detail: `${ctx.user ? `"${ctx.user}"` : 'This user'} may not use ${ctx.database ? `"${ctx.database}"` : 'this database'}.`,
    fixes:
      ctx.engine === 'postgres'
        ? [
            'Ask the admin for CONNECT: GRANT CONNECT ON DATABASE <name> TO <user>.',
            'Or connect to a database this user may use.',
          ]
        : [
            'Ask the admin to grant this user access to the database.',
            'Or connect to a database this user may use.',
          ],
    field: 'user',
  };
}

function tooManyConnections(ctx: DiagnoseContext): Core {
  return {
    cause: 'too-many-connections',
    title: 'The server has no free connections',
    detail: `${engineName(ctx)} is at its limit of simultaneous connections.`,
    fixes: [
      'Close other sessions (or other Plasma windows) and try again.',
      'Ask the admin to raise the limit or to stop idle clients.',
    ],
  };
}

function startingUp(ctx: DiagnoseContext): Core {
  return {
    cause: 'starting-up',
    title: 'The server is not ready yet',
    detail: `${engineName(ctx)} is starting, recovering or shutting down.`,
    fixes: ['Wait a minute and try again.', 'If it never finishes, check the server’s log.'],
  };
}

function redisAuth(ctx: DiagnoseContext, kind: 'needed' | 'wrong'): Core {
  return {
    cause: 'redis-auth',
    title: kind === 'needed' ? 'This Redis needs a password' : 'Redis refused the login',
    detail:
      kind === 'needed'
        ? 'The server requires authentication and none was sent.'
        : `Redis did not accept the user name or password${ctx.user ? ` for "${ctx.user}"` : ''}.`,
    fixes:
      kind === 'needed'
        ? ['Enter the password (and the user name, if the server uses ACLs).']
        : [
            'Re-type the password.',
            'With ACLs, check the user name and that the user is enabled (ACL LIST).',
            'Leave both empty if the server has no password.',
          ],
    field: 'password',
  };
}

function redisAcl(ctx: DiagnoseContext): Core {
  return {
    cause: 'redis-acl',
    title: 'This Redis user lacks permissions',
    detail: `${ctx.user ? `"${ctx.user}"` : 'The user'} is not allowed to run a command Plasma needs.`,
    fixes: [
      'Ask the admin to extend the ACL (Plasma needs at least +info +scan +type +ttl and read commands).',
      'Or connect with a user that has fuller access.',
    ],
    field: 'user',
  };
}

function osUnauthorized(ctx: DiagnoseContext): Core {
  return {
    cause: 'os-unauthorized',
    title: 'OpenSearch refused the login',
    detail: `${target(ctx)} answered 401: it did not accept the credentials.`,
    fixes: [
      'Check the user name and password.',
      'If the cluster uses an API key, a token or AWS signing, pick that authentication instead.',
    ],
    field: 'password',
  };
}

function osForbidden(ctx: DiagnoseContext): Core {
  return {
    cause: 'os-forbidden',
    title: 'This user may not use the cluster',
    detail: `${target(ctx)} answered 403: the login is valid but has no permission.`,
    fixes: [
      'Ask the admin for a role that allows cluster:monitor/main and read access to the indices you need.',
      'Or connect with another user.',
    ],
    field: 'user',
  };
}

function osNotReady(ctx: DiagnoseContext): Core {
  return {
    cause: 'os-not-ready',
    title: 'The cluster is not ready',
    detail: `${target(ctx)} answered 503: no master is elected yet, or the node is still starting.`,
    fixes: ['Wait a minute and try again.', 'Check the cluster’s log if it stays like this.'],
  };
}

function clusterRed(): Core {
  return {
    cause: 'os-cluster-red',
    title: 'The cluster is red',
    detail:
      'Connected, but some primary shards are not assigned: data may be missing or unavailable.',
    fixes: [
      'Run GET _cluster/allocation/explain in Dev Tools to see why a shard is unassigned.',
      'Check disk space and that every node has joined the cluster.',
    ],
  };
}

function ssh(
  cause: Extract<
    ConnectCause,
    | 'ssh-host-key'
    | 'ssh-auth'
    | 'ssh-key'
    | 'ssh-unreachable'
    | 'ssh-timeout'
    | 'ssh-forward-refused'
  >,
  ctx: DiagnoseContext,
  extra?: string,
): Core {
  switch (cause) {
    case 'ssh-host-key':
      return {
        cause,
        title: 'The SSH host key was not accepted',
        detail:
          extra === 'changed'
            ? 'The jump host presented a different key than the one saved for it.'
            : 'The jump host’s key was not accepted.',
        fixes:
          extra === 'changed'
            ? [
                'If the server was rebuilt or reinstalled, a new key is expected: accept it when asked.',
                'If nothing changed, do not connect: someone may be intercepting the connection.',
              ]
            : ['Connect again and accept the key if the fingerprint is the one you expect.'],
        field: 'ssh',
      };
    case 'ssh-auth':
      return {
        cause,
        title: 'SSH login failed',
        detail: 'The jump host did not accept the SSH user name, password or key.',
        fixes: [
          'Check the SSH user name.',
          'Check the SSH password, or the key file and its passphrase.',
          'Make sure the key is authorised on the jump host (authorized_keys).',
        ],
        field: 'ssh',
      };
    case 'ssh-key':
      return {
        cause,
        title: 'The SSH key could not be used',
        detail: extra ?? 'The private key could not be read.',
        fixes: [
          'Pick the private key file, not the .pub file.',
          'Enter the key’s passphrase if it has one.',
          'Check the key file can be read by this user.',
        ],
        field: 'ssh',
      };
    case 'ssh-unreachable':
      return {
        cause,
        title: 'The SSH host could not be reached',
        detail: extra ?? 'No connection to the jump host could be made.',
        fixes: [
          'Check the SSH host and port.',
          'Check your network or VPN.',
          'Check that the jump host accepts SSH from this machine.',
        ],
        field: 'ssh',
      };
    case 'ssh-timeout':
      return {
        cause,
        title: 'The SSH host did not answer',
        detail: 'The jump host did not complete the SSH handshake in time.',
        fixes: [
          'Check the SSH host and port.',
          'A firewall may be dropping the traffic: check the VPN or ask for this machine to be allowed.',
        ],
        field: 'ssh',
      };
    default:
      return {
        cause: 'ssh-forward-refused',
        title: 'The jump host could not reach the database',
        detail: `SSH connected, but the jump host could not open ${target(ctx)}${extra ? `: ${extra}` : '.'}`,
        fixes: [
          'Check the database host and port as the jump host sees them (often 127.0.0.1 or a private IP).',
          'Check that the database is running and accepts connections from the jump host.',
          'The jump host’s sshd must allow forwarding (AllowTcpForwarding yes).',
        ],
        field: 'host',
      };
  }
}

function file(
  cause: 'file-missing' | 'file-not-database' | 'file-permission',
  ctx: DiagnoseContext,
): Core {
  const name = engineName(ctx);
  switch (cause) {
    case 'file-missing':
      return {
        cause,
        title: 'File not found',
        detail: `There is no file at ${ctx.database ? `"${ctx.database}"` : 'that path'}.`,
        fixes: ['Check the path.', 'Pick the file again, or create a new database file.'],
        field: 'database',
      };
    case 'file-not-database':
      return {
        cause,
        title: `That is not a ${name} database`,
        detail: `${ctx.database ? `"${ctx.database}"` : 'The file'} is not a ${name} database file (or is damaged).`,
        fixes: ['Pick the right file.', 'If it is encrypted or damaged, restore it from a backup.'],
        field: 'database',
      };
    default:
      return {
        cause,
        title: 'The file cannot be opened',
        detail: `${ctx.database ? `"${ctx.database}"` : 'The file'} exists or its folder does not, or this user has no permission.`,
        fixes: [
          'Check that the folder exists and this user may read the file.',
          'If another program holds the file locked, close it.',
        ],
        field: 'database',
      };
  }
}

function unknown(input: ConnectErrorInput, ctx: DiagnoseContext): Core {
  const line = input.message.trim().slice(0, 400) || 'The connection failed.';
  const fixes = [
    'Check the host, port, user name and password.',
    'Open "Details" and copy the exact error if you need help.',
  ];
  if (ctx.engine === 'redis' && /connection is closed/i.test(input.message)) {
    return {
      cause: 'connection-closed',
      title: 'Redis closed the connection',
      detail: 'The server closed the connection before it was ready. It did not say why.',
      fixes: [
        'Check the user name and password (leave both empty if the server has no password).',
        'Check the host and port.',
        ctx.ssl
          ? 'If the server is plain (no TLS), turn TLS off.'
          : 'If the server expects TLS, turn TLS on.',
      ],
      field: 'password',
    };
  }
  return { cause: 'unknown', title: 'Could not connect', detail: line, fixes };
}

// ── classification ───────────────────────────────────────────────────────

const RE = {
  tlsNotSupported: /does not support ssl|server does not support secure connection|no ssl support/i,
  tlsRequired:
    /ssl.*(is )?required|requires? ssl|requires? (a )?secure|only (accepts )?(ssl|tls|encrypted|secure)|insecure transport|no encryption|ssl off|must use ssl|tls.*required/i,
  selfSigned:
    /self[- ]signed certificate|unable to verify the first certificate|unable to get (local )?issuer certificate/i,
  altname: /hostname\/ip does not match|altnames|does not match certificate/i,
  expired: /certificate has expired|certificate is not yet valid|cert(ificate)? .*expired/i,
  handshake:
    /wrong version number|packet length too long|unknown protocol|ssl routines|tlsv1 alert|handshake failure|eproto/i,
  pgHba: /no pg_hba\.conf entry|pg_hba/i,
  pgStarting:
    /database system is (starting up|shutting down|in recovery)|in recovery mode|cannot connect now/i,
  pgTooMany: /too many clients|remaining connection slots|connection limit exceeded/i,
  mysqlTooMany: /too many connections|max_user_connections/i,
  authPlugin:
    /auth(entication)? (plugin|method|protocol)|unknown plugin|caching_sha2|sha256_password|scram|\bsasl\b|\bgss|sspi|kerberos|md5.*not supported/i,
  passwordMissing: /client password must be a string|password must be a string/i,
  timeoutText: /timeout expired|timed out|timeout/i,
  closedText:
    /connection terminated unexpectedly|socket hang up|connection is closed|connection lost|server closed the connection|other side closed|read econnreset|packets out of order/i,
  notFile: /file is not a database|not a database|not a file/i,
  missingFile: /not found|no such file|enoent/i,
  openFile: /unable to open database file|eacces|eperm|permission denied/i,
  redisNoAuth: /\bnoauth\b|authentication required/i,
  redisWrongPass:
    /\bwrongpass\b|invalid username-password|invalid password|user is disabled|\bauth\b.*(failed|invalid)/i,
  redisNoPerm: /\bnoperm\b|no permissions? to (run|access)/i,
  redisLoading: /\bloading\b|masterdown|\bbusy\b|tryagain/i,
  redisMaxClients: /max number of clients/i,
  redisDb: /db index is out of range|invalid db index/i,
  notOpenSearch: /not opensearch|not an? elasticsearch|no version in its reply/i,
};

function classifySsh(input: ConnectErrorInput, ctx: DiagnoseContext): Core {
  const msg = input.message;
  const code = upper(input.code);
  if (input.hostKey || /host denied|host key|verification failed/i.test(msg)) {
    return ssh('ssh-host-key', ctx, input.hostKey);
  }
  if (
    input.level === 'client-authentication' ||
    /all configured authentication methods failed|authentication failure|permission denied \(/i.test(
      msg,
    )
  ) {
    return ssh('ssh-auth', ctx);
  }
  if (
    /cannot parse privatekey|no passphrase given|bad passphrase|incorrect passphrase|passphrase|unsupported key format|private key|ssh key/i.test(
      msg,
    )
  ) {
    return ssh('ssh-key', ctx, firstLine(msg));
  }
  if (
    input.forwardError ||
    /channel open failure|administratively prohibited|open failed|forwardout/i.test(msg)
  ) {
    return ssh('ssh-forward-refused', ctx, input.forwardError ?? firstLine(msg));
  }
  if (
    input.level === 'client-timeout' ||
    NETWORK_CODES.timeout.has(code) ||
    /timed out|handshake/i.test(msg)
  ) {
    return ssh('ssh-timeout', ctx);
  }
  if (
    NETWORK_CODES.refused.has(code) ||
    NETWORK_CODES.dns.has(code) ||
    NETWORK_CODES.unreachable.has(code) ||
    NETWORK_CODES.closed.has(code) ||
    input.level === 'client-socket'
  ) {
    const why = NETWORK_CODES.dns.has(code)
      ? 'The SSH host name does not resolve.'
      : NETWORK_CODES.refused.has(code)
        ? 'The SSH host refused the connection.'
        : undefined;
    return ssh('ssh-unreachable', ctx, why);
  }
  return ssh('ssh-unreachable', ctx, firstLine(msg));
}

function classifyFile(input: ConnectErrorInput, ctx: DiagnoseContext): Core | null {
  const msg = input.message;
  const code = upper(input.code);
  // DuckDB's "extension is not installed" errors have their own wording and a marker the UI looks for.
  if (/extension/i.test(msg)) return null;
  if (code === 'ENOENT' || /database file not found|data file not found|no such file/i.test(msg)) {
    return file('file-missing', ctx);
  }
  if (code === 'SQLITE_NOTADB' || RE.notFile.test(msg)) return file('file-not-database', ctx);
  if (
    code === 'EACCES' ||
    code === 'EPERM' ||
    code === 'SQLITE_CANTOPEN' ||
    RE.openFile.test(msg)
  ) {
    return file('file-permission', ctx);
  }
  return null;
}

/** pg: the SQLSTATE is `code`; mysql2: `code` is a name and `errno` a number. */
function classifyDriver(input: ConnectErrorInput, ctx: DiagnoseContext): Core | null {
  const msg = input.message;
  const code = upper(input.code);
  const sqlstate = upper(input.sqlstate);
  const errno = input.errno !== undefined && input.errno > 0 ? input.errno : undefined;
  const status = input.status;

  switch (ctx.engine) {
    case 'postgres': {
      if (code === '28P01') return authFailed(ctx);
      if (code === '28000') {
        if (RE.pgHba.test(msg)) return hostNotAllowed(ctx, /no encryption|ssl off|ssl/i.test(msg));
        if (/role .* does not exist|does not exist/i.test(msg)) return authFailed(ctx);
        if (RE.authPlugin.test(msg)) return authMethod(ctx, firstLine(msg));
        return authFailed(ctx);
      }
      if (code === '3D000') return databaseMissing(ctx);
      if (code === '42501' || /permission denied for database/i.test(msg)) return permission(ctx);
      if (code === '53300' || RE.pgTooMany.test(msg)) return tooManyConnections(ctx);
      if (code === '57P03' || code === '57P01' || code === '57P02' || RE.pgStarting.test(msg)) {
        return startingUp(ctx);
      }
      if (RE.passwordMissing.test(msg)) return authFailed(ctx, true);
      if (RE.authPlugin.test(msg) && /sasl|scram|auth|gss|sspi|md5|kerberos/i.test(msg)) {
        return authMethod(ctx, firstLine(msg));
      }
      // A server that is not Postgres answers the startup packet with its own bytes.
      if (code === '08P01' || /received invalid response/i.test(msg)) {
        return wrongService(ctx, 'other');
      }
      return null;
    }
    case 'mysql': {
      if (errno !== undefined) {
        if (MYSQL.auth.has(errno)) return authFailed(ctx);
        if (MYSQL.db.has(errno)) return databaseMissing(ctx);
        if (MYSQL.permission.has(errno)) return permission(ctx);
        if (MYSQL.tooMany.has(errno)) return tooManyConnections(ctx);
        if (MYSQL.hostBlocked.has(errno)) return hostNotAllowed(ctx, false);
        if (MYSQL.authMethod.has(errno)) return authMethod(ctx, firstLine(msg));
        if (MYSQL.tlsRequired.has(errno)) return tls('tls-required', ctx);
        if (MYSQL.starting.has(errno)) return startingUp(ctx);
      }
      if (code === 'HANDSHAKE_NO_SSL_SUPPORT') return tls('tls-not-supported', ctx);
      if (code === 'ER_SECURE_TRANSPORT_REQUIRED') return tls('tls-required', ctx);
      if (code === 'AUTH_SWITCH_PLUGIN_ERROR' || code === 'ER_NOT_SUPPORTED_AUTH_MODE') {
        return authMethod(ctx, firstLine(msg));
      }
      if (code === 'ER_ACCESS_DENIED_ERROR') return authFailed(ctx);
      if (code === 'ER_BAD_DB_ERROR') return databaseMissing(ctx);
      if (code === 'ER_DBACCESS_DENIED_ERROR') return permission(ctx);
      if (code === 'ER_CON_COUNT_ERROR' || RE.mysqlTooMany.test(msg))
        return tooManyConnections(ctx);
      if (code === 'PROTOCOL_PACKETS_OUT_OF_ORDER' || /packets out of order/i.test(msg)) {
        return wrongService(ctx, 'other');
      }
      if (sqlstate === '28000') return authFailed(ctx);
      return null;
    }
    case 'clickhouse': {
      const type = upper(input.type);
      if (CLICKHOUSE.auth.has(code) || CLICKHOUSE.auth.has(type) || status === 401) {
        return authFailed(ctx);
      }
      if (/authentication failed/i.test(msg)) return authFailed(ctx);
      if (CLICKHOUSE.db.has(code) || CLICKHOUSE.db.has(type)) return databaseMissing(ctx);
      if (CLICKHOUSE.permission.has(code) || CLICKHOUSE.permission.has(type) || status === 403) {
        return permission(ctx);
      }
      if (CLICKHOUSE.tooMany.has(code) || CLICKHOUSE.tooMany.has(type))
        return tooManyConnections(ctx);
      if (status === 503 || /not ready|starting up|is loading/i.test(msg)) return startingUp(ctx);
      if (status === 400 && /http request to an https server/i.test(msg)) {
        return tls('tls-required', ctx);
      }
      if (status === 404 || status === 405) return wrongService(ctx, 'other');
      return null;
    }
    case 'redis': {
      if (RE.redisNoAuth.test(msg)) return redisAuth(ctx, 'needed');
      if (RE.redisWrongPass.test(msg)) return redisAuth(ctx, 'wrong');
      if (RE.redisNoPerm.test(msg)) return redisAcl(ctx);
      if (RE.redisMaxClients.test(msg)) return tooManyConnections(ctx);
      if (RE.redisLoading.test(msg)) return startingUp(ctx);
      if (RE.redisDb.test(msg)) return databaseMissing(ctx);
      return null;
    }
    case 'opensearch': {
      if (status === 401) return osUnauthorized(ctx);
      if (status === 403) return osForbidden(ctx);
      if (status === 503) return osNotReady(ctx);
      if (RE.notOpenSearch.test(msg)) return wrongService(ctx, 'other');
      if (status === 404 || status === 405) return wrongService(ctx, 'other');
      return null;
    }
    default:
      return null;
  }
}

/** Node network and TLS codes: the same for every engine that goes over TCP. */
function classifyTransport(input: ConnectErrorInput, ctx: DiagnoseContext): Core | null {
  const msg = input.message;
  const code = upper(input.code);

  if (NETWORK_CODES.dns.has(code) || /getaddrinfo (ENOTFOUND|EAI_)/i.test(msg)) {
    return dns(ctx, code === 'EAI_AGAIN' || /EAI_AGAIN/.test(msg));
  }
  if (NETWORK_CODES.refused.has(code) || /\bECONNREFUSED\b/.test(msg)) return refused(ctx);
  if (NETWORK_CODES.unreachable.has(code) || /\b(EHOSTUNREACH|ENETUNREACH)\b/.test(msg)) {
    return unreachable(ctx);
  }

  if (TLS_CODES.untrusted.has(code) || RE.selfSigned.test(msg)) {
    return tls('tls-untrusted', ctx, RE.selfSigned.test(msg) ? firstLine(msg) : undefined);
  }
  if (TLS_CODES.hostname.has(code) || RE.altname.test(msg)) return tls('tls-hostname', ctx);
  if (TLS_CODES.expired.has(code) || RE.expired.test(msg)) return tls('tls-expired', ctx);
  if (RE.tlsNotSupported.test(msg)) return tls('tls-not-supported', ctx);
  if (RE.tlsRequired.test(msg)) return tls('tls-required', ctx);
  if (TLS_CODES.handshake.has(code) || RE.handshake.test(msg)) return tls('tls-handshake', ctx);

  if (
    NETWORK_CODES.timeout.has(code) ||
    /timeout expired|connection terminated due to connection timeout|connect etimedout|timed out/i.test(
      msg,
    )
  ) {
    return timeout(ctx);
  }
  return null;
}

function classify(input: ConnectErrorInput, ctx: DiagnoseContext): Core {
  if (isFileEngine(ctx.engine)) return classifyFile(input, ctx) ?? unknown(input, ctx);

  // Failures on the way in: the SSH tunnel itself.
  if (input.source === 'ssh') return classifySsh(input, ctx);

  // The jump host told us why the database could not be reached.
  if (ctx.ssh && input.forwardError) return ssh('ssh-forward-refused', ctx, input.forwardError);

  // What the server itself said beats what Node says about the socket.
  const driver = classifyDriver(input, ctx);
  if (driver) return driver;

  const transport = classifyTransport(input, ctx);
  if (transport) return transport;

  // The socket was closed before the server said anything: through a tunnel
  // that is the jump host failing to open the remote port, otherwise it is
  // usually the wrong kind of server (or TLS expected / not expected).
  const code = upper(input.code);
  if (NETWORK_CODES.closed.has(code) || RE.closedText.test(input.message)) {
    if (ctx.ssh) return ssh('ssh-forward-refused', ctx);
    if (ctx.engine !== 'redis') return wrongService(ctx, 'closed');
  }
  return unknown(input, ctx);
}

/**
 * Turn a failed connect into a cause, a title, what happened and what to try.
 * Never contains a secret from `ctx.secrets`, nor a password in a URL or
 * `password=` pair of the original message.
 */
export function diagnoseConnectError(
  input: ConnectErrorInput,
  ctx: DiagnoseContext,
): ConnectDiagnosis {
  const secrets = ctx.secrets ?? [];
  const core = classify(input, ctx);
  const clean = (text: string) => redactSecrets(text, secrets);
  return {
    cause: core.cause,
    title: clean(core.title),
    detail: clean(core.detail),
    fixes: core.fixes.map(clean),
    ...(core.field ? { field: core.field } : {}),
    raw: clean(rawText(input)),
  };
}

/** The original error, for the "Details" disclosure: the message plus the codes that came with it. */
export function rawText(input: ConnectErrorInput): string {
  const bits = [
    input.code && `code ${input.code}`,
    input.errno !== undefined && `errno ${input.errno}`,
    input.sqlstate && `SQLSTATE ${input.sqlstate}`,
    input.status !== undefined && `HTTP ${input.status}`,
    input.type,
  ].filter(Boolean);
  const head = input.message.trim();
  return bits.length > 0 ? `${head}\n(${bits.join(', ')})` : head;
}

/** A non-fatal cluster state worth a note on a successful connection. */
export function diagnoseClusterStatus(
  status: string | null | undefined,
  ctx: DiagnoseContext,
): ConnectDiagnosis | null {
  if (status !== 'red') return null;
  const core = clusterRed();
  return {
    ...core,
    title: redactSecrets(core.title, ctx.secrets ?? []),
    raw: 'cluster status: red',
  };
}

// ── stage of the failure ─────────────────────────────────────────────────

/**
 * Which step of "log in, then open the database" a cause belongs to. TLS
 * problems are their own step; a missing database means the login worked.
 */
export function stageOfCause(cause: ConnectCause): 'tls' | 'login' | 'database' {
  switch (cause) {
    case 'tls-required':
    case 'tls-not-supported':
    case 'tls-untrusted':
    case 'tls-hostname':
    case 'tls-expired':
    case 'tls-handshake':
      return 'tls';
    case 'database-missing':
    case 'permission':
    case 'file-missing':
    case 'file-not-database':
    case 'file-permission':
      return 'database';
    default:
      return 'login';
  }
}

// ── carrying a diagnosis through an IPC error ────────────────────────────

const MARK_OPEN = '\n[[plasma-diagnosis:';
const MARK_CLOSE = ']]';

/**
 * An `ipcMain.handle` rejection reaches the renderer as its message only, so
 * the diagnosis rides in the message after the readable text. Anything that
 * does not know the marker shows "Title. Detail" and nothing else.
 */
export function encodeDiagnosedMessage(d: ConnectDiagnosis): string {
  return `${d.title}. ${d.detail}${MARK_OPEN}${JSON.stringify(d)}${MARK_CLOSE}`;
}

/** The diagnosis in an error message, plus the message without the marker. */
export function decodeDiagnosedMessage(message: string): {
  diagnosis: ConnectDiagnosis | null;
  text: string;
} {
  const at = message.lastIndexOf(MARK_OPEN);
  if (at === -1 || !message.endsWith(MARK_CLOSE)) return { diagnosis: null, text: message };
  const text = message.slice(0, at);
  try {
    const parsed = JSON.parse(message.slice(at + MARK_OPEN.length, -MARK_CLOSE.length)) as unknown;
    if (isDiagnosis(parsed)) return { diagnosis: parsed, text };
  } catch {
    // fall through: show the readable part
  }
  return { diagnosis: null, text };
}

function isDiagnosis(v: unknown): v is ConnectDiagnosis {
  if (!v || typeof v !== 'object') return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d.cause === 'string' &&
    typeof d.title === 'string' &&
    typeof d.detail === 'string' &&
    Array.isArray(d.fixes) &&
    d.fixes.every((f) => typeof f === 'string') &&
    typeof d.raw === 'string'
  );
}
