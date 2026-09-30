import { redisEndpointKind, sshUnsupportedReason } from '@shared/connection-endpoint';
import type { ConnectionConfig, ConnectionEngine, TlsMode } from '@shared/protocol';

/**
 * F6 — inline, per-field validation for the connection dialog. Runs in the
 * renderer so the user sees "Host is required" under the Host field
 * instead of a Zod issue list from main.
 */

export type FormField =
  | 'name'
  | 'host'
  | 'port'
  | 'database'
  | 'sshHost'
  | 'sshPort'
  | 'sshUser'
  | 'sshAuth'
  | 'ssh'
  | 'osAuth'
  | 'osNodes'
  | 'tlsCert'
  | 'tlsKey';

export type FormErrors = Partial<Record<FormField, string>>;

export interface SshFormState {
  host: string;
  port: string;
  user: string;
  password: string;
  privateKey: string;
  passphrase: string;
  /** Private key file to read at connect time (C28). */
  privateKeyPath?: string;
  /** Authenticate through the running ssh-agent (C28). */
  useAgent?: boolean;
}

export interface ConnectionFormInput {
  config: ConnectionConfig;
  /** The port as typed, so "abc" can be reported instead of silently becoming 0. */
  portText: string;
  useSsh: boolean;
  ssh: SshFormState;
  /** Secrets already stored for this connection (blank field = keep). */
  savedSsh?: {
    hasPassword?: boolean;
    hasPrivateKey?: boolean;
    privateKeyPath?: string;
    useAgent?: boolean;
  };
}

function portError(text: string): string | undefined {
  const t = text.trim();
  if (!t) return 'Port is required';
  if (!/^\d+$/.test(t)) return 'Port must be a number';
  const n = Number(t);
  if (n < 1 || n > 65535) return 'Port must be between 1 and 65535';
  return undefined;
}

export function validateConnectionForm(input: ConnectionFormInput): FormErrors {
  const { config, useSsh, ssh } = input;
  const engine = (config.engine ?? 'postgres') as ConnectionEngine;
  const errors: FormErrors = {};

  if (!config.name.trim()) errors.name = 'Name is required';

  const host = config.host.trim();
  if (!host) errors.host = 'Host is required';
  else if (engine === 'redis' && redisEndpointKind(host) !== 'tcp') {
    // unix:/path, /path, sentinel://… and cluster://… are real Redis endpoints.
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host))
    errors.host = 'Enter just the host name — paste full URLs into Import URL';
  else if (/\s/.test(host)) errors.host = 'Host cannot contain spaces';

  const pErr = portError(input.portText);
  if (pErr) errors.port = pErr;

  if (engine === 'redis' && config.database.trim() && !/^\d+$/.test(config.database.trim())) {
    errors.database = 'DB index must be a whole number (0–15 on most servers)';
  }

  if (useSsh && engine !== 'opensearch') {
    if (!ssh.host.trim()) errors.sshHost = 'SSH host is required';
    const sp = portError(ssh.port);
    if (sp) errors.sshPort = sp.replace('Port', 'SSH port');
    if (!ssh.user.trim()) errors.sshUser = 'SSH user is required';
    const hasSecret =
      Boolean(ssh.password || ssh.privateKey || ssh.privateKeyPath?.trim() || ssh.useAgent) ||
      Boolean(input.savedSsh?.hasPassword || input.savedSsh?.hasPrivateKey);
    if (!hasSecret) errors.sshAuth = 'Enter an SSH password, a private key or use the ssh-agent';
    const unsupported = sshUnsupportedReason({ engine, host });
    if (unsupported) errors.ssh = unsupported;
  }

  if (engine === 'opensearch') {
    const os = config.opensearch ?? {};
    const auth = os.auth ?? 'basic';
    if (auth === 'apiKey' && !os.apiKey && !os.hasApiKey) {
      errors.osAuth = 'Enter the API key (id:key or base64)';
    }
    if (auth === 'sigv4') {
      if (!os.awsRegion?.trim()) errors.osAuth = 'AWS region is required (e.g. eu-west-1)';
      else if (!os.awsAccessKeyId?.trim() || (!os.awsSecretAccessKey && !os.hasAwsSecretAccessKey))
        errors.osAuth = 'AWS access key id and secret access key are required';
    }
    const badNode = (os.nodes ?? []).find((n) => n.trim() && /\s/.test(n.trim()));
    if (badNode) errors.osNodes = `"${badNode}" is not a valid node URL`;
  }

  if (config.ssl && config.tls) {
    const { certFile, keyFile } = config.tls;
    if (certFile?.trim() && !keyFile?.trim())
      errors.tlsKey = 'A client certificate needs its key file';
    if (keyFile?.trim() && !certFile?.trim())
      errors.tlsCert = 'A client key needs its certificate file';
  }

  return errors;
}

/** Hint shown under the Redis host field for the special endpoint forms. */
export { REDIS_HOST_HINT, redisEndpointKind } from '@shared/connection-endpoint';

export function hasErrors(errors: FormErrors): boolean {
  return Object.values(errors).some(Boolean);
}

/** SSL select value for the form: `disable` when TLS is off. */
export function formTlsMode(config: Pick<ConnectionConfig, 'ssl' | 'tls'>): TlsMode {
  if (!config.ssl) return 'disable';
  const mode = config.tls?.mode ?? 'verify-full';
  return mode === 'insecure' ? 'require' : mode;
}

/** Apply an SSL-mode pick to the config. */
export function withTlsMode(config: ConnectionConfig, mode: TlsMode): ConnectionConfig {
  if (mode === 'disable')
    return { ...config, ssl: false, tls: config.tls ? { ...config.tls, mode } : undefined };
  return { ...config, ssl: true, tls: { ...(config.tls ?? {}), mode } };
}

export const TLS_MODE_LABEL: Record<Exclude<TlsMode, 'insecure'>, string> = {
  disable: 'Disabled',
  prefer: 'Preferred',
  require: 'Required (no verification)',
  'verify-ca': 'Verify CA',
  'verify-full': 'Verify CA and host name',
};
