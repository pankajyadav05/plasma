import { isReadOnlyRedisCommand } from './ai-policy';

/**
 * C1 — main-process guard for read-only connections, for every engine.
 *
 * Postgres is additionally enforced by the server (the worker sets
 * `default_transaction_read_only` on connect); this layer covers what the
 * server cannot see (grid edit batches are refused up front) and the
 * engines that have no server-side read-only switch at all (Redis,
 * OpenSearch). Renderer affordances are hidden separately — this is the
 * boundary that holds even if a button slips through.
 *
 * The request is typed loosely on purpose: new worker kinds added later
 * are classified by name (see WRITE_KIND_PATTERN) rather than silently
 * allowed.
 */

export class ReadOnlyViolationError extends Error {
  override readonly name = 'ReadOnlyViolationError';
  constructor(what: string) {
    super(
      `Read-only connection: ${what} is not allowed. Edit the connection to turn off read-only.`,
    );
  }
}

type GuardedRequest = { kind: string } & Record<string, unknown>;

/** Always a write, whatever the arguments. */
const WRITE_KINDS = new Set<string>([
  'commitEditBatch',
  'applyDdl',
  'importRun',
  'redisWrite',
  'redisDeleteKey',
  'redisBulkDelete',
  'redisSetTtl',
  'osCreateIndex',
  'osDeleteIndex',
  'adminRestore',
]);

/** Reads (or session plumbing) whose names would trip the fallback pattern. */
const READ_KINDS = new Set<string>([
  'connect',
  'testConnect',
  'disconnect',
  'setStatementTimeout',
  'cancel',
  'beginTxn',
  'commitTxn', // ends a (read-only) transaction
  'rollbackTxn',
  'redisCancel',
  'osCancel',
  'redisSubscribe',
  'redisUnsubscribe',
  'importCancel', // stops a job; writes nothing
  'exportCancel', // stops a file export
  'cancelAux', // cancels a read on the aux connection
  'exportRows', // writes a local file from rows already fetched
]);

/** Fallback for kinds this file has not heard of yet. */
const WRITE_KIND_PATTERN =
  /(write|delete|del$|remove|rem$|create|insert|update|upsert|put|set(?!tings)|ttl|rename|flush|drop|truncate|push|add$|reindex|bulk|commit)/i;

/**
 * SQL that would turn the server-side read-only switch back off. Plain
 * writes are refused by Postgres itself; these are the escape hatches.
 */
const PG_READ_ONLY_ESCAPE =
  /\b(read\s+write|default_transaction_read_only|transaction_read_only)\b/i;

/** OpenSearch SQL plugin statements that only read. */
const OS_SQL_READ = /^\s*(select|show|describe|explain)\b/i;

/** OpenSearch REST endpoints that are reads even when sent as POST. */
const OS_READ_POST_ENDPOINT =
  /(^|\/)(_search|_msearch|_count|_mget|_validate\/query|_explain(\/|$)|_field_caps|_analyze|_search\/scroll|_pit|_termvectors|_mtermvectors|_rank_eval|_plugins\/_sql|_opendistro\/_sql|_sql)(\/|\?|$)/i;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Throws ReadOnlyViolationError when `req` would write on a read-only session. */
export function assertAllowedOnReadOnly(req: GuardedRequest): void {
  const { kind } = req;

  switch (kind) {
    case 'query':
    case 'sidebandQuery':
    case 'aiQuery':
    case 'exportQuery':
      if (PG_READ_ONLY_ESCAPE.test(str(req.sql))) {
        throw new ReadOnlyViolationError('changing the transaction read-only setting');
      }
      return;
    case 'redisCommand': {
      const parts = Array.isArray(req.parts) ? req.parts.map((p) => String(p)) : [];
      if (!isReadOnlyRedisCommand(parts)) {
        throw new ReadOnlyViolationError(`${(parts[0] ?? 'command').toUpperCase()}`);
      }
      return;
    }
    case 'redisDeleteByPattern':
      // A dry run only counts and samples matches.
      if (req.dryRun === false) throw new ReadOnlyViolationError('deleting keys');
      return;
    case 'osSql': {
      const query = str(req.query);
      if (query && !OS_SQL_READ.test(query)) {
        throw new ReadOnlyViolationError('this SQL statement');
      }
      return;
    }
    case 'osRequest': {
      const method = str(req.method).toUpperCase();
      if (method === 'GET' || method === 'HEAD') return;
      if (method === 'POST' && OS_READ_POST_ENDPOINT.test(str(req.path))) return;
      throw new ReadOnlyViolationError(`${method || 'this'} request`);
    }
  }

  if (READ_KINDS.has(kind)) return;
  if (WRITE_KINDS.has(kind) || WRITE_KIND_PATTERN.test(kind)) {
    throw new ReadOnlyViolationError(describeKind(kind));
  }
}

function describeKind(kind: string): string {
  switch (kind) {
    case 'commitEditBatch':
      return 'committing grid edits';
    case 'applyDdl':
      return 'changing the table structure';
    case 'importRun':
      return 'importing data';
    case 'redisWrite':
      return 'writing keys';
    case 'redisDeleteKey':
    case 'redisBulkDelete':
      return 'deleting keys';
    case 'redisSetTtl':
      return 'changing a TTL';
    case 'osCreateIndex':
      return 'creating an index';
    case 'osDeleteIndex':
      return 'deleting an index';
    case 'adminRestore':
      return 'restoring a backup';
    default:
      return kind;
  }
}
