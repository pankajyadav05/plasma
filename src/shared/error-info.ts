/**
 * The machine-readable part of a failure: the codes a driver, Node, the SSH
 * library or the server put on the error object. They cross the worker / main /
 * renderer boundaries next to the message (which alone is a poor thing to
 * classify: it is localised by some servers and reworded by every driver
 * release), and `connect-diagnosis.ts` turns them into a cause.
 */
export interface ErrorInfo {
  /** `ECONNREFUSED`, `ER_ACCESS_DENIED_ERROR`, a SQLSTATE (`28P01`), a ClickHouse code (`516`)... */
  code?: string;
  /** MySQL error number (1045), or the negative errno Node reports (-111). */
  errno?: number;
  /** SQLSTATE where the driver separates it from `code` (mysql2). */
  sqlstate?: string;
  /** HTTP status of an OpenSearch / ClickHouse reply. */
  status?: number;
  /** Error class name: `ConnectionError`, `ClickHouseError`, `ReplyError`... */
  name?: string;
  /** ClickHouse's textual error type (`AUTHENTICATION_FAILED`). */
  type?: string;
  /** Node `syscall` (`connect`, `getaddrinfo`). */
  syscall?: string;
  /** ssh2 error level: `client-authentication`, `client-socket`, `client-timeout`... */
  level?: string;
  /** The user refused or did not answer the SSH host-key prompt: the key was new or had changed. */
  hostKey?: 'changed' | 'unknown';
  /** Why the SSH jump host could not open the connection to the database (`Connection refused`). */
  forwardError?: string;
  /** Where the failure happened, when the caller knows: the SSH tunnel or the database driver. */
  source?: 'ssh' | 'driver';
}

const SHORT = 200;

function str(v: unknown): string | undefined {
  if (typeof v === 'string' && v) return v.slice(0, SHORT);
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** What an error object carries beyond its message, or undefined when it carries nothing. */
export function errorInfoOf(err: unknown): ErrorInfo | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as Record<string, unknown>;
  const meta = (e.meta && typeof e.meta === 'object' ? e.meta : {}) as Record<string, unknown>;
  const info: ErrorInfo = {};
  const code = str(e.code);
  if (code) info.code = code;
  const errno = num(e.errno);
  if (errno !== undefined) info.errno = errno;
  const sqlstate = str(e.sqlState) ?? str(e.sqlstate);
  if (sqlstate) info.sqlstate = sqlstate;
  const status = num(e.statusCode) ?? num(e.status) ?? num(meta.statusCode);
  if (status !== undefined) info.status = status;
  const name = str(e.name);
  if (name && name !== 'Error') info.name = name;
  const type = str(e.type);
  if (type) info.type = type;
  const syscall = str(e.syscall);
  if (syscall) info.syscall = syscall;
  const level = str(e.level);
  if (level) info.level = level;
  if (e.hostKey === 'changed' || e.hostKey === 'unknown') info.hostKey = e.hostKey;
  const forwardError = str(e.forwardError);
  if (forwardError) info.forwardError = forwardError;
  if (e.source === 'ssh' || e.source === 'driver') info.source = e.source;
  return Object.keys(info).length > 0 ? info : undefined;
}

/** `err` with `info` merged on as properties, so it survives being rethrown (and read back by `errorInfoOf`). */
export function withErrorInfo(err: unknown, info: ErrorInfo): Error {
  const out = err instanceof Error ? err : new Error(String(err));
  Object.assign(out, info);
  return out;
}
