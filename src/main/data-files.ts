import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';
import {
  DATA_FILE_EXTENSIONS,
  attachAlias,
  dataFileKind,
  dataFilePathProblem,
} from '@shared/data-files';
import type { ConnectionConfig, DuckdbAttach, DuckdbOptions } from '@shared/protocol';
import { effectiveTlsMode } from '@shared/tls';

/**
 * DuckDB data files, as far as main is concerned.
 *
 * The renderer never names a file to open: paths come from a native picker
 * run in main, or from a window drop read in the preload, and both are
 * validated here and remembered. A connect for a DuckDB config is refused
 * unless every file (and the database file) was allowed this session, or is
 * the database path already saved for that very connection.
 */

const allowed = new Set<string>();

/** Canonical form of a path for the allowlist (symlinks resolved when the file exists). */
export function canonicalDataPath(path: string): string {
  try {
    return normalize(realpathSync(path));
  } catch {
    return normalize(path);
  }
}

/** Forget every allowed path (tests). */
export function resetAllowedDataFiles(): void {
  allowed.clear();
}

export interface DataFileCheck {
  /** Paths that passed validation (and were allowlisted). */
  accepted: string[];
  /** One readable line per refused path. */
  problems: string[];
}

function baseName(path: string): string {
  return path.replace(/^.*[\\/]/, '');
}

/** Why `path` cannot be opened as a data file, or null. */
export function dataFileProblem(path: unknown): string | null {
  if (typeof path !== 'string' || !path) return 'The file path is not valid.';
  if (!isAbsolute(path)) return 'Choose the file with the file picker.';
  const problem = dataFilePathProblem(path);
  if (problem) return problem;
  try {
    const st = statSync(path);
    if (!st.isFile()) return 'That path is not a regular file.';
  } catch {
    return 'That file does not exist.';
  }
  return null;
}

/**
 * Validate picked or dropped paths and allowlist the good ones. Unsupported
 * types, missing files, directories and glob-looking names are reported.
 */
export function acceptDataFiles(paths: unknown): DataFileCheck {
  const out: DataFileCheck = { accepted: [], problems: [] };
  if (!Array.isArray(paths)) return out;
  for (const raw of paths.slice(0, 64)) {
    const problem = dataFileProblem(raw);
    if (problem) {
      out.problems.push(`${typeof raw === 'string' ? baseName(raw) : 'file'}: ${problem}`);
      continue;
    }
    const path = raw as string;
    allowed.add(canonicalDataPath(path));
    if (!out.accepted.includes(path)) out.accepted.push(path);
  }
  return out;
}

/**
 * Throws unless the DuckDB config only names allowed files: each data file
 * and a database path (`:memory:` or a file) was picked/dropped this
 * session, or the database is what the vault holds for this connection.
 */
export function assertDuckdbConfigAllowed(
  config: Pick<ConnectionConfig, 'database' | 'duckdb'>,
  savedDatabase?: string | null,
): void {
  const database = config.database || ':memory:';
  if (database !== ':memory:') {
    const ok =
      allowed.has(canonicalDataPath(database)) ||
      (savedDatabase && canonicalDataPath(savedDatabase) === canonicalDataPath(database));
    if (!ok || !isAbsolute(database) || dataFileKind(database) !== 'duckdb') {
      throw new Error('Choose the DuckDB file with the file picker first.');
    }
  }
  for (const file of config.duckdb?.files ?? []) {
    if (!isAbsolute(file) || !dataFileKind(file) || dataFileKind(file) === 'duckdb') {
      throw new Error(`${baseName(file)}: not a data file Plasma can open.`);
    }
    if (!allowed.has(canonicalDataPath(file))) {
      throw new Error(
        `${baseName(file)}: choose the file with the file picker or drop it on the window first.`,
      );
    }
  }
}

/** Drop what only main may set (`attach` carries credentials). */
export function sanitizeDuckdbOptions(
  options: DuckdbOptions | undefined,
): DuckdbOptions | undefined {
  if (!options) return undefined;
  const { attach: _discarded, ...rest } = options;
  return rest;
}

/** Extensions for the native dialogs. */
export const DATA_FILE_DIALOG_FILTERS = {
  files: [
    {
      name: 'Data files',
      extensions: [...DATA_FILE_EXTENSIONS.tabular, ...DATA_FILE_EXTENSIONS.database],
    },
    { name: 'All files', extensions: ['*'] },
  ],
  database: [
    { name: 'DuckDB database', extensions: [...DATA_FILE_EXTENSIONS.database] },
    { name: 'All files', extensions: ['*'] },
  ],
};

/** The Postgres side of an attachment, as read from the vault. */
type PostgresSource = Pick<
  ConnectionConfig,
  'id' | 'name' | 'engine' | 'host' | 'port' | 'database' | 'user' | 'password' | 'ssl' | 'tls'
>;

/**
 * Turn saved Postgres connection ids into `attach` entries for the worker.
 * Only plain, direct Postgres connections qualify: a tunnelled one would
 * need its own tunnel for the life of the session. `sshFor` says whether an
 * id has an SSH tunnel configured.
 */
export function buildDuckdbAttachments(
  ids: readonly string[],
  deps: {
    load(id: string): PostgresSource | null;
    sshFor(id: string): boolean;
  },
): DuckdbAttach[] {
  const taken: string[] = [];
  const out: DuckdbAttach[] = [];
  for (const id of ids) {
    const source = deps.load(id);
    if (!source) throw new Error('That Postgres connection no longer exists.');
    if ((source.engine ?? 'postgres') !== 'postgres') {
      throw new Error(`${source.name}: only Postgres connections can be attached.`);
    }
    if (deps.sshFor(id)) {
      throw new Error(
        `${source.name} connects through an SSH tunnel, which cannot be attached to a DuckDB session. Connect to it directly or open it on its own.`,
      );
    }
    const mode = effectiveTlsMode(source);
    const alias = attachAlias(source.name, taken);
    taken.push(alias);
    out.push({
      alias,
      host: source.host,
      port: source.port,
      database: source.database || 'postgres',
      user: source.user,
      password: source.password,
      sslmode: mode === 'insecure' ? 'require' : mode,
      ...(source.tls?.caFile && (mode === 'verify-ca' || mode === 'verify-full')
        ? { sslrootcert: source.tls.caFile }
        : {}),
    });
  }
  return out;
}

/** Sessions built from data files are never written to the connection list. */
export function isEphemeralDuckdbSession(config: Pick<ConnectionConfig, 'engine' | 'id'>): boolean {
  return config.engine === 'duckdb' && config.id.startsWith('duckdb-');
}
