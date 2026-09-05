import { describe, expect, it } from 'vitest';
import { ConnectionSshConfig, WorkerRequest } from './protocol';

describe('U02 protocol shapes', () => {
  it('parses testConnect worker requests', () => {
    const parsed = WorkerRequest.parse({
      kind: 'testConnect',
      id: 'req-1',
      config: {
        id: 'c1',
        name: 'local',
        host: '127.0.0.1',
        port: 5432,
        database: 'postgres',
        user: 'postgres',
        password: '',
        ssl: false,
        engine: 'postgres',
      },
    });
    expect(parsed.kind).toBe('testConnect');
  });

  it('rejects connect-shaped payloads missing required fields on testConnect', () => {
    expect(() =>
      WorkerRequest.parse({ kind: 'testConnect', id: 'x', config: { host: 'h' } }),
    ).toThrow();
  });

  it('parses ConnectionSshConfig with defaults', () => {
    const ssh = ConnectionSshConfig.parse({ host: 'bastion.example', user: 'ubuntu' });
    expect(ssh.port).toBe(22);
    expect(ssh.password).toBe('');
    expect(ssh.privateKey).toBe('');
  });
});
