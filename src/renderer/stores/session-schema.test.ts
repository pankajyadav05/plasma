import type { IntrospectOpts, SchemaInfo } from '@shared/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const introspect = vi.fn<(opts?: IntrospectOpts) => Promise<Partial<SchemaInfo>>>();
vi.mock('@/lib/ipc', () => ({
  ipc: { conn: { introspect: (o?: IntrospectOpts) => introspect(o) } },
}));

import {
  defaultSchemaName,
  ensureSchemaColumns,
  mergeColumns,
  refreshSchemaCoalesced,
} from './session-schema';

const col = (schema: string, table: string, name: string) => ({
  schema,
  table,
  name,
  dataType: 'int4',
  ordinal: 1,
  isPrimaryKey: false,
  isNullable: true,
  hasDefault: false,
});

const objects: Partial<SchemaInfo> = {
  schemas: [{ name: 'app' }, { name: 'public' }],
  tables: [],
  routines: [],
  sequences: [],
  types: [],
  extensions: [],
};

function store(initial: Record<string, unknown> = {}) {
  let state: Record<string, unknown> = {
    activeConfig: { id: 'c1', engine: 'postgres' },
    schema: null,
    columnSchemas: new Set<string>(),
    currentSchema: null,
    ...initial,
  };
  const set = (patch: Record<string, unknown>) => {
    state = { ...state, ...patch };
  };
  const get = () => state;
  return { set, get };
}

beforeEach(() => {
  introspect.mockReset();
  introspect.mockImplementation(async (opts) => {
    if (opts?.columns === false) return objects;
    const schemas = opts?.columnSchemas ?? ['app', 'public'];
    return {
      columns: schemas.map((s) => col(s, 't', 'id')),
      foreignKeys: [],
    };
  });
});

describe('helpers', () => {
  it('picks public, else the first schema', () => {
    expect(defaultSchemaName({ schemas: [{ name: 'a' }, { name: 'public' }] })).toBe('public');
    expect(defaultSchemaName({ schemas: [{ name: 'a' }] })).toBe('a');
    expect(defaultSchemaName(null)).toBeNull();
  });

  it('mergeColumns replaces only the named schemas', () => {
    const base = {
      ...objects,
      columns: [col('app', 't', 'old'), col('public', 't', 'keep')],
      foreignKeys: [],
    } as SchemaInfo;
    const merged = mergeColumns(
      base,
      { columns: [col('app', 't', 'new'), col('x', 't', 'ignored')], foreignKeys: [] },
      ['app'],
    );
    expect(merged.columns.map((c) => `${c.schema}.${c.name}`)).toEqual(['public.keep', 'app.new']);
  });
});

describe('refreshSchemaCoalesced', () => {
  it('loads objects, then columns only for the default schema', async () => {
    const s = store();
    await refreshSchemaCoalesced(s.set, s.get);
    expect(introspect).toHaveBeenNthCalledWith(1, { columns: false });
    expect(introspect).toHaveBeenNthCalledWith(2, { objects: false, columnSchemas: ['public'] });
    const schema = s.get().schema as SchemaInfo;
    expect(schema.columns.map((c) => c.schema)).toEqual(['public']);
    expect([...(s.get().columnSchemas as Set<string>)]).toEqual(['public']);
  });

  it('coalesces a burst of refreshes into one follow-up run', async () => {
    const s = store();
    const a = refreshSchemaCoalesced(s.set, s.get);
    const b = refreshSchemaCoalesced(s.set, s.get);
    const c = refreshSchemaCoalesced(s.set, s.get);
    expect(b).toBe(c);
    await Promise.all([a, b, c]);
    // two runs × (objects + columns)
    expect(introspect).toHaveBeenCalledTimes(4);
  });

  it('records a failure as schemaError', async () => {
    introspect.mockRejectedValueOnce(new Error('permission denied'));
    const s = store();
    await refreshSchemaCoalesced(s.set, s.get);
    expect(s.get().schemaError).toBe('permission denied');
    expect(s.get().schemaLoading).toBe(false);
  });
});

describe('ensureSchemaColumns', () => {
  it('loads a schema once and merges it', async () => {
    const s = store();
    await refreshSchemaCoalesced(s.set, s.get);
    introspect.mockClear();
    await Promise.all([
      ensureSchemaColumns(s.set, s.get, 'app'),
      ensureSchemaColumns(s.set, s.get, 'app'),
    ]);
    expect(introspect).toHaveBeenCalledTimes(1);
    await ensureSchemaColumns(s.set, s.get, 'app');
    expect(introspect).toHaveBeenCalledTimes(1);
    const schema = s.get().schema as SchemaInfo;
    expect(schema.columns.map((c) => c.schema).sort()).toEqual(['app', 'public']);
  });

  it('ignores unknown schemas and missing schema info', async () => {
    const s = store();
    await ensureSchemaColumns(s.set, s.get, 'app');
    expect(introspect).not.toHaveBeenCalled();
  });
});
