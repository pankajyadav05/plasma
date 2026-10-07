import type { WorkerRequest } from './protocol';

/** Exponential backoff for worker respawn (U20). */
export function nextBackoffMs(currentMs: number, baseMs = 250, maxMs = 10_000): number {
  return Math.min(currentMs === 0 ? baseMs : currentMs * 2, maxMs);
}

/**
 * Pull a correlation id off an untyped worker message so invalid envelopes
 * can still settle the matching pending promise (U20).
 */
export function extractCorrelatedId(raw: unknown): string | null {
  if (raw !== null && typeof raw === 'object' && 'id' in raw) {
    const id = (raw as { id: unknown }).id;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return null;
}

/**
 * Per-op IPC deadline. `null` = no blanket timer. That is for work whose
 * budget is not wall-clock: SQL (PG `statement_timeout`), exports and
 * imports (they stream for as long as the data takes and report progress),
 * DDL, EXPLAIN, edit batches and bulk Redis scans (SC-06). A worker that
 * wedges instead is recycled by the supervisor watchdog (SC-12).
 * OpenSearch requests carry their own `timeoutMs`; the deadline is that
 * plus slack, so the driver's own timeout reports first.
 */
export function ipcDeadlineMs(kind: WorkerRequest['kind'], req?: WorkerRequest): number | null {
  switch (kind) {
    case 'query':
    case 'sidebandQuery':
    case 'importRun':
    case 'applyDdl':
    case 'explain':
    case 'commitEditBatch':
    case 'safeRunStart':
    case 'redisBulkDelete':
    case 'redisDeleteByPattern':
    case 'redisAnalyze':
      return null;
    // C30: exports stream to disk for as long as the data takes; a blanket
    // deadline rejected in main while the worker kept writing the file.
    case 'exportQuery':
    case 'exportRows':
      return null;
    case 'osRequest':
    case 'osSearch':
    case 'osSql': {
      const t = req && 'timeoutMs' in req ? req.timeoutMs : undefined;
      return t && t > 0 ? t + OS_DEADLINE_SLACK_MS : 120_000;
    }
    case 'compareQuery':
      return 90_000;
    case 'compareSchema':
      return 120_000;
    case 'ping':
      return 5_000;
    case 'connect':
      return 60_000;
    case 'disconnect':
    case 'cancel':
    case 'setStatementTimeout':
      return 15_000;
    case 'introspect':
      return 180_000;
    default:
      return 120_000;
  }
}

const OS_DEADLINE_SLACK_MS = 10_000;

/**
 * The request that stops the worker-side work of `req` once its IPC
 * deadline passed (SC-06): a timeout must not leave the job running and
 * the lane busy. Null when nothing can be cancelled.
 */
export function cancelRequestFor(req: WorkerRequest, id: string): WorkerRequest | null {
  switch (req.kind) {
    case 'commitEditBatch':
    case 'applyDdl':
    case 'explain':
    case 'safeRunStart':
    case 'query':
      return { kind: 'cancel', id };
    // aiQuery runs on the aux connection: stopping it must not touch the primary query.
    case 'aiQuery':
    case 'introspect':
    case 'sidebandQuery':
      return { kind: 'cancelAux', id };
    case 'compareQuery':
      return { kind: 'compareCancel', id, runId: req.runId };
    case 'importRun':
      return { kind: 'importCancel', id, jobId: req.job.jobId };
    case 'osRequest':
    case 'osSearch':
    case 'osSql':
      return req.requestId ? { kind: 'osCancel', id, requestId: req.requestId } : null;
    case 'redisCommand':
    case 'redisAnalyze':
    case 'redisDeleteByPattern':
    case 'redisBulkDelete':
    case 'redisScan':
      return { kind: 'redisCancel', id };
    default:
      return null;
  }
}

/** Requests that occupy an exclusive worker lane: a hang here blocks everything behind. */
export function holdsExclusiveLane(kind: WorkerRequest['kind']): boolean {
  switch (kind) {
    case 'query':
    case 'commitEditBatch':
    case 'applyDdl':
    case 'importRun':
    case 'explain':
    case 'exportQuery':
    case 'beginTxn':
    case 'commitTxn':
    case 'rollbackTxn':
    case 'sidebandQuery':
    case 'aiQuery':
    case 'connect':
    case 'disconnect':
      return true;
    default:
      return false;
  }
}

/** Safe SET statement_timeout SQL from a validated non-negative integer. */
export function formatStatementTimeoutSql(timeoutMs: number): string {
  const ms = Math.max(0, Math.floor(timeoutMs));
  return `SET statement_timeout = ${ms}`;
}
