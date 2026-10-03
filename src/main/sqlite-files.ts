import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';
import Database from 'better-sqlite3';

/**
 * SQLite database files, as far as main is concerned.
 *
 * The renderer never gets to name a file to open: the path comes from a native
 * picker run in main, which records it here. A connect / test / save for a
 * SQLite config is refused unless its path was picked this session or is the
 * path already stored for that very connection (picked in an earlier session).
 */

const SQLITE_MAGIC = 'SQLite format 3\0';

const pickedPaths = new Set<string>();

export function normalizeSqlitePath(path: string): string {
  return normalize(path);
}

/** Remember a path the user chose in the native dialog. */
export function allowSqlitePath(path: string): void {
  pickedPaths.add(normalizeSqlitePath(path));
}

/** Forget every picked path (tests). */
export function resetPickedSqlitePaths(): void {
  pickedPaths.clear();
}

/**
 * Throws unless `path` may be opened: it was picked through the dialog, or
 * it is what the vault already holds for this connection.
 */
export function assertSqlitePathAllowed(path: string, savedPath?: string | null): void {
  if (!path || path.includes('\0') || !isAbsolute(path)) {
    throw new Error('Choose the SQLite file with the file picker.');
  }
  const norm = normalizeSqlitePath(path);
  if (pickedPaths.has(norm)) return;
  if (savedPath && normalizeSqlitePath(savedPath) === norm) return;
  throw new Error('Choose the SQLite file with the file picker first.');
}

/** Why `path` cannot be opened as a database, or null. Empty files are fine (new database). */
export function sqliteFileProblem(path: string): string | null {
  let size: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) return 'That path is not a file.';
    size = st.size;
  } catch {
    return 'That file does not exist.';
  }
  if (size === 0) return null;
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(SQLITE_MAGIC.length);
    readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('latin1') === SQLITE_MAGIC ? null : 'That file is not a SQLite database.';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    closeSync(fd);
  }
}

/** Create an empty database at `path` (an existing database is left untouched). */
export function createSqliteFile(path: string): void {
  if (existsSync(path)) {
    const problem = sqliteFileProblem(path);
    if (problem) throw new Error(problem);
    return;
  }
  const db = new Database(path);
  try {
    // Writes the header so the file is a valid database straight away.
    db.pragma('user_version = 0');
  } finally {
    db.close();
  }
}
