import { randomUUID } from 'node:crypto';
import { SchemaInfo, type SchemaSnapshotMeta, SchemaSnapshotSaveRequest } from '@shared/protocol';
import type Database from 'better-sqlite3';

/**
 * Schema-diff snapshots (R-18). They used to live in `settings.schemaSnapshots`,
 * so every settings write (a column-width drag, the theme) carried up to 50
 * whole schemas over IPC and through SQLite. Now each snapshot is its own row
 * and the renderer lists metadata only, fetching a schema when it needs one.
 */

/** Oldest snapshots are evicted past this many. */
export const MAX_SCHEMA_SNAPSHOTS = 50;

export function ensureSchemaSnapshotsTable(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS schema_snapshots (
      id              TEXT PRIMARY KEY,
      connection_id   TEXT,
      connection_name TEXT NOT NULL,
      name            TEXT NOT NULL,
      schema_json     TEXT NOT NULL,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_schema_snapshots_created
      ON schema_snapshots (created_at DESC);
  `);
}

interface Row {
  id: string;
  connection_id: string | null;
  connection_name: string;
  name: string;
  created_at: number;
}

const toMeta = (r: Row): SchemaSnapshotMeta => ({
  id: r.id,
  connectionId: r.connection_id,
  connectionName: r.connection_name,
  name: r.name,
  createdAt: r.created_at,
});

export function listSchemaSnapshots(d: Database.Database): SchemaSnapshotMeta[] {
  return d
    .prepare<[], Row>(
      `SELECT id, connection_id, connection_name, name, created_at
         FROM schema_snapshots ORDER BY created_at DESC`,
    )
    .all()
    .map(toMeta);
}

export function getSchemaSnapshot(d: Database.Database, id: string): SchemaInfo | null {
  const row = d
    .prepare<[string], { schema_json: string }>(
      'SELECT schema_json FROM schema_snapshots WHERE id = ?',
    )
    .get(id);
  if (!row) return null;
  try {
    return SchemaInfo.parse(JSON.parse(row.schema_json));
  } catch {
    return null;
  }
}

export function saveSchemaSnapshot(d: Database.Database, raw: unknown): SchemaSnapshotMeta {
  const req = SchemaSnapshotSaveRequest.parse(raw);
  const meta: SchemaSnapshotMeta = {
    id: randomUUID(),
    connectionId: req.connectionId,
    connectionName: req.connectionName,
    name: req.name,
    createdAt: Date.now(),
  };
  d.transaction(() => {
    d.prepare(
      `INSERT INTO schema_snapshots
         (id, connection_id, connection_name, name, schema_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      meta.id,
      meta.connectionId,
      meta.connectionName,
      meta.name,
      JSON.stringify(req.schema),
      meta.createdAt,
    );
    d.prepare(
      `DELETE FROM schema_snapshots WHERE id IN (
         SELECT id FROM schema_snapshots ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?
       )`,
    ).run(MAX_SCHEMA_SNAPSHOTS);
  })();
  return meta;
}

export function deleteSchemaSnapshot(d: Database.Database, id: string): void {
  d.prepare('DELETE FROM schema_snapshots WHERE id = ?').run(id);
}

/**
 * One-time move of snapshots stored in settings by older builds. The
 * settings key is rewritten to `[]` so the payload shrinks right away.
 * Returns how many were moved.
 */
export function migrateSettingsSnapshots(d: Database.Database): number {
  const row = d
    .prepare<[string], { value: string }>('SELECT value FROM settings WHERE key = ?')
    .get('schemaSnapshots');
  if (!row) return 0;
  let list: unknown;
  try {
    list = JSON.parse(row.value);
  } catch {
    return 0;
  }
  if (!Array.isArray(list) || list.length === 0) return 0;
  let moved = 0;
  d.transaction(() => {
    const insert = d.prepare(
      `INSERT OR IGNORE INTO schema_snapshots
         (id, connection_id, connection_name, name, schema_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const item of list as Array<Record<string, unknown>>) {
      const schema = SchemaInfo.safeParse(item.schema);
      if (!schema.success || typeof item.id !== 'string') continue;
      moved += insert.run(
        item.id,
        typeof item.connectionId === 'string' ? item.connectionId : null,
        typeof item.connectionName === 'string' ? item.connectionName : 'unknown',
        typeof item.name === 'string' ? item.name : 'snapshot',
        JSON.stringify(schema.data),
        typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
      ).changes;
    }
    d.prepare('UPDATE settings SET value = ? WHERE key = ?').run('[]', 'schemaSnapshots');
  })();
  return moved;
}
