/**
 * Argument parsing + write gating for the OpenSearch IPC handlers
 * (S1 / O1 / O6 / O14). Pure so the policy is unit-tested without
 * Electron; `index.ts` wires these into `ipcMain.handle`.
 */
import {
  OS_HTTP_METHODS,
  OS_READ_ONLY_MESSAGE,
  type OsHttpMethod,
  isOsReadRequest,
  isReadOnlyOsSql,
} from '@shared/os-write-policy';

/** Throw when the live session is read-only. */
export function assertOsWritable(readOnly: boolean): void {
  if (readOnly) throw new Error(OS_READ_ONLY_MESSAGE);
}

function optTimeout(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0
    ? Math.min(Math.round(v), 3_600_000)
    : undefined;
}

function optId(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= 128 ? v : undefined;
}

export interface OsSearchArgs {
  index: string;
  body: string;
  size: number;
  timeoutMs?: number;
  requestId?: string;
}

export function parseOsSearchArgs(raw: unknown): OsSearchArgs {
  const p = (raw ?? {}) as Record<string, unknown>;
  if (typeof p.index !== 'string' || !p.index) throw new Error('index must be a string');
  if (typeof p.body !== 'string') throw new Error('body must be a string');
  const size =
    typeof p.size === 'number' && Number.isInteger(p.size) && p.size > 0
      ? Math.min(p.size, 10_000)
      : 100;
  return {
    index: p.index,
    body: p.body,
    size,
    timeoutMs: optTimeout(p.timeoutMs),
    requestId: optId(p.requestId),
  };
}

export interface OsSqlArgs {
  query: string;
  fetchSize?: number;
  cursor?: string;
  timeoutMs?: number;
  requestId?: string;
}

/** Accepts the legacy bare-string form or `{ query, fetchSize?, cursor?, … }`. */
export function parseOsSqlArgs(raw: unknown, readOnly: boolean): OsSqlArgs {
  const p: Record<string, unknown> =
    typeof raw === 'string' ? { query: raw } : ((raw ?? {}) as Record<string, unknown>);
  const query = typeof p.query === 'string' ? p.query : '';
  const cursor = typeof p.cursor === 'string' && p.cursor ? p.cursor : undefined;
  if (!cursor && !query.trim()) throw new Error('query required');
  if (!cursor && readOnly && !isReadOnlyOsSql(query)) throw new Error(OS_READ_ONLY_MESSAGE);
  const fetchSize =
    typeof p.fetchSize === 'number' && Number.isInteger(p.fetchSize) && p.fetchSize > 0
      ? Math.min(p.fetchSize, 10_000)
      : undefined;
  return {
    query: cursor ? '' : query,
    fetchSize,
    cursor,
    timeoutMs: optTimeout(p.timeoutMs),
    requestId: optId(p.requestId),
  };
}

export interface OsRequestArgs {
  method: OsHttpMethod;
  path: string;
  body?: string;
  timeoutMs?: number;
  requestId?: string;
}

/** Validate a console/raw REST call and refuse writes on read-only sessions. */
export function parseOsRequestArgs(raw: unknown, readOnly: boolean): OsRequestArgs {
  const p = (raw ?? {}) as Record<string, unknown>;
  const method = typeof p.method === 'string' ? p.method.toUpperCase() : '';
  if (!(OS_HTTP_METHODS as readonly string[]).includes(method)) {
    throw new Error(`unsupported method: ${String(p.method)}`);
  }
  if (typeof p.path !== 'string' || !p.path.trim()) throw new Error('path required');
  const path = p.path.trim();
  if (/^[a-z]+:\/\//i.test(path)) throw new Error('path must be relative to the cluster');
  const body = typeof p.body === 'string' && p.body.trim() ? p.body : undefined;
  if (readOnly && !isOsReadRequest(method, path, body)) throw new Error(OS_READ_ONLY_MESSAGE);
  return {
    method: method as OsHttpMethod,
    path,
    body,
    timeoutMs: optTimeout(p.timeoutMs),
    requestId: optId(p.requestId),
  };
}
