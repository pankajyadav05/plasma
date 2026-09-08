/** Shared fixture coordinates for L1 Electron/IPC scenarios. */
export const PG = {
  host: process.env.PLASMA_E2E_PG_HOST || '127.0.0.1',
  port: Number(process.env.PLASMA_E2E_PG_PORT || 55432),
  database: process.env.PLASMA_E2E_PG_DB || 'plasma_e2e',
  user: process.env.PLASMA_E2E_PG_USER || 'plasma',
  password: process.env.PLASMA_E2E_PG_PASSWORD || 'plasma',
} as const;

export function pgConfig(over: Record<string, unknown> = {}) {
  const o = over as Partial<{id:string;name:string;host:string;port:number;database:string;user:string;password:string}>;
  return {
    id: o.id || 'e2e-pg-a',
    name: o.name || 'e2e-pg-a',
    engine: 'postgres' as const,
    host: o.host || PG.host,
    port: o.port || PG.port,
    database: o.database || PG.database,
    user: o.user || PG.user,
    password: o.password || PG.password,
    ssl: false,
    readOnly: false,
  };
}
