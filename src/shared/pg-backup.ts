import { z } from 'zod';

/**
 * Pure builders for pg_dump / pg_restore / psql invocations.
 *
 * Everything user-controlled is passed as a separate argv element in
 * `--long=value` form (so a value can never be read as another option),
 * and the database name is handed to pg_dump / psql through PGDATABASE
 * rather than `--dbname` (libpq treats a `--dbname` containing `=` or a
 * `postgres://` prefix as a whole connection string). pg_restore has no
 * env-only form, so its target name is validated instead.
 */

export const BACKUP_FORMATS = ['custom', 'plain', 'directory', 'tar'] as const;
export type BackupFormat = (typeof BACKUP_FORMATS)[number];

const noNul = (s: string) => !s.includes('\0');
const safeString = z.string().min(1).refine(noNul, 'must not contain NUL');

export const PgTool = z.enum(['pg_dump', 'pg_restore', 'psql']);
export type PgTool = z.infer<typeof PgTool>;

export const TableRef = z.object({ schema: safeString, table: safeString });
export type TableRef = z.infer<typeof TableRef>;

export const BackupRequest = z.object({
  database: safeString,
  format: z.enum(BACKUP_FORMATS).default('custom'),
  scope: z.enum(['all', 'dataOnly', 'schemaOnly']).default('all'),
  noOwner: z.boolean().default(false),
  noPrivileges: z.boolean().default(false),
  /** Plain format only: gzip the script (level 6). */
  gzip: z.boolean().default(false),
  /** Include only these schemas (empty = all). */
  schemas: z.array(safeString).default([]),
  /** Include only these tables (empty = all). */
  tables: z.array(TableRef).default([]),
  /** Directory format only: parallel workers. */
  jobs: z.number().int().min(1).max(32).optional(),
  outputPath: safeString,
});
export type BackupRequest = z.infer<typeof BackupRequest>;

export const RestoreRequest = z.object({
  filePath: safeString,
  database: safeString,
  /** How the file is read; `detectRestoreKind` picks this in the UI. */
  kind: z.enum(['archive', 'plain']),
  clean: z.boolean().default(false),
  ifExists: z.boolean().default(false),
  noOwner: z.boolean().default(false),
  noPrivileges: z.boolean().default(false),
  singleTransaction: z.boolean().default(false),
  jobs: z.number().int().min(1).max(32).optional(),
});
export type RestoreRequest = z.infer<typeof RestoreRequest>;

/** Where to connect — already resolved to the tunnel's local endpoint when tunnelled. */
export interface PgEndpoint {
  host: string;
  port: number;
  user: string;
  password: string;
  ssl: boolean;
  /**
   * libpq sslmode. When set it wins over `ssl`; without it `ssl: true`
   * means `require`. Forward the connection's own mode (SC-09) so a
   * verify-full connection is never silently downgraded for backups.
   */
  sslMode?: 'disable' | 'prefer' | 'require' | 'verify-ca' | 'verify-full';
  /** Absolute paths of the CA / client certificate / client key files. */
  sslRootCert?: string;
  sslCert?: string;
  sslKey?: string;
  /**
   * Numeric address to dial instead of resolving `host` (libpq hostaddr).
   * With an SSH tunnel `host` stays the real server name — so certificate
   * verification checks the right name — and this is the tunnel's local end.
   */
  hostAddr?: string;
}

/** A finished argv + environment, ready for `spawn(bin, args, { env })`. */
export interface ToolInvocation {
  tool: PgTool;
  args: string[];
  /** Only the PG* variables to add; the caller merges with process.env. */
  env: Record<string, string>;
  /** Log-safe one-line rendering (no password). */
  display: string;
}

/** Quote one identifier the way pg_dump's `--table` / `--schema` patterns expect. */
export function quotePattern(ident: string): string {
  return `"${ident.replaceAll('"', '""')}"`;
}

function baseArgs(ep: PgEndpoint): string[] {
  const args = [`--host=${ep.host}`, `--port=${ep.port}`];
  if (ep.user) args.push(`--username=${ep.user}`);
  args.push('--no-password');
  return args;
}

function baseEnv(ep: PgEndpoint, database: string | null): Record<string, string> {
  const env: Record<string, string> = {};
  if (ep.password) env.PGPASSWORD = ep.password;
  const mode = ep.sslMode ?? (ep.ssl ? 'require' : undefined);
  if (mode) env.PGSSLMODE = mode;
  if (ep.sslRootCert) env.PGSSLROOTCERT = ep.sslRootCert;
  if (ep.sslCert) env.PGSSLCERT = ep.sslCert;
  if (ep.sslKey) env.PGSSLKEY = ep.sslKey;
  if (ep.hostAddr) env.PGHOSTADDR = ep.hostAddr;
  if (database !== null) env.PGDATABASE = database;
  return env;
}

/** Where psql must read its (empty) startup file from, so ~/.psqlrc never runs (SC-16). */
export function nullDevice(
  platform: string = typeof process === 'undefined' ? '' : process.platform,
): string {
  return platform === 'win32' ? 'NUL' : '/dev/null';
}

function render(tool: string, args: readonly string[]): string {
  const q = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`);
  return [tool, ...args.map(q)].join(' ');
}

const FORMAT_FLAG: Record<BackupFormat, string> = {
  custom: 'c',
  plain: 'p',
  directory: 'd',
  tar: 't',
};

/** Suggested file name / extension for a backup format. */
export function defaultBackupName(database: string, format: BackupFormat, gzip: boolean): string {
  const stem = database.replace(/[^\w.-]+/g, '_') || 'database';
  switch (format) {
    case 'custom':
      return `${stem}.dump`;
    case 'tar':
      return `${stem}.tar`;
    case 'directory':
      return `${stem}.dir`;
    default:
      return gzip ? `${stem}.sql.gz` : `${stem}.sql`;
  }
}

export function buildPgDumpInvocation(reqIn: BackupRequest, ep: PgEndpoint): ToolInvocation {
  const req = BackupRequest.parse(reqIn);
  const args = [...baseArgs(ep), `--format=${FORMAT_FLAG[req.format]}`, `--file=${req.outputPath}`];
  args.push('--verbose');
  if (req.scope === 'dataOnly') args.push('--data-only');
  if (req.scope === 'schemaOnly') args.push('--schema-only');
  if (req.noOwner) args.push('--no-owner');
  if (req.noPrivileges) args.push('--no-privileges');
  if (req.format === 'plain' && req.gzip) args.push('--compress=6');
  if (req.format === 'directory' && req.jobs && req.jobs > 1) args.push(`--jobs=${req.jobs}`);
  for (const s of req.schemas) args.push(`--schema=${quotePattern(s)}`);
  for (const t of req.tables) {
    args.push(`--table=${quotePattern(t.schema)}.${quotePattern(t.table)}`);
  }
  return {
    tool: 'pg_dump',
    args,
    env: baseEnv(ep, req.database),
    display: render('pg_dump', args),
  };
}

/** libpq expands a `dbname` that looks like a connection string — refuse those. */
export function isSafeRestoreDatabaseName(name: string): boolean {
  if (!name || !noNul(name)) return false;
  if (name.includes('=')) return false;
  if (/^postgres(ql)?:\/\//i.test(name)) return false;
  return true;
}

export function buildPgRestoreInvocation(reqIn: RestoreRequest, ep: PgEndpoint): ToolInvocation {
  const req = RestoreRequest.parse(reqIn);
  if (req.kind === 'plain') {
    // psql reads the script from a file (or stdin for .gz, see the caller).
    const args = [
      ...baseArgs(ep),
      // SC-16: never run the user's ~/.psqlrc (it can reset ON_ERROR_STOP
      // or run shell commands); the script is the only thing that executes.
      '--no-psqlrc',
      '--set=ON_ERROR_STOP=1',
      ...(req.singleTransaction ? ['--single-transaction'] : []),
      '--file=-',
    ];
    return {
      tool: 'psql',
      args,
      env: { ...baseEnv(ep, req.database), PSQLRC: nullDevice() },
      display: render('psql', [...args.slice(0, -1), `--file=${req.filePath}`]),
    };
  }
  if (!isSafeRestoreDatabaseName(req.database)) {
    throw new Error('This database name cannot be passed to pg_restore safely.');
  }
  const args = [...baseArgs(ep), `--dbname=${req.database}`, '--verbose'];
  if (req.clean) args.push('--clean');
  // --if-exists is only valid together with --clean.
  if (req.clean && req.ifExists) args.push('--if-exists');
  if (req.noOwner) args.push('--no-owner');
  if (req.noPrivileges) args.push('--no-privileges');
  // pg_restore refuses --single-transaction together with --jobs.
  if (req.singleTransaction) args.push('--single-transaction');
  else if (req.jobs && req.jobs > 1) args.push(`--jobs=${req.jobs}`);
  // `--` so a file name starting with '-' is never parsed as an option.
  args.push('--', req.filePath);
  return {
    tool: 'pg_restore',
    args,
    env: baseEnv(ep, null),
    display: render('pg_restore', args),
  };
}

/** Pick pg_restore vs psql from the file name and its first bytes. */
export function detectRestoreKind(
  filePath: string,
  head: Uint8Array | null,
  isDirectory = false,
): 'archive' | 'plain' {
  if (isDirectory) return 'archive';
  if (head && head.length >= 5) {
    const magic = String.fromCharCode(...head.slice(0, 5));
    if (magic === 'PGDMP') return 'archive';
  }
  // A tar archive has "ustar" at offset 257.
  if (head && head.length >= 262 && String.fromCharCode(...head.slice(257, 262)) === 'ustar') {
    return 'archive';
  }
  if (/\.(dump|backup|tar|pgdump)$/i.test(filePath) && !head) return 'archive';
  return 'plain';
}

// ─── Tool versions ───────────────────────────────────────────────────

/** `pg_dump (PostgreSQL) 16.3 (Ubuntu …)` → 16 (9.6 for the old scheme). */
export function parseToolMajor(output: string): number | null {
  const m = /(\d+)\.(\d+)/.exec(output) ?? /(\d+)/.exec(output);
  if (!m) return null;
  const major = Number(m[1]);
  if (major >= 10) return major;
  return m[2] ? Number(`${major}.${m[2]}`) : major;
}

/** Server major from `server_version` / a version banner. */
export function parseServerMajor(serverVersion: string): number | null {
  return parseToolMajor(serverVersion);
}

export type VersionCheck = { level: 'ok' | 'warn' | 'error'; message: string | null };

export function checkToolVersion(
  tool: PgTool,
  toolMajor: number | null,
  serverMajor: number | null,
): VersionCheck {
  if (toolMajor === null || serverMajor === null) return { level: 'ok', message: null };
  if (toolMajor === serverMajor) return { level: 'ok', message: null };
  if (tool === 'pg_dump' && toolMajor < serverMajor) {
    return {
      level: 'error',
      message: `pg_dump ${toolMajor} is older than the server (${serverMajor}) and will refuse to dump. Install a newer client or set its folder in Settings → Advanced.`,
    };
  }
  return {
    level: 'warn',
    message: `${tool} is version ${toolMajor} but the server is ${serverMajor}. It may work, but matching majors is safest.`,
  };
}

// ─── IPC shapes (backup / restore dialogs) ───────────────────────────

export interface ToolInfo {
  tool: PgTool;
  /** Resolved absolute path, or null when not found. */
  path: string | null;
  /** First line of `--version`. */
  version: string | null;
  major: number | null;
  error?: string;
}

export type AdminJobEvent =
  | { jobId: string; type: 'log'; text: string }
  | {
      jobId: string;
      type: 'done';
      ok: boolean;
      canceled: boolean;
      exitCode: number | null;
      message: string | null;
      /** Backup: size of the produced file (bytes), when it could be read. */
      bytes?: number;
    };

export interface AdminStartResult {
  jobId: string;
  /** Log-safe command line for the dialog. */
  command: string;
}

export const PickPathRequest = z.object({
  mode: z.enum(['save', 'open', 'directory']),
  title: z.string().optional(),
  defaultPath: z.string().optional(),
  filters: z.array(z.object({ name: z.string(), extensions: z.array(z.string()) })).optional(),
});
export type PickPathRequest = z.infer<typeof PickPathRequest>;

/** Candidate absolute paths for a tool: the configured folder first, then PATH, then usual installs. */
export function toolCandidates(
  tool: PgTool,
  binDir: string,
  pathEnv: string,
  platform: string,
  extraDirs: readonly string[] = [],
): string[] {
  const win = platform === 'win32';
  const sep = win ? ';' : ':';
  const join = (dir: string) => {
    const d = dir.replace(/[\\/]+$/, '');
    return `${d}${win ? '\\' : '/'}${tool}${win ? '.exe' : ''}`;
  };
  const dirs = [binDir.trim(), ...pathEnv.split(sep), ...extraDirs].filter((d) => d !== '');
  return [...new Set(dirs.map(join))];
}
