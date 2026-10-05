/** The engines Plasma connects to, in the order the page lists them. One source for the hero chips and the Engines plate. */
export const ENGINE_LIST = [
  { name: 'Postgres', chip: 'bg-pg' },
  { name: 'MySQL · MariaDB', chip: 'bg-mysql' },
  { name: 'SQLite', chip: 'bg-sqlite' },
  { name: 'ClickHouse', chip: 'bg-clickhouse' },
  { name: 'DuckDB', chip: 'bg-duckdb' },
  { name: 'Redis', chip: 'bg-redis' },
  { name: 'OpenSearch', chip: 'bg-os' },
] as const;
