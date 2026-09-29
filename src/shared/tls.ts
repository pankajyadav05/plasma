import type { ConnectionConfig, ConnectionTls, TlsMode } from './protocol';

/**
 * U08 / C4 / C9 — TLS policy for database connections.
 *
 * libpq-style modes:
 *   - `disable`     plaintext (same as `ssl: false`)
 *   - `prefer`      try TLS without verification, fall back to plaintext
 *                   (only Postgres can negotiate the fallback; the other
 *                   engines treat it as `require`)
 *   - `require`     TLS, no certificate verification
 *   - `verify-ca`   TLS, chain verified against the CA, hostname not checked
 *   - `verify-full` TLS, chain + hostname verified (default)
 *
 * `insecure` is the pre-C9 name for `require` and is normalised here.
 * Unverified modes are refused for prod-tagged connections.
 */

/** Modes that actually open a TLS session, after normalisation. */
export type ActiveTlsMode = Exclude<TlsMode, 'disable' | 'insecure'>;

export type ResolvedTls = {
  /** Never `disable` / `insecure` at runtime (see ActiveTlsMode); kept wide for callers. */
  mode: TlsMode;
  ca?: string;
  cert?: string;
  key?: string;
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
  cert?: string;
  key?: string;
  servername?: string;
  checkServerIdentity?: (...args: unknown[]) => Error | undefined;
};

type TlsInput = Pick<ConnectionConfig, 'ssl' | 'tls' | 'host'>;

const nonEmpty = (v: string | undefined): string | undefined => (v?.trim() ? v : undefined);

/** The mode the user picked, with `ssl: false` and legacy spellings folded in. */
export function effectiveTlsMode(config: Pick<ConnectionConfig, 'ssl' | 'tls'>): TlsMode {
  if (!config.ssl) return 'disable';
  const mode = config.tls?.mode ?? 'verify-full';
  return mode === 'insecure' ? 'require' : mode;
}

/** True for modes that encrypt without authenticating the server. */
export function isUnverifiedTlsMode(mode: TlsMode | null | undefined): boolean {
  return mode === 'prefer' || mode === 'require' || mode === 'insecure';
}

/** Resolve effective TLS settings; null when TLS is off. */
export function resolveTls(config: TlsInput): ResolvedTls | null {
  const mode = effectiveTlsMode(config);
  if (mode === 'disable' || mode === 'insecure') return null;
  const tls: Partial<ConnectionTls> = config.tls ?? {};
  return {
    mode,
    ca: nonEmpty(tls.ca),
    cert: nonEmpty(tls.cert),
    key: nonEmpty(tls.key),
    servername: nonEmpty(tls.servername),
  };
}

/**
 * Refuse unverified TLS on production-tagged connections. Callers pass the
 * connection's environment tag from settings (`connectionTags[id]`).
 */
export function assertTlsAllowedForTag(
  resolved: Pick<ResolvedTls, 'mode'> | { mode: TlsMode } | null,
  tag: string | null | undefined,
): void {
  if (tag === 'prod' && resolved && isUnverifiedTlsMode(resolved.mode)) {
    throw new Error(
      `TLS mode "${resolved.mode}" does not verify the server certificate, which is not allowed for production-tagged connections. Use verify-full or verify-ca (with a CA file if needed), or change the environment tag.`,
    );
  }
}

/**
 * Build Node `tls` / `pg` / `ioredis` / OpenSearch SSL options.
 * Returns `undefined` when TLS is off (callers map that to `false` /
 * omit as needed for their client).
 */
export function buildNodeTlsOptions(config: TlsInput): PlasmaTlsOptions | undefined {
  const resolved = resolveTls(config);
  if (!resolved) return undefined;

  const { mode, ca, cert, key, servername } = resolved;
  const material = {
    ...(ca ? { ca } : {}),
    ...(cert ? { cert } : {}),
    ...(key ? { key } : {}),
  };

  if (mode === 'prefer' || mode === 'require') {
    return {
      rejectUnauthorized: false,
      ...material,
      ...(servername ? { servername } : {}),
    };
  }

  if (mode === 'verify-ca') {
    // Authenticate the CA chain but skip hostname matching (libpq
    // verify-ca). Still set SNI when we have an explicit override so
    // the handshake can select the right cert.
    return {
      rejectUnauthorized: true,
      ...material,
      ...(servername ? { servername } : {}),
      checkServerIdentity: () => undefined,
    };
  }

  // verify-full (default): verify chain + hostname.
  return {
    rejectUnauthorized: true,
    ...material,
    servername: servername ?? config.host,
  };
}

/** Human-readable warning emitted when an unverified mode is used. */
export function insecureTlsWarning(host: string): string {
  return `[plasma] TLS certificate verification disabled for ${host}`;
}

/**
 * C10 — when main rewrites `host` to the local end of an SSH tunnel, the
 * certificate still names the real server. Pin SNI / hostname checks to
 * the original host unless the user set an explicit servername.
 */
export function withTunnelServername<T extends Pick<ConnectionConfig, 'ssl' | 'tls'>>(
  config: T,
  originalHost: string,
): T {
  if (!config.ssl) return config;
  const tls = config.tls ?? { mode: 'verify-full' as const };
  if (tls.servername?.trim()) return config;
  return { ...config, tls: { ...tls, servername: originalHost } };
}
