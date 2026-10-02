/**
 * Per-connection safe mode (TablePlus-style), consumed by the prod gate.
 *
 * Levels (Settings → Security sets the default, the connection dialog's
 * Advanced section overrides it per connection):
 *   - `off`               run everything without asking
 *   - `confirm-dangerous` DROP / TRUNCATE / DELETE, UPDATE without WHERE… ask first
 *   - `confirm-writes`    every statement that may write asks first
 *   - `confirm-all`       every statement asks first
 *   - `read-only`         writes are refused (session statements still run)
 *
 * A connection tagged PROD keeps its own confirmation on top: destructive
 * statements always ask there, whatever the level. A connection saved as
 * read-only is enforced by the server / main and is not modelled here.
 */
import { pgReadOnlyEscapeReason } from '@shared/pg-readonly-sql';
import type { Settings } from '@shared/protocol';
import {
  leadingKeyword,
  looksDestructiveSql,
  looksLikeWriteSql,
  splitSqlStatements,
  sqlSkeleton,
} from '@shared/sql-statements';

export type SafeModeLevel = Settings['safeModeDefault'];

export const SAFE_MODE_LEVELS: readonly SafeModeLevel[] = [
  'off',
  'confirm-dangerous',
  'confirm-writes',
  'confirm-all',
  'read-only',
];

/** Human labels + hints, shared by Settings and the connection dialog. */
export const SAFE_MODE_LABEL: Record<SafeModeLevel, { label: string; hint: string }> = {
  off: { label: 'Off', hint: 'Run everything without asking.' },
  'confirm-dangerous': {
    label: 'Confirm dangerous statements',
    hint: 'DROP, TRUNCATE, DELETE and UPDATE without WHERE ask first.',
  },
  'confirm-writes': {
    label: 'Confirm every write',
    hint: 'Any statement that may write asks first.',
  },
  'confirm-all': { label: 'Confirm every statement', hint: 'Every statement asks first.' },
  'read-only': { label: 'Read-only', hint: 'Statements that write are refused.' },
};

/** The level in force for a connection: its own choice, else the default. */
export function effectiveSafeMode(
  settings: Pick<Settings, 'safeModeDefault' | 'connectionSafeMode'> | undefined,
  connectionId: string | null | undefined,
): SafeModeLevel {
  const own = connectionId ? settings?.connectionSafeMode?.[connectionId] : undefined;
  return own ?? settings?.safeModeDefault ?? 'confirm-dangerous';
}

/**
 * Session / transaction-control statements. They change no data, so
 * "confirm writes" doesn't ask and "read-only" doesn't refuse them.
 */
const SESSION_HEADS = new Set([
  'set',
  'reset',
  'begin',
  'start',
  'commit',
  'end',
  'rollback',
  'abort',
  'savepoint',
  'release',
  'listen',
  'unlisten',
  'discard',
  'deallocate',
  'fetch',
  'move',
  'close',
]);

/** Functions that change state outside the transaction or the data (SC-13). */
const SIDE_EFFECT_FN =
  /^(nextval|setval|set_config|lo_\w+|dblink\w*|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_advisory\w*|pg_try_advisory\w*|pg_notify|pg_promote|pg_switch_wal|pg_logical_\w+|pg_wal_replay_\w+|pg_stat_reset\w*|pg_stat_statements_reset|pg_create_\w+|pg_drop_\w+|pg_replication_\w+|pg_file_\w+|pg_backup_\w+|pg_start_backup|pg_stop_backup|pg_import_system_collations|setseed|query_to_xml\w*)$/;

/** Words that precede `(` without being a function call. */
const NOT_A_CALL = new Set(
  (
    'in values exists any all some over filter array row not and or as on using select from where ' +
    'group order by having limit offset union intersect except case when then else end between like ' +
    'ilike similar to is distinct within lateral table with recursive join left right inner outer cross ' +
    'natural full returning set default insert into update delete cast collate at window partition rows ' +
    'range groups fetch only tablesample grouping if'
  ).split(' '),
);

/** Built-ins with no side effects, so a plain read that uses them stays a read. */
const SAFE_FN = new Set(
  // aggregates / window
  (
    'count sum avg min max array_agg string_agg json_agg jsonb_agg json_object_agg jsonb_object_agg ' +
    'bool_and bool_or every stddev stddev_pop stddev_samp variance var_pop var_samp percentile_cont ' +
    'percentile_disc mode rank dense_rank row_number ntile lag lead first_value last_value nth_value ' +
    'cume_dist percent_rank bit_and bit_or xmlagg corr covar_pop covar_samp ' +
    // conditional / math
    'coalesce nullif greatest least abs ceil ceiling floor round trunc sqrt cbrt power pow exp ln log ' +
    'log10 mod sign random div sin cos tan asin acos atan atan2 pi degrees radians width_bucket ' +
    // text
    'lower upper initcap length char_length character_length octet_length bit_length substr substring ' +
    'left right trim btrim ltrim rtrim lpad rpad replace translate concat concat_ws format position ' +
    'strpos split_part regexp_replace regexp_match regexp_matches regexp_split_to_array ' +
    'regexp_split_to_table starts_with reverse repeat md5 sha256 encode decode to_char to_number ' +
    'to_date to_timestamp ascii chr quote_ident quote_literal quote_nullable overlay unnest ' +
    'string_to_array array_to_string array_length array_upper array_lower cardinality array_append ' +
    'array_prepend array_cat array_remove array_position array_positions array_dims generate_series ' +
    'generate_subscripts to_tsvector to_tsquery plainto_tsquery websearch_to_tsquery ts_rank ' +
    'ts_headline similarity word_similarity ' +
    // date / time
    'now current_timestamp current_date current_time localtime localtimestamp clock_timestamp ' +
    'statement_timestamp transaction_timestamp timeofday date_trunc date_part extract age make_date ' +
    'make_time make_timestamp make_timestamptz make_interval justify_days justify_hours ' +
    'justify_interval isfinite timezone ' +
    // json
    'json_build_object jsonb_build_object json_build_array jsonb_build_array to_json to_jsonb ' +
    'row_to_json json_extract_path jsonb_extract_path json_extract_path_text jsonb_extract_path_text ' +
    'jsonb_path_query jsonb_path_query_array jsonb_path_exists jsonb_array_elements ' +
    'jsonb_array_elements_text json_array_elements json_array_elements_text jsonb_each jsonb_each_text ' +
    'json_each json_each_text jsonb_object_keys json_object_keys jsonb_typeof json_typeof jsonb_pretty ' +
    'jsonb_set jsonb_insert jsonb_strip_nulls json_strip_nulls json_array_length jsonb_array_length ' +
    'jsonb_populate_record jsonb_populate_recordset json_populate_record ' +
    // catalog / info
    'pg_typeof pg_size_pretty pg_relation_size pg_total_relation_size pg_table_size pg_database_size ' +
    'pg_indexes_size pg_column_size current_database current_schema current_schemas current_user ' +
    'session_user user current_setting version inet_client_addr inet_server_addr pg_backend_pid ' +
    'has_table_privilege has_schema_privilege has_column_privilege has_database_privilege ' +
    'has_function_privilege has_sequence_privilege has_any_column_privilege obj_description ' +
    'col_description pg_get_viewdef pg_get_indexdef pg_get_constraintdef pg_get_expr pg_get_userbyid ' +
    'pg_get_functiondef format_type to_regclass to_regtype to_regproc pg_table_is_visible ' +
    'pg_is_in_recovery pg_postmaster_start_time pg_current_wal_lsn pg_sleep pg_my_temp_schema ' +
    'gen_random_uuid uuid_generate_v4 ' +
    // type names used as `type(n)` / casts
    'varchar char character numeric decimal timestamp timestamptz time timetz interval bit varbit int ' +
    'integer float double text date boolean bigint smallint real json jsonb uuid bytea inet cidr ' +
    'macaddr money point'
  ).split(' '),
);

/** Names of function-style calls in a statement's skeleton (last path segment, lower-cased). */
function callNames(sql: string): string[] {
  const sk = sqlSkeleton(sql);
  const out: string[] = [];
  for (const m of sk.matchAll(/([a-z_][a-z0-9_$]*(?:\s*\.\s*[a-z_][a-z0-9_$]*)*|"_")\s*\(/g)) {
    const full = m[1] ?? '';
    const parts = full.split(/\s*\.\s*/);
    const last = parts[parts.length - 1] ?? '';
    if (parts.length === 1 && NOT_A_CALL.has(last)) continue;
    // `schema.fn(` other than pg_catalog.* is a user function.
    const qualified = parts.length > 1 && parts[parts.length - 2] !== 'pg_catalog';
    out.push(qualified ? `${parts[parts.length - 2]}.${last}` : last);
  }
  return out;
}

/** Calls that change state: counted as writes at every level. */
function hasSideEffectCall(sql: string): boolean {
  return callNames(sql).some((n) => SIDE_EFFECT_FN.test(n.split('.').pop() ?? n));
}

/**
 * Calls we cannot vouch for (user functions, extension functions): a
 * "SELECT purge_old_orders()" is a write the text never admits. Only the
 * read-only level cares; it asks instead of running them silently.
 */
function hasUnknownCall(sql: string): boolean {
  const head = leadingKeyword(sql);
  if (head === 'show' || head === 'explain') {
    // Plain EXPLAIN never executes; EXPLAIN ANALYZE is classified as its target.
    if (head === 'show' || !/\banaly[sz]e\b/.test(sqlSkeleton(sql))) return false;
  }
  return callNames(sql).some((n) => {
    if (n.includes('.')) return true; // schema-qualified non-catalog function
    if (n.startsWith('st_')) return false; // PostGIS accessors / constructors
    return n === '"_"' || !SAFE_FN.has(n);
  });
}

function statementWrites(sql: string): boolean {
  if (SESSION_HEADS.has(leadingKeyword(sql))) return false;
  return looksLikeWriteSql(sql) || hasSideEffectCall(sql);
}

export type GateDecision =
  | { kind: 'run' }
  | { kind: 'confirm'; reason: 'prod' | 'safe-mode'; level: SafeModeLevel }
  | { kind: 'refuse'; message: string };

export const SAFE_MODE_READ_ONLY_MESSAGE =
  'Safe mode is set to read-only for this connection, so statements that write are refused. ' +
  'Change it in the connection’s Advanced settings.';

/**
 * Decide what the gate does with `sql`.
 *
 * `force` marks SQL the caller already knows writes (mock rows, EXPLAIN
 * ANALYZE of a DML statement, a grid commit) — it always confirms on a
 * prod-tagged connection and counts as a write for the safe-mode levels,
 * but is not "dangerous" by itself.
 */
export function safeModeDecision(input: {
  sql: string;
  level: SafeModeLevel;
  prodTagged: boolean;
  force?: boolean;
}): GateDecision {
  const { level, prodTagged, force } = input;
  const statements = splitSqlStatements(input.sql).filter((s) => s.trim().length > 0);
  const writes = force === true || statements.some(statementWrites);
  const destructive = statements.some((s) => looksDestructiveSql(s));

  if (level === 'read-only' && writes) {
    return { kind: 'refuse', message: SAFE_MODE_READ_ONLY_MESSAGE };
  }
  if (level === 'read-only') {
    // Session statements that switch read-only off (SET default_transaction_
    // read_only, RESET ALL, set_config…) are not "plain session plumbing".
    const escapeWhy = statements.map((s) => pgReadOnlyEscapeReason(s)).find((r) => r !== null);
    if (escapeWhy) {
      return {
        kind: 'refuse',
        message: `Safe mode is read-only for this connection, so ${escapeWhy} is refused.`,
      };
    }
    // A SELECT that calls a function we can't vouch for may write.
    if (statements.some((s) => !SESSION_HEADS.has(leadingKeyword(s)) && hasUnknownCall(s))) {
      return { kind: 'confirm', reason: 'safe-mode', level };
    }
  }
  const bySafeMode =
    (level === 'confirm-all' && (force === true || statements.length > 0)) ||
    (level === 'confirm-writes' && writes) ||
    (level === 'confirm-dangerous' && destructive);
  if (prodTagged && (destructive || force === true))
    return { kind: 'confirm', reason: 'prod', level };
  if (bySafeMode) return { kind: 'confirm', reason: 'safe-mode', level };
  return { kind: 'run' };
}
