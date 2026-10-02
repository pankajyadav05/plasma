/**
 * Pure AI policy helpers (U04/U06).
 * Kept free of Electron so unit tests can import them under plain Node —
 * CI sets ELECTRON_SKIP_BINARY_DOWNLOAD=1 and the real `electron` package
 * throws on require when its binary was skipped.
 */

/** Hard caps on AI tool result egress (U06). */
export const AI_TOOL_MAX_ROWS = 50;
export const AI_TOOL_MAX_BYTES = 32_768;

/**
 * Per-connection opt-in for AI row-data tools. Missing / false → denied.
 * Prod-tagged connections stay denied unless explicitly opted in.
 */
export function isAiRowDataAllowed(
  connectionId: string | null | undefined,
  connectionAiRowData: Record<string, boolean> | undefined,
): boolean {
  if (!connectionId) return false;
  return connectionAiRowData?.[connectionId] === true;
}

/**
 * SC-20: schema names, sample Redis keys and cluster summaries go to the AI
 * provider as the system prompt. Allowed unless the user turned the global
 * "send schema" setting off; prod-tagged connections additionally need the
 * explicit per-connection opt-in (the same switch as row data).
 */
export function isAiSchemaAllowed(
  connectionId: string | null | undefined,
  settings: {
    aiSendSchema?: boolean;
    connectionTags?: Record<string, string>;
    connectionAiRowData?: Record<string, boolean>;
  },
): boolean {
  if (!connectionId) return false;
  if (settings.aiSendSchema === false) return false;
  if (settings.connectionTags?.[connectionId] === 'prod') {
    return settings.connectionAiRowData?.[connectionId] === true;
  }
  return true;
}

/**
 * Serialize tool rows with row + byte caps. Always labels truncation so
 * the model (and any captured OpenRouter body) can see the policy.
 */
export function serializeAiToolRows(input: {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  maxRows?: number;
  maxBytes?: number;
  extra?: Record<string, unknown>;
}): string {
  const maxRows = input.maxRows ?? AI_TOOL_MAX_ROWS;
  const maxBytes = input.maxBytes ?? AI_TOOL_MAX_BYTES;
  let take = Math.min(input.rows.length, maxRows);
  let truncated = input.rows.length > take || input.rowCount > take;

  const build = (n: number) => {
    const rows = input.rows
      .slice(0, n)
      .map((r) => Object.fromEntries(input.columns.map((cn, i) => [cn, r[i]])));
    return JSON.stringify({
      ...input.extra,
      rowCount: input.rowCount,
      columns: input.columns,
      rows,
      truncated: truncated || input.rows.length > n,
      capped: { maxRows, maxBytes },
    });
  };

  let json = build(take);
  while (json.length > maxBytes && take > 0) {
    take = Math.max(0, Math.floor(take / 2));
    truncated = true;
    json = build(take);
  }
  if (json.length > maxBytes) {
    return JSON.stringify({
      error: 'tool result exceeded byte cap',
      capped: { maxRows, maxBytes },
      truncated: true,
    });
  }
  return json;
}

/** Cap an arbitrary JSON-serializable tool payload by UTF-8 byte length. */
export function capAiToolJson(value: unknown, maxBytes: number = AI_TOOL_MAX_BYTES): string {
  const json = JSON.stringify(value);
  if (json.length <= maxBytes) return json;
  return JSON.stringify({
    error: 'tool result exceeded byte cap',
    capped: { maxBytes },
    truncated: true,
    preview: json.slice(0, Math.min(512, maxBytes)),
  });
}

/**
 * Build the OpenRouter chat-completions request body for one round.
 * Exported so tests can assert tools / message history without a network.
 */
export function buildOpenRouterBody(args: {
  model: string;
  messages: unknown[];
  maxTokens?: number;
  tools?: readonly unknown[] | null;
  stream?: boolean;
}): string {
  return JSON.stringify({
    model: args.model,
    messages: args.messages,
    stream: args.stream ?? true,
    max_tokens: args.maxTokens,
    tools: args.tools && args.tools.length > 0 ? args.tools : undefined,
  });
}

/**
 * Allow-list of read-only Redis commands. Tool calls outside this set
 * are rejected before they hit the worker. We're deliberately
 * conservative — the AI's job is observation, not mutation.
 */
const REDIS_READ_ONLY = new Set([
  'GET',
  'MGET',
  'EXISTS',
  'TYPE',
  'TTL',
  'PTTL',
  'OBJECT',
  'STRLEN',
  'HGET',
  'HGETALL',
  'HKEYS',
  'HLEN',
  'HMGET',
  'LRANGE',
  'LLEN',
  'SMEMBERS',
  'SCARD',
  'SISMEMBER',
  'ZRANGE',
  'ZRANGEBYSCORE',
  'ZSCORE',
  'ZCARD',
  'ZCOUNT',
  'XLEN',
  'XRANGE',
  'XREVRANGE',
  'INFO',
  'DBSIZE',
  // No KEYS (blocks the server on big keyspaces) and no CONFIG (CONFIG GET
  // returns requirepass / masterauth, which would be sent to the model).
  'SCAN',
  'HSCAN',
  'SSCAN',
  'ZSCAN',
  'MEMORY',
  'CLIENT',
  'SLOWLOG',
  'COMMAND',
  'PING',
  'TIME',
]);

/**
 * Whitelist for `CONFIG` / `CLIENT` / `MEMORY` / `SLOWLOG` subcommands.
 * Each of these is technically allow-listed above by their head verb,
 * but the second token must be a known read sub-action.
 */
const REDIS_READ_ONLY_SUBCOMMANDS = new Map<string, Set<string>>([
  ['CLIENT', new Set(['LIST', 'GETNAME', 'ID', 'INFO'])],
  ['MEMORY', new Set(['USAGE', 'STATS', 'DOCTOR'])],
  ['SLOWLOG', new Set(['GET', 'LEN', 'HELP'])],
  ['OBJECT', new Set(['ENCODING', 'IDLETIME', 'FREQ', 'REFCOUNT'])],
]);

export function isReadOnlyRedisCommand(parts: readonly string[]): boolean {
  if (parts.length === 0) return false;
  const head = (parts[0] ?? '').toUpperCase();
  if (!REDIS_READ_ONLY.has(head)) return false;
  const subAllow = REDIS_READ_ONLY_SUBCOMMANDS.get(head);
  if (subAllow) {
    const sub = (parts[1] ?? '').toUpperCase();
    return subAllow.has(sub);
  }
  return true;
}

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
