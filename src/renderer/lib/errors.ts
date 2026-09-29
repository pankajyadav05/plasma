/**
 * Electron wraps IPC rejections as
 * "Error invoking remote method 'plasma:…': SomeError: <message>".
 * Show only the underlying message.
 */
export function cleanIpcError(message: string): string {
  return message.replace(/^Error invoking remote method '[^']+':\s*(?:\w*Error:\s*)?/, '');
}

/**
 * Connection failures with an actionable hint where the raw driver text
 * is misleading (e.g. Redis closing the socket after a rejected AUTH
 * surfaces as "connection lost: Connection is closed").
 */
export function describeConnectError(message: string, engine?: string): string {
  const clean = cleanIpcError(message);
  if (engine === 'redis' && /connection is closed|connection lost/i.test(clean)) {
    return `${clean} — Redis closed the connection. Check the ACL user and password (leave both empty if the server has no auth), host, port and TLS.`;
  }
  if (/ECONNREFUSED/i.test(clean)) {
    return `${clean} — nothing is listening there. Check the host and port, and that the server is running.`;
  }
  return clean;
}
