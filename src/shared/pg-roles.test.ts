import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROLE_ATTRS,
  type RoleDraft,
  alterRoleStatements,
  applicablePrivileges,
  createRoleStatements,
  diffPrivileges,
  dropRoleStatements,
  lit,
  parsePrivilegeRows,
  parseRoleRows,
  privKey,
  privilegeStatements,
  q,
} from './pg-roles';

const draft = (over: Partial<RoleDraft> = {}): RoleDraft => ({
  name: 'app',
  attrs: { ...DEFAULT_ROLE_ATTRS },
  memberOf: [],
  ...over,
});

describe('quoting', () => {
  it('quotes identifiers and literals', () => {
    expect(q('a"b')).toBe('"a""b"');
    expect(lit("it's")).toBe("'it''s'");
    expect(lit('a\\b')).toBe("E'a\\\\b'");
  });
});

describe('createRoleStatements', () => {
  it('spells out attributes and masks the password in the preview', () => {
    const [s] = createRoleStatements(
      draft({
        attrs: {
          ...DEFAULT_ROLE_ATTRS,
          login: true,
          createdb: true,
          connLimit: 5,
          validUntil: '2030-01-01',
        },
        password: "p'w",
      }),
    );
    expect(s?.sql).toContain('CREATE ROLE "app" WITH');
    expect(s?.sql).toContain('LOGIN');
    expect(s?.sql).toContain('CREATEDB');
    expect(s?.sql).toContain('CONNECTION LIMIT 5');
    expect(s?.sql).toContain("VALID UNTIL '2030-01-01'");
    expect(s?.sql).toContain("PASSWORD 'p''w'");
    expect(s?.display).not.toContain("p''w");
    expect(s?.display).toContain("PASSWORD '********'");
  });

  it('adds membership grants', () => {
    const out = createRoleStatements(draft({ memberOf: ['readers'] }));
    expect(out.map((s) => s.sql)).toEqual([
      expect.stringContaining('NOLOGIN'),
      'GRANT "readers" TO "app"',
    ]);
  });

  it('rejects empty names and neutralises hostile ones', () => {
    expect(() => createRoleStatements(draft({ name: '  ' }))).toThrow();
    expect(createRoleStatements(draft({ name: 'x"; DROP ROLE y; --' }))[0]?.sql).toContain(
      'CREATE ROLE "x""; DROP ROLE y; --"',
    );
  });
});

describe('alterRoleStatements', () => {
  it('emits only what changed', () => {
    const prev = draft({ memberOf: ['a', 'b'] });
    const next = draft({
      name: 'app2',
      attrs: { ...prev.attrs, login: true, connLimit: 3 },
      memberOf: ['b', 'c'],
    });
    expect(alterRoleStatements(prev, next).map((s) => s.sql)).toEqual([
      'ALTER ROLE "app" RENAME TO "app2"',
      'ALTER ROLE "app2" WITH LOGIN CONNECTION LIMIT 3',
      'GRANT "c" TO "app2"',
      'REVOKE "a" FROM "app2"',
    ]);
  });

  it('no changes -> no statements; password only -> ALTER ... PASSWORD', () => {
    expect(alterRoleStatements(draft(), draft())).toEqual([]);
    const [s] = alterRoleStatements(draft(), draft({ password: 'x' }));
    expect(s?.sql).toBe('ALTER ROLE "app" WITH PASSWORD \'x\'');
    expect(s?.display).toBe('ALTER ROLE "app" WITH PASSWORD \'********\'');
  });

  it('clears valid-until with infinity', () => {
    const prev = draft({ attrs: { ...DEFAULT_ROLE_ATTRS, validUntil: '2030-01-01' } });
    expect(alterRoleStatements(prev, draft())[0]?.sql).toBe(
      'ALTER ROLE "app" WITH VALID UNTIL \'infinity\'',
    );
  });

  it('drop', () => {
    expect(dropRoleStatements('a"b')[0]?.sql).toBe('DROP ROLE "a""b"');
  });
});

describe('privileges', () => {
  it('builds GRANT / REVOKE in canonical order', () => {
    const out = privilegeStatements('r', [
      { schema: 's', table: 't', grant: ['UPDATE', 'SELECT'], revoke: ['TRIGGER'] },
    ]);
    expect(out.map((s) => s.sql)).toEqual([
      'REVOKE TRIGGER ON TABLE "s"."t" FROM "r"',
      'GRANT SELECT, UPDATE ON TABLE "s"."t" TO "r"',
    ]);
  });

  it('diffs staged state against the loaded grants', () => {
    const loaded = parsePrivilegeRows([
      ['s', 't', 'r', '["SELECT","INSERT"]'],
      ['s', 'u', 'v', '[]'],
    ]);
    const staged = new Map([
      [privKey('s', 't'), new Set(['SELECT', 'DELETE'] as const)],
      [privKey('s', 'u'), new Set([] as never[])],
    ]);
    expect(diffPrivileges(loaded, staged as never)).toEqual([
      { schema: 's', table: 't', grant: ['DELETE'], revoke: ['INSERT'] },
    ]);
  });

  it('limits privileges by relation kind', () => {
    expect(applicablePrivileges('v')).not.toContain('TRUNCATE');
    expect(applicablePrivileges('r')).toContain('TRUNCATE');
  });
});

describe('parseRoleRows', () => {
  it('maps catalog rows', () => {
    const cols = [
      'oid',
      'rolname',
      'rolsuper',
      'rolinherit',
      'rolcreaterole',
      'rolcreatedb',
      'rolcanlogin',
      'rolreplication',
      'rolbypassrls',
      'rolconnlimit',
      'valid_until',
      'member_of',
      'members',
    ].map((name) => ({ name }));
    const [r] = parseRoleRows(cols, [
      [1, 'bob', false, true, false, true, true, false, false, -1, 'infinity', '["g"]', '[]'],
    ]);
    expect(r).toMatchObject({ name: 'bob', memberOf: ['g'], members: [] });
    expect(r?.attrs).toMatchObject({
      login: true,
      createdb: true,
      validUntil: null,
      connLimit: -1,
    });
  });
});
