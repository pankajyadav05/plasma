import type { ConnectionConfig, ConnectionEngine, TlsMode } from './protocol';

/**
 * C28 — connection URL import / copy.
 *
 *   postgres://user:pass@host:5432/db?sslmode=verify-full
 *   redis://user:pass@host:6379/0      rediss:// = TLS
 *   https://user:pass@search.example.com:9200   (OpenSearch; http:// = no TLS)
 *   mysql://user:pass@host:3306/db?sslmode=verify-full   (MySQL / MariaDB)
 */

const DEFAULT_PORT: Record<ConnectionEngine, number> = {
  postgres: 5432,
  redis: 6379,
  opensearch: 9200,
  sqlite: 1,
  mysql: 3306,
};

const SSL_MODES: readonly TlsMode[] = ['disable', 'prefer', 'require', 'verify-ca', 'verify-full'];

export type ParsedConnectionUrl = Pick<
  ConnectionConfig,
  'engine' | 'host' | 'port' | 'database' | 'user' | 'password' | 'ssl' | 'tls'
>;

function engineForScheme(scheme: string): { engine: ConnectionEngine; tls: boolean } | null {
  switch (scheme) {
    case 'postgres':
    case 'postgresql':
      return { engine: 'postgres', tls: false };
    case 'mysql':
    case 'mariadb':
      return { engine: 'mysql', tls: false };
    case 'redis':
      return { engine: 'redis', tls: false };
    case 'rediss':
      return { engine: 'redis', tls: true };
    case 'opensearch':
    case 'http':
      return { engine: 'opensearch', tls: false };
    case 'https':
      return { engine: 'opensearch', tls: true };
    default:
      return null;
  }
}

/** Parse a connection URL; throws a readable Error when it isn't one. */
export function parseConnectionUrl(input: string): ParsedConnectionUrl {
  const text = input.trim();
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text);
  if (!schemeMatch) throw new Error('Not a connection URL — expected e.g. postgres://user@host/db');
  const scheme = schemeMatch[1]!.toLowerCase();
  const kind = engineForScheme(scheme);
  if (!kind) throw new Error(`Unsupported URL scheme "${scheme}://"`);

  let url: URL;
  try {
    // WHATWG URL only fills host/port for "special" schemes; parse as http.
    url = new URL(`http://${text.slice(schemeMatch[0].length)}`);
  } catch {
    throw new Error('Could not parse the connection URL');
  }
  if (!url.hostname) throw new Error('The connection URL has no host');

  const port = url.port ? Number(url.port) : DEFAULT_PORT[kind.engine];
  const path = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  const params = url.searchParams;

  let database = '';
  if (kind.engine === 'postgres') database = path || params.get('dbname') || '';
  else if (kind.engine === 'mysql') database = path || params.get('database') || '';
  else if (kind.engine === 'redis') database = path || params.get('db') || '0';

  let ssl = kind.tls;
  let tls: ParsedConnectionUrl['tls'];
  const sslmode = params.get('sslmode')?.toLowerCase();
  if (sslmode) {
    const mode = (sslmode === 'allow' ? 'prefer' : sslmode) as TlsMode;
    if (!SSL_MODES.includes(mode)) throw new Error(`Unknown sslmode "${sslmode}"`);
    ssl = mode !== 'disable';
    tls = ssl ? { mode } : undefined;
  } else if (params.get('ssl') === 'true') {
    ssl = true;
  }
  if (ssl && !tls) tls = { mode: 'verify-full' };

  return {
    engine: kind.engine,
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port,
    database,
    user: decodeURIComponent(url.username || params.get('user') || ''),
    password: decodeURIComponent(url.password || params.get('password') || ''),
    ssl,
    tls,
  };
}

/**
 * Build a URL for `config`. The password is left out unless
 * `includePassword` — URLs end up in chat and tickets.
 */
export function formatConnectionUrl(
  config: Pick<
    ConnectionConfig,
    'engine' | 'host' | 'port' | 'database' | 'user' | 'password' | 'ssl' | 'tls'
  >,
  opts: { includePassword?: boolean } = {},
): string {
  const engine = config.engine ?? 'postgres';
  // A SQLite "URL" is just the file; there is no host to dial.
  if (engine === 'sqlite') return `sqlite://${config.database}`;
  const scheme =
    engine === 'postgres'
      ? 'postgres'
      : engine === 'mysql'
        ? 'mysql'
        : engine === 'redis'
          ? config.ssl
            ? 'rediss'
            : 'redis'
          : config.ssl
            ? 'https'
            : 'http';
  const user = config.user ? encodeURIComponent(config.user) : '';
  const pass =
    opts.includePassword && config.password ? `:${encodeURIComponent(config.password)}` : '';
  const auth = user || pass ? `${user}${pass}@` : '';
  const host = config.host.includes(':') ? `[${config.host}]` : config.host;
  const path =
    engine === 'opensearch' || !config.database ? '' : `/${encodeURIComponent(config.database)}`;
  let query = '';
  if (engine === 'postgres' || engine === 'mysql') {
    const mode = !config.ssl
      ? 'disable'
      : config.tls?.mode === 'insecure'
        ? 'require'
        : (config.tls?.mode ?? 'verify-full');
    if (mode !== 'disable') query = `?sslmode=${mode}`;
  }
  return `${scheme}://${auth}${host}:${config.port}${path}${query}`;
}
