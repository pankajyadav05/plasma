import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PgEndpoint } from '@shared/pg-backup';
import type { ConnectionConfig } from '@shared/protocol';
import { assertTlsAllowedForTag, effectiveTlsMode, resolveTls } from '@shared/tls';

/**
 * SC-09: pg_dump / pg_restore / psql must connect with the same TLS
 * guarantees as the worker's own session. libpq reads them from PGSSLMODE,
 * PGSSLROOTCERT, PGSSLCERT and PGSSLKEY; inline PEM (the connection holds
 * CA / cert / key text, not paths) goes to a private temp directory that is
 * removed when the job ends.
 */

export type AdminTlsPlan = {
  sslMode: NonNullable<PgEndpoint['sslMode']>;
  /** PEM text to materialise as files. */
  pem: { rootCert?: string; cert?: string; key?: string };
  /** Use the system trust store (libpq >= 16) when verifying without a CA. */
  systemRoots: boolean;
};

type TlsSession = Pick<ConnectionConfig, 'ssl' | 'tls' | 'host'>;

export function planAdminTls(session: TlsSession, tag: string | null | undefined): AdminTlsPlan {
  const mode = effectiveTlsMode(session);
  const resolved = resolveTls(session);
  // Same policy as establishSession: prod never uses an unverified mode.
  assertTlsAllowedForTag(resolved, tag);
  if (!resolved || mode === 'disable') {
    return { sslMode: 'disable', pem: {}, systemRoots: false };
  }
  // `insecure` is already folded into `require`; anything left is a libpq mode.
  const sslMode = (mode === 'insecure' ? 'require' : mode) as AdminTlsPlan['sslMode'];
  const verifying = sslMode === 'verify-ca' || sslMode === 'verify-full';
  return {
    sslMode,
    pem: { rootCert: resolved.ca, cert: resolved.cert, key: resolved.key },
    // Node trusts the OS store when no CA is given; libpq only does with
    // sslrootcert=system. On older libpq this fails closed ("root
    // certificate file does not exist") rather than skipping verification.
    systemRoots: verifying && !resolved.ca,
  };
}

export type AdminTlsFiles = {
  sslRootCert?: string;
  sslCert?: string;
  sslKey?: string;
  cleanup: () => Promise<void>;
};

/** Write inline PEM to a 0700 temp dir (files 0600). */
export async function materializeAdminTls(plan: AdminTlsPlan): Promise<AdminTlsFiles> {
  const { rootCert, cert, key } = plan.pem;
  if (!rootCert && !cert && !key) {
    return {
      ...(plan.systemRoots ? { sslRootCert: 'system' } : {}),
      cleanup: async () => undefined,
    };
  }
  const dir = await mkdtemp(join(tmpdir(), 'plasma-tls-'));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    const out: Pick<AdminTlsFiles, 'sslRootCert' | 'sslCert' | 'sslKey'> = {};
    if (rootCert) {
      out.sslRootCert = join(dir, 'root.crt');
      await writeFile(out.sslRootCert, rootCert, { mode: 0o600 });
    } else if (plan.systemRoots) {
      out.sslRootCert = 'system';
    }
    if (cert) {
      out.sslCert = join(dir, 'client.crt');
      await writeFile(out.sslCert, cert, { mode: 0o600 });
    }
    if (key) {
      out.sslKey = join(dir, 'client.key');
      await writeFile(out.sslKey, key, { mode: 0o600 });
    }
    return { ...out, cleanup };
  } catch (err) {
    await cleanup().catch(() => undefined);
    throw err;
  }
}
