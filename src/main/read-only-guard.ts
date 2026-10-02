import { isOsReadRequest, isReadOnlyOsSql } from '@shared/os-write-policy';
import { pgReadOnlyEscapeReason } from '@shared/pg-readonly-sql';
import { isRedisReadCommand } from '@shared/redis-command-policy';

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
  'safeRunStart', // holds an open write transaction
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
  'safeRunFinish', // ends a Safe Run (which a read-only session can never start)
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
      {
        const why = pgReadOnlyEscapeReason(str(req.sql));
        if (why) throw new ReadOnlyViolationError(why);
      }
      return;
    case 'redisCommand': {
      const parts = Array.isArray(req.parts) ? req.parts.map((p) => String(p)) : [];
      if (!isRedisReadCommand(parts)) {
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
      if (query && !isReadOnlyOsSql(query)) {
        throw new ReadOnlyViolationError('this SQL statement');
      }
      return;
    }
    case 'osRequest': {
      const method = str(req.method).toUpperCase();
      // Same structural policy as the IPC parser and the worker driver.
      if (isOsReadRequest(method, str(req.path), req.body)) return;
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
    case 'safeRunStart':
      return 'Safe Run of a write';
    default:
      return kind;
  }
}
