import type { ConnectionEngine } from './protocol';

/**
 * Engine / dialect adapter for the SQL workbench.
 *
 * The workbench (editor, result grid, table tabs, sidebar, export) was written
 * against Postgres. Everything that differs between SQL engines is gathered
 * here so the UI branches on `caps` and `dialect` instead of on engine names:
 *
 *   - `EngineCapabilities` — which features an engine offers (Safe Run, roles,
 *     pg_dump backup, health advisor, ER diagram, …). Surfaces consult these.
 *   - `SqlDialect` — identifier quoting, literals, LIKE/cast spelling, the
 *     row locator used for key-less edits, estimated counts, EXPLAIN.
 *
 * Bind parameters are written `$1, $2, …` by every caller (Postgres native).
 * The SQLite and MySQL drivers translate them with `translatePlaceholders`,
 * so SQL builders stay engine-neutral about parameters.
 */

export type SqlEngine = 'postgres' | 'sqlite' | 'mysql';

export const SQL_ENGINES: readonly SqlEngine[] = ['postgres', 'sqlite', 'mysql'];

/** True for engines driven through the SQL workbench. */
export function isSqlEngine(engine: string | null | undefined): engine is SqlEngine {
  return engine === 'postgres' || engine === 'sqlite' || engine === 'mysql';
}

export interface EngineCapabilities {
  /** Editor + result grid + table tabs + SQL sidebar. */
  sql: boolean;
  /** Query history / saved queries sidebar modes. */
  history: boolean;
  /** Live activity monitor (pg_stat_activity). */
  activity: boolean;
  /** Roles / session-role panel. */
  roles: boolean;
  /** Backup / restore through pg_dump / pg_restore / psql. */
  pgBackup: boolean;
  /** "Export database file copy" through the SQLite backup API. */
  fileBackup: boolean;
  /** ER diagram built from foreign keys. */
  er: boolean;
  /** Health advisor. */
  health: boolean;
  /** Safe Run (dry run of a write inside a rolled-back transaction). */
  safeRun: boolean;
  /** Visual EXPLAIN (any form). */
  explain: boolean;
  /** EXPLAIN ANALYZE variant. */
  explainAnalyze: boolean;
  /** Search-path / schema switcher in the top bar. */
  schemaSwitcher: boolean;
  /** Full structure editor (applyDdl, constraints, indexes). */
  structureEditor: boolean;
  /** Read-only structure view with simple ALTER (add / rename column). */
  structureView: boolean;
  /** File import wizard. */
  importFile: boolean;
  /** Postgres-only extras: RLS badge, pgvector, extensions, sequences. */
  pgExtras: boolean;
  /** A second connection for lookups (counts, autocomplete). */
  sideband: boolean;
  /** SSH tunnel supported. */
  ssh: boolean;
}

const PG_CAPS: EngineCapabilities = {
  sql: true,
  history: true,
  activity: true,
  roles: true,
  pgBackup: true,
  fileBackup: false,
  er: true,
  health: true,
  safeRun: true,
  explain: true,
  explainAnalyze: true,
  schemaSwitcher: true,
  structureEditor: true,
  structureView: true,
  importFile: true,
  pgExtras: true,
  sideband: true,
  ssh: true,
};

const SQLITE_CAPS: EngineCapabilities = {
  ...PG_CAPS,
  activity: false,
  roles: false,
  pgBackup: false,
  fileBackup: true,
  health: false,
  // Implemented through BEGIN + RETURNING (SQLite >= 3.35); see sqlite safe-run.
  safeRun: false,
  explainAnalyze: false,
  schemaSwitcher: false,
  structureEditor: false,
  importFile: false,
  pgExtras: false,
  sideband: false,
  ssh: false,
};

const MYSQL_CAPS: EngineCapabilities = {
  ...PG_CAPS,
  activity: false,
  roles: false,
  pgBackup: false,
  fileBackup: false,
  health: false,
  safeRun: false,
  explainAnalyze: false,
  schemaSwitcher: false,
  structureEditor: false,
  importFile: false,
  pgExtras: false,
  sideband: true,
  ssh: true,
};

const NO_CAPS: EngineCapabilities = {
  sql: false,
  history: false,
  activity: false,
  roles: false,
  pgBackup: false,
  fileBackup: false,
  er: false,
  health: false,
  safeRun: false,
  explain: false,
  explainAnalyze: false,
  schemaSwitcher: false,
  structureEditor: false,
  structureView: false,
  importFile: false,
  pgExtras: false,
  sideband: false,
  ssh: true,
};

/** Capabilities of `engine`; `null`/unknown means Postgres (the legacy default). */
export function engineCaps(
  engine: ConnectionEngine | string | null | undefined,
): EngineCapabilities {
  switch (engine ?? 'postgres') {
    case 'postgres':
      return PG_CAPS;
    case 'sqlite':
      return SQLITE_CAPS;
    case 'mysql':
      return MYSQL_CAPS;
    default:
      return NO_CAPS;
  }
}

/** Short display names, shared by the sidebar, the capsule and the dialog. */
export const ENGINE_NAMES: Record<ConnectionEngine, string> = {
  postgres: 'Postgres',
  redis: 'Redis',
  opensearch: 'OpenSearch',
  sqlite: 'SQLite',
  mysql: 'MySQL',
};

export const ENGINE_DEFAULT_PORTS: Record<ConnectionEngine, number> = {
  postgres: 5432,
  redis: 6379,
  opensearch: 9200,
  sqlite: 1,
  mysql: 3306,
};

export type LikeOp = 'LIKE' | 'ILIKE' | 'NOT LIKE' | 'NOT ILIKE';

export interface SqlDialect {
  readonly engine: SqlEngine;
  readonly caps: EngineCapabilities;
  /** Quote an identifier. */
  quoteIdent(name: string): string;
  /** `schema.table`, or just the table where the engine has no schema layer. */
  qualify(schema: string | undefined, table: string): string;
  /** Escape `text` as a string literal. */
  quoteText(text: string): string;
  /** Render a JS value as a SQL literal (export, scripts). */
  literal(value: unknown): string;
  /** `expr` cast to text, for LIKE filters on non-text columns. */
  textCast(expr: string): string;
  /** `col [NOT] LIKE <placeholder>` with the engine's escape handling. */
  likePredicate(col: string, op: LikeOp, placeholder: string): string;
  /** Statement inserting a row of defaults. */
  insertDefaults(target: string): string;
  /** Pseudo-column identifying a row when the table has no primary key. */
  rowLocator: 'ctid' | 'rowid' | null;
  /** SQL for an approximate row count without a scan (one `$n` per param). */
  estimatedCount(schema: string, table: string): { sql: string; params: unknown[] } | null;
  /** EXPLAIN statement text for one statement. */
  explain(sql: string, analyze: boolean): string;
}

function singleQuoted(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

function numberOrText(value: number, quote: (t: string) => string): string {
  return Number.isFinite(value) ? String(value) : quote(String(value));
}

function stripTrailingSemicolon(sql: string): string {
  return sql.trim().replace(/;\s*$/, '');
}

const POSTGRES: SqlDialect = {
  engine: 'postgres',
  caps: PG_CAPS,
  quoteIdent: (name) => `"${name.replace(/"/g, '""')}"`,
  qualify(schema, table) {
    return schema ? `${this.quoteIdent(schema)}.${this.quoteIdent(table)}` : this.quoteIdent(table);
  },
  quoteText: singleQuoted,
  literal(value) {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') return numberOrText(value, singleQuoted);
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Date) return singleQuoted(value.toISOString());
    if (typeof value === 'object') return singleQuoted(JSON.stringify(value));
    return singleQuoted(String(value));
  },
  textCast: (expr) => `${expr}::text`,
  likePredicate: (col, op, ph) => `${col}::text ${op} ${ph}`,
  insertDefaults: (target) => `INSERT INTO ${target} DEFAULT VALUES`,
  rowLocator: 'ctid',
  estimatedCount: (schema, table) => ({
    sql: `SELECT reltuples::bigint AS estimate
          FROM pg_class
          WHERE oid = $1::regclass`,
    params: [`${POSTGRES.quoteIdent(schema)}.${POSTGRES.quoteIdent(table)}`],
  }),
  explain: (sql, analyze) =>
    `EXPLAIN (${analyze ? 'ANALYZE, BUFFERS, VERBOSE, FORMAT JSON' : 'VERBOSE, FORMAT JSON'}) ${stripTrailingSemicolon(sql)}`,
};

const SQLITE: SqlDialect = {
  engine: 'sqlite',
  caps: SQLITE_CAPS,
  quoteIdent: (name) => `"${name.replace(/"/g, '""')}"`,
  qualify(schema, table) {
    return schema ? `${this.quoteIdent(schema)}.${this.quoteIdent(table)}` : this.quoteIdent(table);
  },
  quoteText: singleQuoted,
  literal(value) {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') return numberOrText(value, singleQuoted);
    // SQLite has no boolean type; 1/0 is what `true`/`false` mean there.
    if (typeof value === 'boolean') return value ? '1' : '0';
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Date) return singleQuoted(value.toISOString());
    if (typeof value === 'object') return singleQuoted(JSON.stringify(value));
    return singleQuoted(String(value));
  },
  textCast: (expr) => `CAST(${expr} AS TEXT)`,
  // LIKE is already case-insensitive for ASCII in SQLite; ESCAPE makes the
  // backslash escapes the builders emit mean something.
  likePredicate: (col, op, ph) =>
    `${SQLITE.textCast(col)} ${op.replace('ILIKE', 'LIKE')} ${ph} ESCAPE '\\'`,
  insertDefaults: (target) => `INSERT INTO ${target} DEFAULT VALUES`,
  rowLocator: 'rowid',
  estimatedCount: () => null,
  explain: (sql) => `EXPLAIN QUERY PLAN ${stripTrailingSemicolon(sql)}`,
};

function mysqlText(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: MySQL escapes NUL and Ctrl-Z in literals
  return `'${text.replace(/[\\'\0\n\r\x1a]/g, (ch) => {
    switch (ch) {
      case '\\':
        return '\\\\';
      case "'":
        return "''";
      case '\0':
        return '\\0';
      case '\n':
        return '\\n';
      case '\r':
        return '\\r';
      default:
        return '\\Z';
    }
  })}'`;
}

const MYSQL: SqlDialect = {
  engine: 'mysql',
  caps: MYSQL_CAPS,
  quoteIdent: (name) => `\`${name.replace(/`/g, '``')}\``,
  qualify(schema, table) {
    return schema ? `${this.quoteIdent(schema)}.${this.quoteIdent(table)}` : this.quoteIdent(table);
  },
  quoteText: mysqlText,
  literal(value) {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') return numberOrText(value, mysqlText);
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Date)
      return mysqlText(value.toISOString().replace('T', ' ').replace('Z', ''));
    if (typeof value === 'object') return mysqlText(JSON.stringify(value));
    return mysqlText(String(value));
  },
  textCast: (expr) => `CAST(${expr} AS CHAR)`,
  likePredicate: (col, op, ph) => `${MYSQL.textCast(col)} ${op.replace('ILIKE', 'LIKE')} ${ph}`,
  insertDefaults: (target) => `INSERT INTO ${target} () VALUES ()`,
  rowLocator: null,
  estimatedCount: (schema, table) => ({
    sql: `SELECT table_rows AS estimate
          FROM information_schema.tables
          WHERE table_schema = $1 AND table_name = $2`,
    params: [schema, table],
  }),
  explain: (sql, analyze) =>
    `EXPLAIN ${analyze ? 'ANALYZE ' : 'FORMAT=JSON '}${stripTrailingSemicolon(sql)}`,
};

export const POSTGRES_DIALECT: SqlDialect = POSTGRES;
export const SQLITE_DIALECT: SqlDialect = SQLITE;
export const MYSQL_DIALECT: SqlDialect = MYSQL;

/** Dialect of a SQL engine; non-SQL engines and `null` fall back to Postgres. */
export function dialectFor(engine: ConnectionEngine | string | null | undefined): SqlDialect {
  if (engine === 'sqlite') return SQLITE;
  if (engine === 'mysql') return MYSQL;
  return POSTGRES;
}

// ─── Placeholder translation ─────────────────────────────────────────

/**
 * Rewrite `$n` placeholders to positional `?` markers (SQLite, MySQL) and
 * return the parameter list in marker order, repeating a value used twice.
 * `$n` inside string literals, quoted identifiers and comments is untouched.
 * `backslashEscapes` (MySQL) makes `\\'` inside a string an escaped quote.
 */
export function translatePlaceholders(
  sql: string,
  params: readonly unknown[] = [],
  opts: { backslashEscapes?: boolean } = {},
): { sql: string; params: unknown[] } {
  let out = '';
  const ordered: unknown[] = [];
  const N = sql.length;
  let i = 0;
  while (i < N) {
    const c = sql[i]!;
    if (c === "'" || c === '"' || c === '`') {
      // Quoted run: a doubled quote is an escape; MySQL strings also take backslashes.
      let j = i + 1;
      while (j < N) {
        if (opts.backslashEscapes && c !== '`' && sql[j] === '\\') j += 2;
        else if (sql[j] === c) {
          if (sql[j + 1] === c) j += 2;
          else break;
        } else j++;
      }
      out += sql.slice(i, Math.min(j + 1, N));
      i = j + 1;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? N : nl + 1;
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      const end = close === -1 ? N : close + 2;
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    if (c === '$' && /[0-9]/.test(sql[i + 1] ?? '') && !/[A-Za-z0-9_$]/.test(sql[i - 1] ?? '')) {
      let j = i + 1;
      while (j < N && /[0-9]/.test(sql[j]!)) j++;
      const n = Number(sql.slice(i + 1, j));
      if (n < 1 || n > params.length) {
        throw new Error(`placeholder $${n} has no bound value (${params.length} given)`);
      }
      ordered.push(params[n - 1]);
      out += '?';
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return { sql: out, params: ordered };
}
