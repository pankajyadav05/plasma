import { createHash } from 'node:crypto';
import type { Settings } from '@shared/protocol';

export type KnownHostsStore = NonNullable<Settings['sshKnownHosts']>;
export type KnownHostEntry = KnownHostsStore[string];

export function knownHostKey(host: string, port: number): string {
  return `${host}:${port}`;
}

/** OpenSSH-style SHA256 fingerprint (`SHA256:…` base64, no padding). */
export function fingerprintSha256(key: Buffer): string {
  const digest = createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
  return `SHA256:${digest}`;
}

export type HostKeyDecision =
  | { kind: 'match' }
  | { kind: 'mismatch'; fingerprint: string; expectedFingerprint: string }
  | { kind: 'unknown'; fingerprint: string };

export function evaluateHostKey(
  store: KnownHostsStore,
  host: string,
  port: number,
  key: Buffer,
): HostKeyDecision {
  const id = knownHostKey(host, port);
  const fingerprint = fingerprintSha256(key);
  const existing = store[id];
  if (!existing) {
    return { kind: 'unknown', fingerprint };
  }
  const presented = key.toString('base64');
  if (presented === existing.key) {
    return { kind: 'match' };
  }
  return {
    kind: 'mismatch',
    fingerprint,
    expectedFingerprint: fingerprintSha256(Buffer.from(existing.key, 'base64')),
  };
}

export function rememberHostKey(
  store: KnownHostsStore,
  host: string,
  port: number,
  key: Buffer,
  type?: string,
): KnownHostsStore {
  const id = knownHostKey(host, port);
  return {
    ...store,
    [id]: {
      host,
      port,
      key: key.toString('base64'),
      ...(type ? { type } : {}),
      addedAt: Date.now(),
    },
  };
}

/**
 * Key algorithm from an SSH wire-format public key blob (the first
 * length-prefixed string, e.g. `ssh-ed25519`). Undefined when malformed.
 */
export function hostKeyType(key: Buffer): string | undefined {
  if (key.length < 4) return undefined;
  const len = key.readUInt32BE(0);
  if (len <= 0 || len > 64 || key.length < 4 + len) return undefined;
  const type = key.subarray(4, 4 + len).toString('ascii');
  return /^[a-z0-9@.-]+$/i.test(type) ? type : undefined;
}
