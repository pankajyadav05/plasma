import type { ConnectionConfig } from '@shared/protocol';
import type { SqlEngineDriver } from '../sql-engine';
import type { EngineEnv, OpenOpts } from './fixture';
import { FlakyProxy } from './tcp-proxy';

export interface EnvOpts {
  /** Schema name the fixture tables live in. */
  schema: string;
  /** See `EngineEnv.shared`. */
  shared: boolean;
  /** A fresh, unconnected driver. */
  create: () => SqlEngineDriver;
  /** Connection config for one session. `port` is the server's; the env swaps in the proxy's. */
  base: (opts: OpenOpts) => ConnectionConfig;
  /** Server address, when the engine is reached over TCP (enables the loss proxy). */
  server?: { host: string; port: number };
  /** Runs after every session of the env is closed (drop the scratch database, remove files). */
  cleanup?: () => Promise<void>;
}

/** The standard env: sessions through `create`/`base`, an admin session, an optional loss proxy. */
export async function buildEnv(o: EnvOpts): Promise<EngineEnv> {
  const proxy = o.server ? new FlakyProxy(o.server.host, o.server.port) : undefined;
  if (proxy) await proxy.start();
  let admin: SqlEngineDriver | null = null;

  const config = (opts: OpenOpts = {}): ConnectionConfig => {
    const cfg = o.base(opts);
    return opts.viaProxy && proxy ? { ...cfg, host: '127.0.0.1', port: proxy.port } : cfg;
  };

  const env: EngineEnv = {
    schema: o.schema,
    shared: o.shared,
    create: o.create,
    config,
    proxy,
    async open(opts = {}) {
      const d = o.create();
      await d.connect(config(opts), opts.statementTimeoutMs ?? 0);
      d.setConnectionGen(1);
      return d;
    },
    async admin(sql, params) {
      if (!admin) {
        admin = o.create();
        await admin.connect(config(), 0);
        admin.setConnectionGen(1);
      }
      return admin.query(sql, params);
    },
    async teardown() {
      await admin?.disconnect().catch(() => undefined);
      await proxy?.stop();
      await o.cleanup?.();
    },
  };
  return env;
}
