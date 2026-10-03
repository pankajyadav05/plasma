import { pgReadOnlyEscapeReason } from './pg-readonly-sql';
import { sqlSkeleton } from './sql-statements';

/**
 * Text-level screen for SQL that tries to leave a read-only session, per
 * engine (SC-02 for SQLite and MySQL; ClickHouse and DuckDB too). Defence in depth only: the boundary
 * that holds is the driver — SQLite opens the file read-only, MySQL runs
 * `SET SESSION TRANSACTION READ ONLY` and re-asserts it before every
 * statement — because a name built at run time can never be caught here.
 */
export function sqlReadOnlyEscapeReason(
  engine: string | null | undefined,
  sql: string,
): string | null {
  const shared = pgReadOnlyEscapeReason(sql);
  if (shared) return shared;
  const sk = sqlSkeleton(sql).trim();
  if (!sk) return null;
  if (engine === 'mysql') {
    if (/\btx_read_only\b/.test(sk)) return 'changing the transaction read-only setting';
    if (/^set\s+(global\s+|session\s+|persist\s+)?transaction\b/.test(sk)) {
      return 'changing transaction characteristics';
    }
    if (/^set\s+(global|persist)\b/.test(sk)) return 'changing server variables';
    if (/^(start\s+transaction|begin)\s+(\w+\s+)*read\s+write\b/.test(sk)) {
      return 'starting a read-write transaction';
    }
  }
  if (engine === 'clickhouse') {
    // The server's readonly=1 is the boundary; this only names the attempt.
    if (/^set\b[^;]*\breadonly\b/.test(sk)) return 'changing the readonly setting';
    if (/\bsettings\b[^;]*\breadonly\s*=/.test(sk)) return 'changing the readonly setting';
  }
  if (engine === 'duckdb') {
    if (/^(copy|export)\b/.test(sk)) return 'writing files';
    if (/^(attach|detach)\b/.test(sk)) return 'attaching or detaching a database';
    if (/^(install|load|force)\b/.test(sk)) return 'loading an extension';
    if (/^(set|reset)\b/.test(sk)) return 'changing DuckDB settings';
    if (
      /\b(enable_external_access|lock_configuration|allowed_paths|allowed_directories)\b/.test(sk)
    ) {
      return 'changing file-access settings';
    }
  }
  if (engine === 'sqlite') {
    if (/\bpragma\b[^;]*\b(query_only|writable_schema|trusted_schema)\b/.test(sk)) {
      return 'changing a PRAGMA that controls writes';
    }
    if (/^attach\b/.test(sk)) return 'attaching another database';
    if (/\bload_extension\s*\(/.test(sk)) return 'loading an extension';
  }
  return null;
}
