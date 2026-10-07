import type { ConnectionConfig } from '@shared/protocol';
import { describe, expect, it } from 'vitest';
import { scrubErrorForMcp, scrubValuesFor } from './scrub';

const pg = {
  id: 'c1',
  name: 'Prod',
  engine: 'postgres',
  host: 'db.internal.corp',
  port: 5432,
  database: 'shop',
  user: 'svc_reports',
  password: 'hunter2hunter2',
  ssl: true,
  tls: {
    mode: 'verify-full',
    caFile: '/Users/me/certs/prod-ca.pem',
    certFile: '/Users/me/certs/c.pem',
    keyFile: '/Users/me/certs/c.key',
  },
} as unknown as ConnectionConfig;

const out = (
  text: string,
  ...args: Parameters<typeof scrubValuesFor> extends [infer A, ...infer R] ? [A, ...R] : never
) => scrubErrorForMcp(text, scrubValuesFor(...(args as Parameters<typeof scrubValuesFor>)));

describe('scrubErrorForMcp', () => {
  it('removes host, user, password', () => {
    const t = out(
      'password authentication failed for user "svc_reports" at db.internal.corp (hunter2hunter2)',
      pg,
      null,
    );
    expect(t).not.toMatch(/svc_reports|db\.internal|hunter2/);
  });
  it('removes TLS file paths', () => {
    const t = out(
      'Could not read the TLS CA file /Users/me/certs/prod-ca.pem: ENOENT: no such file',
      pg,
      null,
    );
    expect(t).not.toContain('/Users/me');
    expect(t).not.toContain('prod-ca.pem');
  });
  it('removes SSH host, user and key path', () => {
    const ssh = {
      host: 'bastion.corp.example',
      user: 'deploy',
      privateKeyPath: '/home/me/.ssh/id_prod',
    };
    const t = out(
      'Could not read the SSH private key file (/home/me/.ssh/id_prod): ENOENT; connect ECONNREFUSED bastion.corp.example:22 as deploy',
      pg,
      ssh,
    );
    expect(t).not.toMatch(/bastion|deploy|id_prod|\/home\/me/);
  });
  it('removes DuckDB files and the host and user of attached connections', () => {
    const duck = {
      ...pg,
      engine: 'duckdb',
      database: ':memory:',
      duckdb: { files: ['/data/warehouse/sales.parquet'], attachConnectionIds: ['a1'] },
    } as unknown as ConnectionConfig;
    const attached = {
      ...pg,
      id: 'a1',
      host: 'replica.corp',
      user: 'attach_user',
      password: 'attachpass99',
    } as unknown as ConnectionConfig;
    const t = out(
      'IO Error: cannot open /data/warehouse/sales.parquet; attach to replica.corp as attach_user failed',
      duck,
      null,
      [attached],
    );
    expect(t).not.toMatch(/warehouse|replica|attach_user/);
  });
  it('removes a sqlite file path, and any other absolute path as a last resort', () => {
    const lite = {
      ...pg,
      engine: 'sqlite',
      host: 'local',
      database: '/Users/me/data/app.db',
    } as unknown as ConnectionConfig;
    expect(out('unable to open database file /Users/me/data/app.db', lite, null)).not.toContain(
      'app.db',
    );
    expect(out('could not load C:\\Users\\me\\certs\\ca.pem', pg, null)).not.toMatch(
      /Users|ca\.pem/,
    );
    expect(out('open /etc/ssl/other.pem failed', pg, null)).not.toContain('/etc/ssl');
  });
  it('keeps the useful part of an ordinary database error', () => {
    expect(out('relation "orders" does not exist', pg, null)).toBe(
      'relation "orders" does not exist',
    );
  });
});
