import type { ConnectionEngine } from '@shared/protocol';
import {
  Boxes,
  Database,
  DatabaseZap,
  FileSpreadsheet,
  HardDrive,
  Layers,
  type LucideIcon,
  Rows3,
} from 'lucide-react';

/** Icon per storage engine (sidebar rows, switcher, connection cards). */
export const ENGINE_ICON: Record<ConnectionEngine, LucideIcon> = {
  postgres: Database,
  redis: Layers,
  opensearch: Boxes,
  sqlite: HardDrive,
  mysql: DatabaseZap,
  clickhouse: Rows3,
  duckdb: FileSpreadsheet,
};

/** Product name per engine. */
export const ENGINE_LABEL: Record<ConnectionEngine, string> = {
  postgres: 'PostgreSQL',
  redis: 'Redis',
  opensearch: 'OpenSearch',
  sqlite: 'SQLite',
  mysql: 'MySQL',
  clickhouse: 'ClickHouse',
  duckdb: 'DuckDB',
};

/** Last path segment: `/home/me/data/app.db` -> `app.db`. */
export function fileBaseName(path: string): string {
  return path.replace(/[\\/]+$/, '').replace(/^.*[\\/]/, '');
}

/**
 * The "database" part of a connection as shown in the capsule and cards: the
 * file name for SQLite / a DuckDB file (the path is in the tooltip), "in-memory"
 * style labels for a DuckDB data-file session, the database otherwise.
 */
export function databaseLabel(c: {
  engine?: ConnectionEngine;
  database?: string;
  duckdb?: { files: string[] };
}): string {
  const database = c.database ?? '';
  if (c.engine === 'duckdb') {
    if (database && database !== ':memory:') return fileBaseName(database);
    const files = c.duckdb?.files ?? [];
    if (files.length === 1) return fileBaseName(files[0] as string);
    return files.length > 1 ? `${files.length} files` : 'in-memory';
  }
  return c.engine === 'sqlite' ? fileBaseName(database) : database;
}

/**
 * Capsule version text: "PostgreSQL 16.2", "SQLite 3.46", "MySQL 8.4",
 * "MariaDB 10.11" — the engine's own name, major.minor only.
 */
export function shortServerVersion(full: string | null, engine: ConnectionEngine): string {
  if (!full) return ENGINE_LABEL[engine];
  const pg = full.match(/^(PostgreSQL\s+[\d.]+)/);
  if (pg) return pg[1] as string;
  const named = full.match(/^(MySQL|MariaDB)\s+(\d+\.\d+)/i);
  if (named) return `${named[1]} ${named[2]}`;
  const ch = full.match(/^ClickHouse\s+(\d+\.\d+)/i);
  if (ch) return `ClickHouse ${ch[1]}`;
  // SQLite / Redis / OpenSearch report bare versions ("3.46.0") — prefix the engine.
  if (/^\d/.test(full)) {
    const v = full.split(/\s/)[0] as string;
    const short = engine === 'sqlite' || engine === 'duckdb' ? (v.match(/^\d+\.\d+/)?.[0] ?? v) : v;
    return `${ENGINE_LABEL[engine]} ${short}`;
  }
  return full.length > 32 ? `${full.slice(0, 32)}…` : full;
}
