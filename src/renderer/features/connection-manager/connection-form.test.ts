import type { ConnectionConfig } from '@shared/protocol';
import { describe, expect, it } from 'vitest';
import {
  type ConnectionFormInput,
  formTlsMode,
  hasErrors,
  validateConnectionForm,
  withTlsMode,
} from './connection-form';

const config: ConnectionConfig = {
  id: 'c1',
  name: 'local',
  engine: 'postgres',
  host: 'localhost',
  port: 5432,
  database: 'postgres',
  user: 'postgres',
  password: '',
  ssl: false,
  readOnly: false,
};

const input = (patch: Partial<ConnectionFormInput> = {}): ConnectionFormInput => ({
  config,
  portText: '5432',
  useSsh: false,
  ssh: { host: '', port: '22', user: '', password: '', privateKey: '', passphrase: '' },
  ...patch,
});

describe('validateConnectionForm (F6)', () => {
  it('accepts a complete form', () => {
    expect(hasErrors(validateConnectionForm(input()))).toBe(false);
  });

  it('reports each missing field under its own name', () => {
    const errors = validateConnectionForm(
      input({ config: { ...config, name: ' ', host: '' }, portText: '' }),
    );
    expect(errors).toMatchObject({
      name: 'Name is required',
      host: 'Host is required',
      port: 'Port is required',
    });
  });

  it('rejects bad ports and URL-shaped hosts', () => {
    expect(validateConnectionForm(input({ portText: 'abc' })).port).toMatch(/number/);
    expect(validateConnectionForm(input({ portText: '70000' })).port).toMatch(/between/);
    expect(
      validateConnectionForm(input({ config: { ...config, host: 'postgres://x/y' } })).host,
    ).toMatch(/Import URL/);
  });

  it('checks the Redis DB index', () => {
    const redis = { ...config, engine: 'redis' as const, database: 'x' };
    expect(validateConnectionForm(input({ config: redis })).database).toMatch(/whole number/);
  });

  it('requires SSH host, user and a secret when the tunnel is on', () => {
    const errors = validateConnectionForm(input({ useSsh: true }));
    expect(errors.sshHost).toBeTruthy();
    expect(errors.sshUser).toBeTruthy();
    expect(errors.sshAuth).toBeTruthy();
    const saved = validateConnectionForm(
      input({
        useSsh: true,
        ssh: { host: 'b', port: '22', user: 'u', password: '', privateKey: '', passphrase: '' },
        savedSsh: { hasPrivateKey: true },
      }),
    );
    expect(hasErrors(saved)).toBe(false);
  });

  it('pairs client certificate and key files', () => {
    const tls = withTlsMode(config, 'verify-full');
    const errors = validateConnectionForm(
      input({ config: { ...tls, tls: { mode: 'verify-full', certFile: '/c.pem' } } }),
    );
    expect(errors.tlsKey).toBeTruthy();
  });
});

describe('TLS mode helpers', () => {
  it('maps ssl off to disable and legacy insecure to require', () => {
    expect(formTlsMode(config)).toBe('disable');
    expect(formTlsMode({ ssl: true, tls: { mode: 'insecure' } })).toBe('require');
    expect(formTlsMode({ ssl: true, tls: undefined })).toBe('verify-full');
  });

  it('turns ssl on and off with the mode', () => {
    const on = withTlsMode(config, 'verify-ca');
    expect(on.ssl).toBe(true);
    expect(on.tls?.mode).toBe('verify-ca');
    expect(withTlsMode(on, 'disable').ssl).toBe(false);
  });
});
