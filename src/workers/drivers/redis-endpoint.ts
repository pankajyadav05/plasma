/**
 * Redis endpoint forms accepted in the connection's Host field (R19).
 *
 *   localhost                                    → plain TCP (host + port field)
 *   /var/run/redis.sock  |  unix:/path/redis.sock → unix socket (port ignored)
 *   sentinel://h1:26379,h2:26379/mymaster         → Sentinel, master "mymaster"
 *   sentinel://:sentinelpass@h1:26379/mymaster    → …with a Sentinel password
 *   cluster://h1:7000,h2:7001                     → Redis Cluster seed nodes
 *
 * A plain TCP endpoint that turns out to be a cluster node (INFO
 * redis_mode:cluster) is upgraded to a cluster client by the driver.
 */

export interface HostPort {
  host: string;
  port: number;
}

export type RedisEndpoint =
  | { kind: 'tcp'; host: string; port: number }
  | { kind: 'socket'; path: string }
  | {
      kind: 'sentinel';
      sentinels: HostPort[];
      name: string;
      sentinelUsername?: string;
      sentinelPassword?: string;
    }
  | { kind: 'cluster'; nodes: HostPort[] };

function parseHostList(list: string, defaultPort: number): HostPort[] {
  const out: HostPort[] = [];
  for (const raw of list.split(',')) {
    const item = raw.trim();
    if (!item) continue;
    // [ipv6]:port
    const v6 = item.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (v6) {
      out.push({ host: v6[1]!, port: v6[2] ? Number(v6[2]) : defaultPort });
      continue;
    }
    const i = item.lastIndexOf(':');
    if (i > 0 && /^\d+$/.test(item.slice(i + 1))) {
      out.push({ host: item.slice(0, i), port: Number(item.slice(i + 1)) });
    } else {
      out.push({ host: item, port: defaultPort });
    }
  }
  return out;
}

export function parseRedisEndpoint(hostField: string, port: number): RedisEndpoint {
  const host = hostField.trim();
  if (host.startsWith('unix:')) {
    return { kind: 'socket', path: host.slice('unix:'.length).replace(/^\/\/(?=\/)/, '') };
  }
  if (host.startsWith('/')) return { kind: 'socket', path: host };

  const sentinel = host.match(/^sentinel:\/\/(?:([^@/]*)@)?([^/]+)\/(.+)$/i);
  if (sentinel) {
    const auth = sentinel[1];
    let sentinelUsername: string | undefined;
    let sentinelPassword: string | undefined;
    if (auth) {
      const j = auth.indexOf(':');
      if (j >= 0) {
        sentinelUsername = decodeURIComponent(auth.slice(0, j)) || undefined;
        sentinelPassword = decodeURIComponent(auth.slice(j + 1)) || undefined;
      } else {
        sentinelPassword = decodeURIComponent(auth) || undefined;
      }
    }
    const sentinels = parseHostList(sentinel[2]!, 26379);
    if (sentinels.length === 0) throw new Error('sentinel:// needs at least one host');
    return {
      kind: 'sentinel',
      sentinels,
      name: decodeURIComponent(sentinel[3]!),
      sentinelUsername,
      sentinelPassword,
    };
  }
  if (/^sentinel:\/\//i.test(host)) {
    throw new Error('Sentinel host must look like sentinel://host:26379,host2:26379/master-name');
  }

  const cluster = host.match(/^cluster:\/\/(.+)$/i);
  if (cluster) {
    const nodes = parseHostList(cluster[1]!, port || 6379);
    if (nodes.length === 0) throw new Error('cluster:// needs at least one node');
    return { kind: 'cluster', nodes };
  }

  return { kind: 'tcp', host, port };
}
