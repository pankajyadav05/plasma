import type { ConnectionConfig, ConnectionEngine } from '@shared/protocol';

export const ENGINE_DEFAULTS: Record<
  ConnectionEngine,
  { port: number; database: string; user: string; ssl: boolean }
> = {
  postgres: { port: 5432, database: 'postgres', user: 'postgres', ssl: false },
  redis: { port: 6379, database: '0', user: '', ssl: false },
  opensearch: { port: 9200, database: '', user: '', ssl: false },
  sqlite: { port: 1, database: '', user: '', ssl: false },
  mysql: { port: 3306, database: '', user: 'root', ssl: false },
  clickhouse: { port: 8123, database: 'default', user: 'default', ssl: false },
  duckdb: { port: 1, database: '', user: '', ssl: false },
};

export function freshId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `conn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function freshConfig(engine: ConnectionEngine = 'postgres'): ConnectionConfig {
  const d = ENGINE_DEFAULTS[engine];
  return {
    id: freshId(),
    name: 'localhost',
    engine,
    host: 'localhost',
    port: d.port,
    database: d.database,
    user: d.user,
    password: '',
    ssl: d.ssl,
    readOnly: false,
  };
}

/** True when the name is still the placeholder a fresh config starts with. */
export function isPlaceholderName(name: string): boolean {
  return name === 'localhost' || !name.trim();
}
