import type { ConnectionConfig, ConnectionTls, TlsMode } from './protocol';

/**
 * U08 — TLS policy for database connections.
 *
 * Defaults to certificate verification (`verify-full`). `insecure` is an
 * explicit per-connection override and is refused for prod-tagged
 * connections. Existing self-signed setups must opt into `insecure`
 * (or supply a custom CA) after this change.
 */

export type ResolvedTls = {
  mode: TlsMode;
  ca?: string;
  servername?: string;
};

/**
 * Minimal TLS option bag shared by pg / ioredis / OpenSearch / Node tls.
 * Kept free of `node:tls` imports so the renderer typecheck can include
 * this module.
 */
export type PlasmaTlsOptions = {
  rejectUnauthorized: boolean;
  ca?: string;
  servername?: string;
  checkServerIdentity?: (...args: unknown[]) => Error | undefined;
};

/** Resolve effective TLS settings when SSL/TLS/HTTPS is enabled. */
export function resolveTls(
  config: Pick<ConnectionConfig, 'ssl' | 'tls' | 'host'>,
): ResolvedTls | null {
  if (!config.ssl) return null;
  const tls: ConnectionTls = config.tls ?? { mode: 'verify-full' };
  return {
    mode: tls.mode ?? 'verify-full',
    ca: tls.ca?.trim() ? tls.ca : undefined,
    servername: tls.servername?.trim() ? tls.servername : undefined,
  };
}

/**
 * Refuse insecure TLS on production-tagged connections. Callers pass the
 * connection's environment tag from settings (`connectionTags[id]`).
 */
export function assertTlsAllowedForTag(
  resolved: ResolvedTls | null,
  tag: string | null | undefined,
): void {
  if (resolved?.mode === 'insecure' && tag === 'prod') {
    throw new Error(
      'TLS mode "insecure" is not allowed for production-tagged connections. Use verify-full or verify-ca, or change the environment tag.',
    );
  }
}

/**
 * Build Node `tls` / `pg` / `ioredis` / OpenSearch SSL options.
 * Returns `undefined` when SSL is off (callers map that to `false` /
 * omit as needed for their client).
 */
export function buildNodeTlsOptions(
  config: Pick<ConnectionConfig, 'ssl' | 'tls' | 'host'>,
): PlasmaTlsOptions | undefined {
  const resolved = resolveTls(config);
  if (!resolved) return undefined;

  const { mode, ca, servername } = resolved;
  const sni = servername ?? config.host;

  if (mode === 'insecure') {
    return {
      rejectUnauthorized: false,
      ...(ca ? { ca } : {}),
      ...(servername ? { servername } : {}),
    };
  }

  if (mode === 'verify-ca') {
    // Authenticate the CA chain but skip hostname matching (libpq
    // verify-ca). Still set SNI when we have an explicit override so
    // the handshake can select the right cert.
    return {
      rejectUnauthorized: true,
      ...(ca ? { ca } : {}),
      ...(servername ? { servername } : {}),
      checkServerIdentity: () => undefined,
    };
  }

  // verify-full (default): verify chain + hostname.
  return {
    rejectUnauthorized: true,
    ...(ca ? { ca } : {}),
    servername: sni,
  };
}

/** Human-readable warning emitted when insecure mode is used. */
export function insecureTlsWarning(host: string): string {
  return `[plasma] TLS certificate verification disabled (insecure) for ${host}`;
}
