import { sqlSkeleton } from './sql-statements';

/**
 * Pre-filter for tool-driven queries (U04/C18). Allows EXPLAIN / SELECT /
 * SHOW / WITH / VALUES / TABLE, rejects data-modifying CTEs and functions
 * with side effects outside the transaction. The worker's `aiQuery` is the
 * real boundary: single statement, inside `BEGIN … READ ONLY`.
 */
export function isReadOnlySql(sql: string): boolean {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--.*$/gm, '')
    .trim()
    .toLowerCase();
  if (!/^(select|explain|show|with|values|table)\b/.test(stripped)) return false;
  // Data-modifying CTEs (`WITH x AS (DELETE …)`) — the worker's READ ONLY
  // transaction rejects them too, this just fails fast.
  if (/\b(insert|update|delete|merge)\b/.test(stripped) && stripped.startsWith('with'))
    return false;
  // Functions that act outside the transaction, so READ ONLY doesn't stop
  // them (kill sessions, read server files, reach other hosts, …).
  // Checked on the raw text too, so a `'--'` string can't hide a call.
  return !UNSAFE_SQL_FUNCTIONS.test(stripped) && !UNSAFE_SQL_FUNCTIONS.test(sql.toLowerCase());
}

const UNSAFE_SQL_FUNCTIONS =
  /\b(pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_promote|pg_read_file|pg_read_binary_file|pg_ls_\w+|pg_stat_file|lo_import|lo_export|dblink\w*|set_config|pg_sleep\w*|pg_advisory\w*|pg_notify|pg_switch_wal|pg_create_\w+|pg_drop_\w+|pg_replication_\w+|query_to_xml\w*|pg_file_\w+)"?\s*\(/;

/**
 * Stricter than `isReadOnlySql`, for SQL the agent runs on the user's behalf.
 * `EXPLAIN ANALYZE DELETE` passes the pre-filter above and really deletes,
 * `SELECT … INTO` creates a table, `nextval()` moves a sequence, and a few
 * table functions read local files or reach other hosts. Anything that names
 * one of them outside strings and comments is refused. Quoted identifiers are
 * looked through (`"setval"(…)` is `setval`). This is a pre-filter: where the
 * engine can, the query also runs inside a read-only session (`aiQuery`).
 */
export function isAgentReadSql(sql: string): boolean {
  if (!isReadOnlySql(sql)) return false;
  // `"setval"` / `` `setval` `` must not hide behind the identifier quotes.
  const unquoted = sql
    .replace(/"([A-Za-z_][A-Za-z0-9_$]*)"/g, '$1')
    .replace(/`([A-Za-z_][A-Za-z0-9_$]*)`/g, '$1');
  if (!isReadOnlySql(unquoted)) return false;
  const skeleton = sqlSkeleton(unquoted).trim();
  if (AGENT_WRITE_WORDS.test(skeleton) || AGENT_UNSAFE_CALLS.test(skeleton)) return false;
  // DuckDB reads a file named by a string: FROM 'data.csv'.
  if (/\b(from|join)\s*''/.test(skeleton)) return false;
  // What EXPLAIN can wrap besides a SELECT (and runs when ANALYZE is on).
  if (/^explain\b/.test(skeleton) && EXPLAIN_RUNS.test(skeleton)) return false;
  return true;
}

const AGENT_WRITE_WORDS =
  /\b(insert|update|delete|merge|into|nextval|setval|lastval|pg_stat_reset\w*)\b|\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/;
const EXPLAIN_RUNS = /\b(create|refresh|execute|declare|truncate|drop|alter)\b/;
/**
 * Calls with effects a read-only transaction does not stop: large objects,
 * session advisory locks, WAL messages, file readers (DuckDB, SQLite) and
 * table functions that reach files or other hosts (ClickHouse, DuckDB), and
 * MySQL / MariaDB functions that read server files, sleep or take locks.
 */
const AGENT_UNSAFE_CALLS =
  /\b(lo_\w+|lowrite|loread|pg_try_advisory\w*|pg_advisory\w*|pg_logical_emit_message|read_\w+|glob|load_extension|readfile|writefile|url|urlcluster|s3|s3cluster|remote|remotesecure|mysql|postgresql|mongodb|file|hdfs|jdbc|odbc|azureblobstorage|input|executable|sqlite|iceberg|deltalake|hudi|load_file|sleep\w*|benchmark|get_lock|release_lock|release_all_locks|is_free_lock|is_used_lock|master_pos_wait|source_pos_wait|sys_exec|sys_eval)\s*\(/;

/** Engines whose `aiQuery` runs inside a read-only session (a write is refused by the server). */
export function agentReadSandboxed(engine: string | null | undefined): boolean {
  return (
    engine === 'postgres' || engine === 'mysql' || engine === 'sqlite' || engine === 'clickhouse'
  );
}
