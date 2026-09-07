import type { WorkerRequest } from './protocol';

/** Exponential backoff for worker respawn (U20). */
export function nextBackoffMs(
  currentMs: number,
  baseMs = 250,
  maxMs = 10_000,
): number {
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
 * Per-op IPC deadline. SQL queries return `null` — their budget is PG
 * `statement_timeout` (queryTimeoutMs), not a blanket IPC timer (U20).
 */
export function ipcDeadlineMs(kind: WorkerRequest['kind']): number | null {
  switch (kind) {
    case 'query':
    case 'sidebandQuery':
      return null;
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

/** Safe SET statement_timeout SQL from a validated non-negative integer. */
export function formatStatementTimeoutSql(timeoutMs: number): string {
  const ms = Math.max(0, Math.floor(timeoutMs));
  return `SET statement_timeout = ${ms}`;
}
