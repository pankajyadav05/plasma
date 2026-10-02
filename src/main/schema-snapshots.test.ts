import { SchemaInfo } from '@shared/protocol';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_SCHEMA_SNAPSHOTS,
  deleteSchemaSnapshot,
  ensureSchemaSnapshotsTable,
  getSchemaSnapshot,
  listSchemaSnapshots,
  migrateSettingsSnapshots,
  saveSchemaSnapshot,
} from './schema-snapshots';

const schema = (marker: string): SchemaInfo =>
  SchemaInfo.parse({
    schemas: [{ name: 'public' }],
    tables: [{ schema: 'public', name: marker, kind: 'table', rowCountEstimate: null }],
    columns: [],
  });

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  ensureSchemaSnapshotsTable(db);
});

describe('schema snapshots store (R-18)', () => {
  it('saves a snapshot, lists metadata only and fetches the schema by id', () => {
    const meta = saveSchemaSnapshot(db, {
      connectionId: 'c1',
      connectionName: 'prod',
      name: 'before',
      schema: schema('users'),
    });
    expect(listSchemaSnapshots(db)).toEqual([meta]);
    expect(Object.keys(meta).sort()).toEqual(
      ['connectionId', 'connectionName', 'createdAt', 'id', 'name'].sort(),
    );
    expect(getSchemaSnapshot(db, meta.id)).toMatchObject({ schemas: [{ name: 'public' }] });
    expect(getSchemaSnapshot(db, 'nope')).toBeNull();
  });

  it('deletes, and evicts the oldest past the cap', () => {
    const first = saveSchemaSnapshot(db, {
      connectionId: null,
      connectionName: 'x',
      name: 'first',
      schema: schema('a'),
    });
    for (let i = 0; i < MAX_SCHEMA_SNAPSHOTS; i++) {
      saveSchemaSnapshot(db, {
        connectionId: null,
        connectionName: 'x',
        name: `s${i}`,
        schema: schema('b'),
      });
    }
    const all = listSchemaSnapshots(db);
    expect(all).toHaveLength(MAX_SCHEMA_SNAPSHOTS);
    expect(all.some((s) => s.id === first.id)).toBe(false);
    deleteSchemaSnapshot(db, all[0]?.id as string);
    expect(listSchemaSnapshots(db)).toHaveLength(MAX_SCHEMA_SNAPSHOTS - 1);
  });

  it('rejects a malformed save request', () => {
    expect(() => saveSchemaSnapshot(db, { name: 'x' })).toThrow();
  });
});

describe('moving snapshots out of settings', () => {
  it('migrates the old settings array once and empties the settings key', () => {
    const old = [
      {
        id: 'old-1',
        connectionId: 'c1',
        connectionName: 'dev',
        name: 'legacy',
        schema: schema('t'),
        createdAt: 1000,
      },
      { id: 'broken', schema: { nope: true } },
    ];
    db.prepare('INSERT INTO settings VALUES (?, ?)').run('schemaSnapshots', JSON.stringify(old));
    expect(migrateSettingsSnapshots(db)).toBe(1);
    expect(listSchemaSnapshots(db).map((s) => s.id)).toEqual(['old-1']);
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('schemaSnapshots') as {
      value: string;
    };
    expect(row.value).toBe('[]');
    // Idempotent.
    expect(migrateSettingsSnapshots(db)).toBe(0);
  });
});
