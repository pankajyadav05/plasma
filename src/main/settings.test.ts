import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * SC-25 / SC-08 / SC-26 against a real in-memory SQLite: a patch is
 * all-or-nothing, a changed bastion never inherits the old one's
 * secrets, and vault deletes match ids literally.
 */

const holder = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('electron', async () => {
  const stub = await import('../../test/stubs/electron');
  return {
    ...stub,
    default: stub.default,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from(s),
      decryptString: (b: Buffer) => b.toString('utf8'),
    },
  };
});
vi.mock('./db', () => ({ getDb: () => holder.db }));
vi.mock('./logger', () => ({ logger: { info() {}, warn() {}, error() {} } }));

const { applySettingsPatch, getAllSettings } = await import('./settings');
const { ensureSecretsTable, getSecret, putSecret, deleteSshSecrets, deleteSecretsByPrefix } =
  await import('./vault');

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  ensureSecretsTable(db);
  holder.db = db;
  return db;
}

const ssh = (over: Record<string, unknown> = {}) => ({
  host: 'bastion-a',
  port: 22,
  user: 'ops',
  password: '',
  privateKey: '',
  passphrase: '',
  privateKeyPath: '',
  useAgent: false,
  ...over,
});

let db: Database.Database;
beforeEach(() => {
  db = freshDb();
});

describe('applySettingsPatch atomicity (SC-25)', () => {
  it('writes nothing when one field of the patch is invalid', () => {
    putSecret('ssh:keep:password', 'old-secret', db);
    expect(() =>
      applySettingsPatch({
        openrouterApiKey: 'sk-new',
        // Invalid: port must be a number.
        connectionSsh: { other: ssh({ port: 'not-a-port', password: 'x' }) },
      }),
    ).toThrow();
    expect(getSecret('setting:openrouterApiKey', db)).toBeNull();
    expect(getSecret('ssh:other:password', db)).toBeNull();
    expect(getSecret('ssh:keep:password', db)).toBe('old-secret');
  });

  it('rolls the vault back when a later write fails', () => {
    // Make the settings write blow up after the secrets were written.
    db.exec(
      `CREATE TRIGGER boom BEFORE INSERT ON settings BEGIN SELECT RAISE(ABORT, 'disk full'); END;`,
    );
    expect(() => applySettingsPatch({ openrouterApiKey: 'sk-new', theme: 'dark' })).toThrow(
      /disk full/,
    );
    expect(getSecret('setting:openrouterApiKey', db)).toBeNull();
  });

  it('stores a valid patch completely', () => {
    applySettingsPatch({
      openrouterApiKey: 'sk-ok',
      connectionSsh: { c1: ssh({ password: 'pw' }) },
    });
    expect(getSecret('setting:openrouterApiKey', db)).toBe('sk-ok');
    expect(getSecret('ssh:c1:password', db)).toBe('pw');
    expect((getAllSettings().connectionSsh as Record<string, unknown>).c1).toMatchObject({
      host: 'bastion-a',
    });
  });
});

describe('SSH secrets follow their bastion (SC-08)', () => {
  it('keeps stored secrets when the same bastion is saved with blank secrets', () => {
    applySettingsPatch({ connectionSsh: { c1: ssh({ password: 'pw' }) } });
    applySettingsPatch({ connectionSsh: { c1: ssh({ privateKeyPath: '/k' }) } });
    expect(getSecret('ssh:c1:password', db)).toBe('pw');
  });

  it('drops the old secrets when host / port / user changed and none were supplied', () => {
    applySettingsPatch({
      connectionSsh: { c1: ssh({ password: 'pw', privateKey: 'KEY', passphrase: 'pp' }) },
    });
    applySettingsPatch({ connectionSsh: { c1: ssh({ host: 'evil.example' }) } });
    expect(getSecret('ssh:c1:password', db)).toBeNull();
    expect(getSecret('ssh:c1:privateKey', db)).toBeNull();
    expect(getSecret('ssh:c1:passphrase', db)).toBeNull();
  });

  it('stores secrets supplied together with the changed target', () => {
    applySettingsPatch({ connectionSsh: { c1: ssh({ password: 'pw' }) } });
    applySettingsPatch({ connectionSsh: { c1: ssh({ host: 'bastion-b', password: 'new' }) } });
    expect(getSecret('ssh:c1:password', db)).toBe('new');
  });

  it('clears an individual secret on request, and not the others', () => {
    applySettingsPatch({
      connectionSsh: { c1: ssh({ password: 'pw', privateKey: 'KEY' }) },
    });
    applySettingsPatch({
      connectionSsh: { c1: ssh() },
      clearSshSecrets: { c1: ['password'] },
    });
    expect(getSecret('ssh:c1:password', db)).toBeNull();
    expect(getSecret('ssh:c1:privateKey', db)).toBe('KEY');
  });

  it('ignores a renderer attempt to pre-seed trusted host keys (SC-28)', () => {
    applySettingsPatch({ sshKnownHosts: { 'evil:22': { type: 'ssh-ed25519', key: 'AAAA' } } });
    expect(getAllSettings().sshKnownHosts).toBeUndefined();
  });
});

describe('vault prefix deletes are literal (SC-26)', () => {
  it("an id with '_' or '%' does not match other connections", () => {
    putSecret('ssh:a_b:password', 'one', db);
    putSecret('ssh:axb:password', 'two', db);
    putSecret('ssh:abc:password', 'three', db);
    deleteSshSecrets('a_b', db);
    expect(getSecret('ssh:a_b:password', db)).toBeNull();
    expect(getSecret('ssh:axb:password', db)).toBe('two');
    deleteSshSecrets('%', db);
    expect(getSecret('ssh:abc:password', db)).toBe('three');
  });

  it('is case-sensitive', () => {
    putSecret('os:ABC:token', 'x', db);
    deleteSecretsByPrefix('os:abc:', db);
    expect(getSecret('os:ABC:token', db)).toBe('x');
  });
});
