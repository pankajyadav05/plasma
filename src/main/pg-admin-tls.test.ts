import { readFile, stat } from 'node:fs/promises';
import { buildPgDumpInvocation } from '@shared/pg-backup';
import { describe, expect, it } from 'vitest';
import { materializeAdminTls, planAdminTls } from './pg-admin-tls';

const base = { host: 'db.example.com', ssl: true };

describe('planAdminTls (SC-09)', () => {
  it('forwards verify-full instead of downgrading to require', () => {
    expect(planAdminTls({ ...base, tls: { mode: 'verify-full' } }, null).sslMode).toBe(
      'verify-full',
    );
    expect(planAdminTls({ ...base }, null).sslMode).toBe('verify-full');
  });

  it('keeps verify-ca, require and prefer as they are, and disable when TLS is off', () => {
    expect(planAdminTls({ ...base, tls: { mode: 'verify-ca' } }, null).sslMode).toBe('verify-ca');
    expect(planAdminTls({ ...base, tls: { mode: 'require' } }, null).sslMode).toBe('require');
    expect(planAdminTls({ ...base, tls: { mode: 'prefer' } }, null).sslMode).toBe('prefer');
    expect(planAdminTls({ host: 'h', ssl: false }, null).sslMode).toBe('disable');
  });

  it('refuses unverified TLS on a prod-tagged connection', () => {
    expect(() => planAdminTls({ ...base, tls: { mode: 'require' } }, 'prod')).toThrow(/prod/);
    expect(planAdminTls({ ...base, tls: { mode: 'verify-ca' } }, 'prod').sslMode).toBe('verify-ca');
  });

  it('uses the system trust store when verifying without a CA, a given CA otherwise', () => {
    expect(planAdminTls({ ...base }, null).systemRoots).toBe(true);
    const withCa = planAdminTls({ ...base, tls: { mode: 'verify-full', ca: 'PEM' } }, null);
    expect(withCa.systemRoots).toBe(false);
    expect(withCa.pem.rootCert).toBe('PEM');
    expect(planAdminTls({ ...base, tls: { mode: 'require' } }, null).systemRoots).toBe(false);
  });
});

describe('materializeAdminTls', () => {
  it('writes inline PEM to private files and cleans them up', async () => {
    const plan = planAdminTls(
      { ...base, tls: { mode: 'verify-full', ca: 'CA-PEM', cert: 'CERT-PEM', key: 'KEY-PEM' } },
      null,
    );
    const files = await materializeAdminTls(plan);
    expect(await readFile(files.sslRootCert as string, 'utf8')).toBe('CA-PEM');
    expect(await readFile(files.sslCert as string, 'utf8')).toBe('CERT-PEM');
    expect(await readFile(files.sslKey as string, 'utf8')).toBe('KEY-PEM');
    if (process.platform !== 'win32') {
      expect((await stat(files.sslKey as string)).mode & 0o077).toBe(0);
    }
    await files.cleanup();
    await expect(stat(files.sslKey as string)).rejects.toThrow();
  });

  it('points libpq at the system roots when no CA is configured', async () => {
    const files = await materializeAdminTls(planAdminTls({ ...base }, null));
    expect(files.sslRootCert).toBe('system');
  });

  it('ends up in the tool environment', () => {
    const inv = buildPgDumpInvocation({ database: 'd', outputPath: '/tmp/x.dump' } as never, {
      host: 'db.example.com',
      port: 6543,
      user: 'u',
      password: 'p',
      ssl: true,
      sslMode: 'verify-full',
      sslRootCert: '/tmp/root.crt',
      sslCert: '/tmp/c.crt',
      sslKey: '/tmp/c.key',
      hostAddr: '127.0.0.1',
    });
    expect(inv.env).toMatchObject({
      PGSSLMODE: 'verify-full',
      PGSSLROOTCERT: '/tmp/root.crt',
      PGSSLCERT: '/tmp/c.crt',
      PGSSLKEY: '/tmp/c.key',
      PGHOSTADDR: '127.0.0.1',
    });
    expect(inv.args).toContain('--host=db.example.com');
  });
});
