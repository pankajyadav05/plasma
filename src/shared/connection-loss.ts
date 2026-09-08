/**
 * U27 — connection-loss classification.
 *
 * A laptop that sleeps, a Wi-Fi change or a VPN reconnect leaves the
 * worker holding TCP sockets whose peer is gone. The socket may never
 * error (half-open) or may error long after the fact, so the driver
 * clients are dead while the app still believes it is connected.
 *
 * Everything that can tell "this failed because the transport is gone"
 * from "the server rejected this statement" funnels through here:
 *   - drivers mark themselves lost and throw `connectionLostError`
 *   - the worker tags its `error` response with `fatal: 'connection-lost'`
 *   - main uses that tag to reconnect once and retry (see
 *     `main/connection-recovery.ts`)
 *
 * Getting this wrong in the permissive direction costs one wasted
 * reconnect; getting it wrong in the strict direction leaves the user
 * with a dead session, so the matcher covers the transport failures the
 * three drivers actually surface.
 */

/** Tag carried on worker `error` responses for transport failures. */
export const CONNECTION_LOST = 'connection-lost' as const;
export type ConnectionLostTag = typeof CONNECTION_LOST;

/** Prefix used by drivers so a lost transport is unambiguous downstream. */
const LOST_PREFIX = 'connection lost';

/**
 * Substrings of the errors the drivers surface when the transport dies.
 * Lower-cased comparison; keep entries specific enough that a SQL-level
 * failure never matches.
 */
const LOST_PATTERNS = [
  // pg: socket died, or a query was issued on a client that already saw it
  'client has encountered a connection error and is not queryable',
  'connection terminated unexpectedly',
  'connection terminated',
  'server closed the connection unexpectedly',
  'terminating connection due to administrator command',
  'connection reset by peer',
  // ioredis
  'connection is closed',
  'stream is not writeable',
  "stream isn't writeable",
  'connection is already closed',
  'max retries per request limit reached',
  // node http / opensearch transport
  'socket hang up',
  'other side closed',
  // node socket / dns level
  'econnreset',
  'epipe',
  'econnrefused',
  'econnaborted',
  'etimedout',
  'ehostunreach',
  'enetunreach',
  'enetdown',
  'enotfound',
  'eai_again',
];

/**
 * Error class names used by the OpenSearch transport for transport-level
 * failures. Its messages ("Response timeout", "read ECONNRESET") are not
 * reliably distinctive, the class name is.
 */
const LOST_ERROR_NAMES = ['connectionerror', 'timeouterror'];

/** True when `message` describes a dead transport rather than a bad statement. */
export function isConnectionLostMessage(message: string): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  if (lower.startsWith(LOST_PREFIX)) return true;
  return LOST_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Raised once a layer knows its transport is gone: by the drivers when a
 * socket dies or a liveness probe goes unanswered, and by main when the
 * worker tags a response `fatal: 'connection-lost'`.
 */
export class ConnectionLostError extends Error {
  override readonly name = 'ConnectionLostError';

  constructor(reason: string) {
    super(reason.toLowerCase().startsWith(LOST_PREFIX) ? reason : `${LOST_PREFIX}: ${reason}`);
  }
}

/** True when `err` (any thrown value) describes a dead transport. */
export function isConnectionLostError(err: unknown): boolean {
  if (typeof err === 'string') return isConnectionLostMessage(err);
  if (!(err instanceof Error)) return false;
  if (err instanceof ConnectionLostError) return true;
  if (LOST_ERROR_NAMES.includes(err.name.toLowerCase())) return true;
  if ('code' in err && typeof err.code === 'string' && isConnectionLostMessage(err.code)) {
    return true;
  }
  return isConnectionLostMessage(err.message);
}
