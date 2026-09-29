/**
 * Postgres schema loading for the session store (F16 / PC4).
 *
 * Objects (schemas, relations, routines, sequences, types, extensions)
 * load for the whole database; columns + foreign keys load per schema,
 * on demand — the current schema at connect, then any schema the user
 * switches to or opens a table from. A refresh re-reads the object list
 * and only the schemas whose columns were already loaded, and concurrent
 * refresh requests (a burst of DDL statements) coalesce into one
 * follow-up run instead of queueing a full introspection each.
 */
import { ipc } from '@/lib/ipc';
import type { SchemaInfo } from '@shared/protocol';

// biome-ignore lint/suspicious/noExplicitAny: slice composed into SessionState
type Set_ = (partial: any, ...args: any[]) => void;
// biome-ignore lint/suspicious/noExplicitAny: slice composed into SessionState
type Get = () => any;

type ColumnPart = Pick<SchemaInfo, 'columns' | 'foreignKeys'>;

/** Schema the sidebar shows first: `public` when present, else the first one. */
export function defaultSchemaName(info: Pick<SchemaInfo, 'schemas'> | null): string | null {
  if (!info || info.schemas.length === 0) return null;
  return (info.schemas.find((s) => s.name === 'public') ?? info.schemas[0])?.name ?? null;
}

/** Replace the columns / FKs of `schemas` in `base` with those from `part`. */
export function mergeColumns(base: SchemaInfo, part: ColumnPart, schemas: string[]): SchemaInfo {
  const replaced = new Set(schemas);
  return {
    ...base,
    columns: [
      ...base.columns.filter((c) => !replaced.has(c.schema)),
      ...(part.columns ?? []).filter((c) => replaced.has(c.schema)),
    ],
    foreignKeys: [
      ...(base.foreignKeys ?? []).filter((f) => !replaced.has(f.schema)),
      ...(part.foreignKeys ?? []).filter((f) => replaced.has(f.schema)),
    ],
  };
}

/** Normalise a (possibly older-shaped) object listing into a full SchemaInfo. */
export function withObjects(objects: Partial<SchemaInfo>, columns: ColumnPart): SchemaInfo {
  return {
    schemas: objects.schemas ?? [],
    tables: objects.tables ?? [],
    routines: objects.routines ?? [],
    sequences: objects.sequences ?? [],
    types: objects.types ?? [],
    extensions: objects.extensions ?? [],
    columns: columns.columns ?? [],
    foreignKeys: columns.foreignKeys ?? [],
  };
}

let running: Promise<void> | null = null;
let queued: Promise<void> | null = null;
const pendingColumns = new Map<string, Promise<void>>();

/**
 * Refresh the schema. If a refresh is already running, one more run is
 * queued behind it (callers asking during the queue share that run).
 */
export function refreshSchemaCoalesced(set: Set_, get: Get): Promise<void> {
  if (!running) {
    running = doRefresh(set, get).finally(() => {
      running = null;
    });
    return running;
  }
  if (!queued) {
    queued = running.then(() => {
      queued = null;
      return refreshSchemaCoalesced(set, get);
    });
  }
  return queued;
}

async function doRefresh(set: Set_, get: Get): Promise<void> {
  // Postgres-only — redis/opensearch have their own overview loaders.
  const eng = get().activeConfig?.engine ?? 'postgres';
  if (eng !== 'postgres') return;
  const connId = get().activeConfig?.id;
  set({ schemaLoading: true, schemaError: null });
  try {
    const objects = await ipc.conn.introspect({ columns: false });
    if (get().activeConfig?.id !== connId) return;
    const known = new Set((objects.schemas ?? []).map((s) => s.name));
    // A null schema means a fresh connection: forget earlier loads.
    const loaded: string[] = get().schema ? [...(get().columnSchemas ?? [])] : [];
    const current: string | null =
      get().currentSchema ??
      defaultSchemaName(withObjects(objects, { columns: [], foreignKeys: [] }));
    const targets = [...new Set([...loaded, ...(current ? [current] : [])])].filter((n) =>
      known.has(n),
    );
    const cols: ColumnPart =
      targets.length > 0
        ? await ipc.conn.introspect({ objects: false, columnSchemas: targets })
        : { columns: [], foreignKeys: [] };
    if (get().activeConfig?.id !== connId) return;
    set({ schema: withObjects(objects, cols), columnSchemas: new Set(targets) });
  } catch (err) {
    console.error('[plasma] introspect failed', err);
    set({ schemaError: err instanceof Error ? err.message : String(err) });
  } finally {
    set({ schemaLoading: false });
  }
}

/** Load columns + FKs for one schema if they aren't loaded yet. */
export function ensureSchemaColumns(set: Set_, get: Get, schemaName: string): Promise<void> {
  const state = get();
  if ((state.activeConfig?.engine ?? 'postgres') !== 'postgres') return Promise.resolve();
  if (!state.schema || state.columnSchemas?.has(schemaName)) return Promise.resolve();
  if (!state.schema.schemas.some((s: { name: string }) => s.name === schemaName)) {
    return Promise.resolve();
  }
  const pending = pendingColumns.get(schemaName);
  if (pending) return pending;
  const connId = state.activeConfig?.id;
  const task = (async () => {
    try {
      const part = await ipc.conn.introspect({ objects: false, columnSchemas: [schemaName] });
      const now = get();
      if (!now.schema || now.activeConfig?.id !== connId) return;
      set({
        schema: mergeColumns(now.schema, part, [schemaName]),
        columnSchemas: new Set([...(now.columnSchemas ?? []), schemaName]),
      });
    } catch (err) {
      console.error('[plasma] column introspect failed', err);
    } finally {
      pendingColumns.delete(schemaName);
    }
  })();
  pendingColumns.set(schemaName, task);
  return task;
}

/** Load columns for every schema — for whole-database views (schema diff). */
export async function ensureAllSchemaColumns(set: Set_, get: Get): Promise<void> {
  const state = get();
  if (!state.schema) return;
  const missing = state.schema.schemas
    .map((s: { name: string }) => s.name)
    .filter((n: string) => !state.columnSchemas?.has(n));
  if (missing.length === 0) return;
  const connId = state.activeConfig?.id;
  try {
    const part = await ipc.conn.introspect({ objects: false, columnSchemas: missing });
    const now = get();
    if (!now.schema || now.activeConfig?.id !== connId) return;
    set({
      schema: mergeColumns(now.schema, part, missing),
      columnSchemas: new Set([...(now.columnSchemas ?? []), ...missing]),
    });
  } catch (err) {
    console.error('[plasma] column introspect failed', err);
  }
}
