import { scrubKnown } from '@shared/mcp';
import type { ConnectionConfig } from '@shared/protocol';
import { redactErrorText } from '../redact';

/**
 * What an MCP client may never read in an error: everything that says where a
 * database is or how Plasma gets there. The list comes from the saved
 * connection (host, user, password, file paths, TLS files, DuckDB files and
 * attached connections) and its SSH tunnel; a generic pass then removes any
 * absolute file path that is left.
 */

export interface ScrubSsh {
  host?: string;
  user?: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  privateKeyPath?: string;
}

const looksLikePath = (s: string | undefined): s is string => Boolean(s && /[\\/]/.test(s));

export function scrubValuesFor(
  config: ConnectionConfig | null,
  ssh: ScrubSsh | null,
  attached: ReadonlyArray<ConnectionConfig | null> = [],
): string[] {
  const out: Array<string | undefined> = [];
  const add = (c: ConnectionConfig | null) => {
    if (!c) return;
    out.push(c.password, c.host, c.user);
    // A database name is only secret when it is a file path (SQLite, DuckDB).
    if (looksLikePath(c.database)) out.push(c.database);
    const tls = c.tls;
    if (tls) out.push(tls.caFile, tls.certFile, tls.keyFile);
    for (const f of c.duckdb?.files ?? []) out.push(f);
  };
  add(config);
  for (const a of attached) add(a);
  if (ssh) {
    out.push(ssh.host, ssh.user, ssh.password, ssh.privateKey, ssh.passphrase, ssh.privateKeyPath);
  }
  return out.filter((v): v is string => typeof v === 'string' && v.length >= 3);
}

/** Unix or Windows absolute paths with at least two segments. */
const PATH_RE = /(?:[A-Za-z]:)?(?:[\\/][\w .@~+()-]+){2,}[\\/]?/g;

export function scrubErrorForMcp(text: string, values: readonly string[]): string {
  return redactErrorText(scrubKnown(text, values)).replace(PATH_RE, '…');
}
