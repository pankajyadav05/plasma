import { describe, expect, it } from 'vitest';
import { agentSocket, buildSshAuthOptions } from './ssh-auth';

const base = { password: '', privateKey: '', passphrase: '' };
const deps = (over: Partial<Parameters<typeof buildSshAuthOptions>[1]> = {}) => ({
  readFile: (p: string) => `KEY@${p}`,
  env: { SSH_AUTH_SOCK: '/run/agent.sock' },
  platform: 'linux',
  ...over,
});

describe('buildSshAuthOptions', () => {
  it('prefers pasted key text over a key file', () => {
    const o = buildSshAuthOptions({ ...base, privateKey: 'PASTED', privateKeyPath: '/k' }, deps());
    expect(o.privateKey).toBe('PASTED');
  });
  it('reads the key file when no text is stored, with its passphrase', () => {
    const o = buildSshAuthOptions({ ...base, privateKeyPath: '/k', passphrase: 'pp' }, deps());
    expect(o).toEqual({ privateKey: 'KEY@/k', passphrase: 'pp' });
  });
  it('explains an unreadable key file', () => {
    expect(() =>
      buildSshAuthOptions(
        { ...base, privateKeyPath: '/nope' },
        deps({
          readFile: () => {
            throw new Error('ENOENT');
          },
        }),
      ),
    ).toThrow(/private key file \(\/nope\).*ENOENT/);
  });
  it('adds the agent socket and keeps a password fallback', () => {
    const o = buildSshAuthOptions({ ...base, useAgent: true, password: 'pw' }, deps());
    expect(o).toEqual({ agent: '/run/agent.sock', password: 'pw' });
  });
  it('fails clearly when the agent is missing', () => {
    expect(() => buildSshAuthOptions({ ...base, useAgent: true }, deps({ env: {} }))).toThrow(
      /ssh-agent is not running/,
    );
  });
  it('uses pageant on Windows without SSH_AUTH_SOCK', () => {
    expect(agentSocket({}, 'win32')).toBe('pageant');
    expect(agentSocket({}, 'linux')).toBeUndefined();
  });
});
