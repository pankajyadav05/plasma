import type { ConnectionEngine } from './protocol';

/**
 * How a Redis "Host" field is interpreted (mirrors the worker's
 * `parseRedisEndpoint`; kept dependency-free so the dialog and main can
 * classify a host without importing worker code).
 */
export type RedisEndpointKind = 'tcp' | 'unix' | 'sentinel' | 'cluster';

export function redisEndpointKind(hostField: string): RedisEndpointKind {
  const host = hostField.trim().toLowerCase();
  if (host.startsWith('unix:') || host.startsWith('/')) return 'unix';
  if (host.startsWith('sentinel://')) return 'sentinel';
  if (host.startsWith('cluster://')) return 'cluster';
  return 'tcp';
}

export const REDIS_HOST_HINT: Record<Exclude<RedisEndpointKind, 'tcp'>, string> = {
  unix: 'Unix socket — the port is ignored.',
  sentinel: 'Sentinel — sentinel://host1:26379,host2:26379/master-name',
  cluster: 'Cluster — cluster://host1:7000,host2:7001 (seed nodes)',
};

/**
 * Why an SSH tunnel can't be used for this connection, or null when it can.
 * A tunnel forwards one TCP host:port, which a unix socket, a Sentinel
 * topology or a cluster's many nodes are not.
 */
export function sshUnsupportedReason(config: {
  engine?: ConnectionEngine;
  host: string;
}): string | null {
  if (config.engine === 'opensearch') return 'SSH tunnels are not available for OpenSearch.';
  if (config.engine === 'sqlite') return 'SQLite opens a local file — there is nothing to tunnel.';
  if (config.engine === 'duckdb') return 'DuckDB opens local files — there is nothing to tunnel.';
  if (config.engine !== 'redis') return null;
  switch (redisEndpointKind(config.host)) {
    case 'unix':
      return 'An SSH tunnel cannot forward a unix socket. Use a TCP host, or run Plasma on the machine that owns the socket.';
    case 'sentinel':
      return 'An SSH tunnel cannot be used with sentinel:// hosts — the master address is discovered at connect time. Connect to the master directly or tunnel it yourself.';
    case 'cluster':
      return 'An SSH tunnel cannot be used with cluster:// hosts — cluster nodes redirect to their own addresses. Connect to the cluster directly or tunnel every node yourself.';
    default:
      return null;
  }
}
