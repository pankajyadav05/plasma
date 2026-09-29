import { describe, expect, it } from 'vitest';
import {
  evaluateHostKey,
  fingerprintSha256,
  hostKeyType,
  knownHostKey,
  rememberHostKey,
} from './ssh-known-hosts';

describe('ssh known hosts', () => {
  const keyA = Buffer.from('host-key-a');
  const keyB = Buffer.from('host-key-b');

  it('keys entries by host:port', () => {
    expect(knownHostKey('bastion.example.com', 22)).toBe('bastion.example.com:22');
  });

  it('treats an unknown host as first-use', () => {
    const decision = evaluateHostKey({}, 'bastion', 22, keyA);
    expect(decision.kind).toBe('unknown');
    if (decision.kind === 'unknown') {
      expect(decision.fingerprint).toBe(fingerprintSha256(keyA));
    }
  });

  it('matches a remembered key', () => {
    const store = rememberHostKey({}, 'bastion', 22, keyA, 'ssh-ed25519');
    expect(evaluateHostKey(store, 'bastion', 22, keyA)).toEqual({ kind: 'match' });
    expect(store['bastion:22']?.type).toBe('ssh-ed25519');
  });

  it('detects a mismatched key (possible MITM)', () => {
    const store = rememberHostKey({}, 'bastion', 22, keyA);
    const decision = evaluateHostKey(store, 'bastion', 22, keyB);
    expect(decision.kind).toBe('mismatch');
    if (decision.kind === 'mismatch') {
      expect(decision.fingerprint).toBe(fingerprintSha256(keyB));
      expect(decision.expectedFingerprint).toBe(fingerprintSha256(keyA));
    }
  });

  it('reads the key algorithm from an SSH wire-format blob', () => {
    const type = Buffer.from('ssh-ed25519');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(type.length, 0);
    const blob = Buffer.concat([len, type, Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7)]);
    expect(hostKeyType(blob)).toBe('ssh-ed25519');
    expect(hostKeyType(Buffer.from('xx'))).toBeUndefined();
  });
});
