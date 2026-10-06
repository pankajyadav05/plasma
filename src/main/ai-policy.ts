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

import { describeDbErrorSafely } from '@shared/db-error-class';
import type { AiActionResult } from '@shared/protocol';

export { isAiSchemaAllowed } from '@shared/ai-schema-policy';
export { isReadOnlySql } from '@shared/ai-readonly-sql';

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
 * The tool message the model gets for an agent action the user decided on.
 * `{outcome, note}` always; for data `{columns, rowCount}`, and the rows ONLY
 * while `rowData` is true (the connection's opt-in, checked by the caller at
 * that moment), masked by `maskRows` and capped like every other tool result.
 *
 * Database error text can quote row values, so without the opt-in a failure
 * is reduced to a value-free category (`duplicate key (23505)`): the renderer's
 * `dbError` is never forwarded, and a note that came from the database is
 * replaced. Without schema sharing, result column names are left out too.
 */
export function shapeAgentActionResult(
  res: AiActionResult,
  opts: {
    rowData: boolean;
    maskRows: (columns: string[], rows: unknown[][]) => unknown[][];
    /** Schema names may go to the provider; default true. */
    schema?: boolean;
  },
): string {
  let note = res.note?.trim() ?? '';
  if (res.outcome === 'failed' && !opts.rowData) {
    note = res.dbError
      ? describeDbErrorSafely(res.dbError)
      : (note.split('\n')[0]?.slice(0, 300) ?? '');
  } else if (res.outcome === 'failed' && res.dbError) {
    note = (res.dbError.split('\n')[0] ?? note).slice(0, 500);
  } else {
    note = note.slice(0, 500);
  }
  const extra = { outcome: res.outcome, ...(note ? { note } : {}) };
  if (!res.data) return JSON.stringify(extra);
  const { rows, rowCount } = res.data;
  const columns = res.data.columns;
  if (!opts.rowData) {
    return JSON.stringify({
      ...extra,
      ...(opts.schema === false ? {} : { columns }),
      rowCount,
    });
  }
  return serializeAiToolRows({ columns, rows: opts.maskRows(columns, rows), rowCount, extra });
}
