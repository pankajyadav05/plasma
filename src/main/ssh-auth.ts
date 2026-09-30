/**
 * SSH authentication options for a tunnel (C28).
 *
 * Order of preference: pasted key text, then a key file, then the ssh-agent,
 * with the password as a further fallback. ssh2 tries every method that is
 * set, so an agent plus a password both work.
 */
export interface SshAuthInput {
  password: string;
  privateKey: string;
  passphrase: string;
  privateKeyPath?: string;
  useAgent?: boolean;
}

export interface SshAuthOptions {
  privateKey?: string | Buffer;
  passphrase?: string;
  password?: string;
  agent?: string;
}

export interface SshAuthDeps {
  readFile: (path: string) => string | Buffer;
  env: Record<string, string | undefined>;
  platform: string;
}

/** Where the ssh-agent listens: SSH_AUTH_SOCK, or Pageant / the OpenSSH pipe on Windows. */
export function agentSocket(env: SshAuthDeps['env'], platform: string): string | undefined {
  if (env.SSH_AUTH_SOCK) return env.SSH_AUTH_SOCK;
  if (platform === 'win32') return 'pageant';
  return undefined;
}

export function buildSshAuthOptions(ssh: SshAuthInput, deps: SshAuthDeps): SshAuthOptions {
  const out: SshAuthOptions = {};
  const keyPath = ssh.privateKeyPath?.trim();
  if (ssh.privateKey) {
    out.privateKey = ssh.privateKey;
  } else if (keyPath) {
    try {
      out.privateKey = deps.readFile(keyPath);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not read the SSH private key file (${keyPath}): ${detail}`);
    }
  }
  if (out.privateKey && ssh.passphrase) out.passphrase = ssh.passphrase;
  if (ssh.useAgent) {
    const agent = agentSocket(deps.env, deps.platform);
    if (!agent) {
      throw new Error(
        'ssh-agent is not running (SSH_AUTH_SOCK is not set). Start an agent or use a key file.',
      );
    }
    out.agent = agent;
  }
  if (ssh.password) out.password = ssh.password;
  return out;
}
