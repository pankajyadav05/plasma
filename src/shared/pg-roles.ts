/**
 * Role & privilege SQL for the Roles dialog: catalog queries plus pure
 * builders for CREATE / ALTER / DROP ROLE, role membership and table
 * GRANT / REVOKE. Identifiers are always quoted; literals are escaped.
 * Nothing here executes SQL — the dialog shows the statements ("Preview
 * SQL") and applies them through the prod gate.
 */

export const TABLE_PRIVILEGES = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
] as const;
export type TablePrivilege = (typeof TABLE_PRIVILEGES)[number];

export interface RoleAttrs {
  login: boolean;
  superuser: boolean;
  createdb: boolean;
  createrole: boolean;
  inherit: boolean;
  replication: boolean;
  bypassrls: boolean;
  /** -1 = unlimited. */
  connLimit: number;
  /** ISO-ish timestamp, or null for "infinity". */
  validUntil: string | null;
}

export interface RoleDraft {
  name: string;
  attrs: RoleAttrs;
  /** Roles this role is a member of. */
  memberOf: string[];
  /** New password (create / alter). null = leave alone. */
  password?: string | null;
}

export interface RoleRow extends RoleDraft {
  /** Roles that are members of this one. */
  members: string[];
  /** pg_roles.oid — handy for keys. */
  oid: number;
}

export interface SqlStatement {
  /** What runs. */
  sql: string;
  /** What the preview shows (secrets masked). */
  display: string;
}

export const DEFAULT_ROLE_ATTRS: RoleAttrs = {
  login: false,
  superuser: false,
  createdb: false,
  createrole: false,
  inherit: true,
  replication: false,
  bypassrls: false,
  connLimit: -1,
  validUntil: null,
};

export const q = (ident: string): string => `"${ident.replaceAll('"', '""')}"`;

/** String literal safe regardless of standard_conforming_strings. */
export function lit(value: string): string {
  const body = value.replaceAll('\\', '\\\\').replaceAll("'", "''");
  return value.includes('\\') ? `E'${body}'` : `'${body}'`;
}

export const LIST_ROLES_SQL = `SELECT r.oid::int AS oid, r.rolname, r.rolsuper, r.rolinherit, r.rolcreaterole,
  r.rolcreatedb, r.rolcanlogin, r.rolreplication, r.rolbypassrls, r.rolconnlimit,
  r.rolvaliduntil::text AS valid_until,
  COALESCE((SELECT json_agg(g.rolname ORDER BY g.rolname) FROM pg_auth_members m
    JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid), '[]'::json)::text AS member_of,
  COALESCE((SELECT json_agg(u.rolname ORDER BY u.rolname) FROM pg_auth_members m
    JOIN pg_roles u ON u.oid = m.member WHERE m.roleid = r.oid), '[]'::json)::text AS members
FROM pg_roles r
WHERE r.rolname !~ '^pg_'
ORDER BY r.rolname`;

function parseNames(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') {
    try {
      const parsed: unknown = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Map a LIST_ROLES_SQL result to rows. */
export function parseRoleRows(
  columns: readonly { name: string }[],
  rows: readonly unknown[][],
): RoleRow[] {
  const at = (name: string) => columns.findIndex((c) => c.name === name);
  const ix = {
    oid: at('oid'),
    name: at('rolname'),
    su: at('rolsuper'),
    inh: at('rolinherit'),
    cr: at('rolcreaterole'),
    cdb: at('rolcreatedb'),
    login: at('rolcanlogin'),
    repl: at('rolreplication'),
    byp: at('rolbypassrls'),
    lim: at('rolconnlimit'),
    until: at('valid_until'),
    of: at('member_of'),
    members: at('members'),
  };
  return rows.map((r) => {
    const until = r[ix.until];
    return {
      oid: Number(r[ix.oid]),
      name: String(r[ix.name]),
      attrs: {
        superuser: r[ix.su] === true,
        inherit: r[ix.inh] === true,
        createrole: r[ix.cr] === true,
        createdb: r[ix.cdb] === true,
        login: r[ix.login] === true,
        replication: r[ix.repl] === true,
        bypassrls: r[ix.byp] === true,
        connLimit: Number(r[ix.lim]),
        validUntil: typeof until === 'string' && until !== 'infinity' ? until : null,
      },
      memberOf: parseNames(r[ix.of]),
      members: parseNames(r[ix.members]),
    };
  });
}

const FLAGS: readonly [keyof RoleAttrs, string, string][] = [
  ['superuser', 'SUPERUSER', 'NOSUPERUSER'],
  ['createdb', 'CREATEDB', 'NOCREATEDB'],
  ['createrole', 'CREATEROLE', 'NOCREATEROLE'],
  ['inherit', 'INHERIT', 'NOINHERIT'],
  ['login', 'LOGIN', 'NOLOGIN'],
  ['replication', 'REPLICATION', 'NOREPLICATION'],
  ['bypassrls', 'BYPASSRLS', 'NOBYPASSRLS'],
];

function attrClauses(next: RoleAttrs, prev: RoleAttrs | null): string[] {
  const out: string[] = [];
  for (const [key, on, off] of FLAGS) {
    if (prev && prev[key] === next[key]) continue;
    out.push(next[key] ? on : off);
  }
  if (!prev || prev.connLimit !== next.connLimit) {
    out.push(`CONNECTION LIMIT ${Math.trunc(next.connLimit)}`);
  }
  if (!prev || prev.validUntil !== next.validUntil) {
    if (next.validUntil !== null || prev)
      out.push(`VALID UNTIL ${lit(next.validUntil ?? 'infinity')}`);
  }
  return out;
}

function passwordClause(
  password: string | null | undefined,
): { sql: string; display: string } | null {
  if (password === undefined || password === null) return null;
  return { sql: `PASSWORD ${lit(password)}`, display: "PASSWORD '********'" };
}

function withClauses(
  head: string,
  clauses: string[],
  pw: ReturnType<typeof passwordClause>,
): SqlStatement | null {
  if (clauses.length === 0 && !pw) return null;
  const list = (extra: string | undefined) => [...clauses, ...(extra ? [extra] : [])].join(' ');
  return {
    sql: `${head} WITH ${list(pw?.sql)}`,
    display: `${head} WITH ${list(pw?.display)}`,
  };
}

export function grantMembership(role: string, member: string): SqlStatement {
  const s = `GRANT ${q(role)} TO ${q(member)}`;
  return { sql: s, display: s };
}

export function revokeMembership(role: string, member: string): SqlStatement {
  const s = `REVOKE ${q(role)} FROM ${q(member)}`;
  return { sql: s, display: s };
}

export function createRoleStatements(draft: RoleDraft): SqlStatement[] {
  const name = draft.name.trim();
  if (!name) throw new Error('A role needs a name.');
  const head = `CREATE ROLE ${q(name)}`;
  const clauses = attrClauses(draft.attrs, DEFAULT_ROLE_ATTRS);
  // CREATE ROLE defaults match DEFAULT_ROLE_ATTRS except we always spell out
  // LOGIN so the preview is explicit.
  if (!clauses.includes(draft.attrs.login ? 'LOGIN' : 'NOLOGIN')) {
    clauses.unshift(draft.attrs.login ? 'LOGIN' : 'NOLOGIN');
  }
  const stmt = withClauses(head, clauses, passwordClause(draft.password)) ?? {
    sql: head,
    display: head,
  };
  return [stmt, ...draft.memberOf.map((g) => grantMembership(g, name))];
}

export function alterRoleStatements(prev: RoleDraft, next: RoleDraft): SqlStatement[] {
  const out: SqlStatement[] = [];
  const newName = next.name.trim();
  if (!newName) throw new Error('A role needs a name.');
  if (newName !== prev.name) {
    const s = `ALTER ROLE ${q(prev.name)} RENAME TO ${q(newName)}`;
    out.push({ sql: s, display: s });
  }
  const alter = withClauses(
    `ALTER ROLE ${q(newName)}`,
    attrClauses(next.attrs, prev.attrs),
    passwordClause(next.password),
  );
  if (alter) out.push(alter);
  const before = new Set(prev.memberOf);
  const after = new Set(next.memberOf);
  for (const g of [...after].filter((g) => !before.has(g))) out.push(grantMembership(g, newName));
  for (const g of [...before].filter((g) => !after.has(g))) out.push(revokeMembership(g, newName));
  return out;
}

export function dropRoleStatements(name: string): SqlStatement[] {
  const s = `DROP ROLE ${q(name)}`;
  return [{ sql: s, display: s }];
}

// ─── Table privileges ────────────────────────────────────────────────

export type RelKind = 'r' | 'p' | 'v' | 'm' | 'f';

export interface PrivilegeRow {
  schema: string;
  table: string;
  kind: RelKind;
  /** Direct grants to the role. */
  privileges: TablePrivilege[];
}

/** Privileges that make sense for a relation kind. */
export function applicablePrivileges(kind: RelKind): readonly TablePrivilege[] {
  switch (kind) {
    case 'r':
    case 'p':
      return TABLE_PRIVILEGES;
    case 'f':
      return ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
    default:
      return ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRIGGER'];
  }
}

export const PRIVILEGES_ROW_CAP = 1500;

/**
 * Direct table grants held by `$1` (role name), optionally narrowed to a
 * schema (`$2`) and a table-name substring (`$3`). Pass '' for "any".
 */
export const ROLE_PRIVILEGES_SQL = `SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind,
  COALESCE(json_agg(DISTINCT a.privilege_type) FILTER (WHERE a.privilege_type IS NOT NULL), '[]'::json)::text AS privs
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN LATERAL (
  SELECT x.privilege_type FROM aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) x
  WHERE x.grantee = (SELECT oid FROM pg_roles WHERE rolname = $1)
) a ON true
WHERE c.relkind IN ('r','p','v','m','f')
  AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
  AND ($2 = '' OR n.nspname = $2)
  AND ($3 = '' OR c.relname ILIKE '%' || $3 || '%')
GROUP BY n.nspname, c.relname, c.relkind
ORDER BY n.nspname, c.relname
LIMIT ${PRIVILEGES_ROW_CAP}`;

export function parsePrivilegeRows(rows: readonly unknown[][]): PrivilegeRow[] {
  const known = new Set<string>(TABLE_PRIVILEGES);
  return rows.map((r) => ({
    schema: String(r[0]),
    table: String(r[1]),
    kind: String(r[2]) as RelKind,
    privileges: parseNames(r[3]).filter((p): p is TablePrivilege => known.has(p)),
  }));
}

export interface PrivilegeChange {
  schema: string;
  table: string;
  grant: TablePrivilege[];
  revoke: TablePrivilege[];
}

function ordered(list: readonly TablePrivilege[]): TablePrivilege[] {
  return TABLE_PRIVILEGES.filter((p) => list.includes(p));
}

export function privilegeStatements(
  role: string,
  changes: readonly PrivilegeChange[],
): SqlStatement[] {
  const out: SqlStatement[] = [];
  for (const c of changes) {
    const target = `TABLE ${q(c.schema)}.${q(c.table)}`;
    if (c.revoke.length > 0) {
      const s = `REVOKE ${ordered(c.revoke).join(', ')} ON ${target} FROM ${q(role)}`;
      out.push({ sql: s, display: s });
    }
    if (c.grant.length > 0) {
      const s = `GRANT ${ordered(c.grant).join(', ')} ON ${target} TO ${q(role)}`;
      out.push({ sql: s, display: s });
    }
  }
  return out;
}

/** Diff a staged privilege map (`schema.table` → privileges) against the loaded rows. */
export function diffPrivileges(
  loaded: readonly PrivilegeRow[],
  staged: ReadonlyMap<string, ReadonlySet<TablePrivilege>>,
): PrivilegeChange[] {
  const out: PrivilegeChange[] = [];
  for (const row of loaded) {
    const key = privKey(row.schema, row.table);
    const want = staged.get(key);
    if (!want) continue;
    const have = new Set(row.privileges);
    const grant = [...want].filter((p) => !have.has(p));
    const revoke = [...have].filter((p) => !want.has(p));
    if (grant.length || revoke.length) {
      out.push({ schema: row.schema, table: row.table, grant, revoke });
    }
  }
  return out;
}

export const privKey = (schema: string, table: string): string => `${schema}\u0000${table}`;
