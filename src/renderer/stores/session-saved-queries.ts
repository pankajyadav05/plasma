/**
 * Saved-query list helpers (PC6): build an entry from a tab, update an
 * entry in place, and patch name / folder / favourite. Pure so the
 * session actions stay thin and the rules are unit-testable.
 */
import type { SavedQuery } from '@shared/protocol';

/** The tab fields a saved query snapshots. */
export interface SavableTab {
  kind: string;
  sql: string;
  pageSize: number;
  tableSchema?: string;
  tableName?: string;
  filters: Array<{ id: string; column: string; op: string; value: string }>;
  tableSort: Array<{ column: string; direction: 'asc' | 'desc' }>;
  hiddenColumns: Set<string>;
  stickyColumns: Set<string>;
}

/** Snapshot `tab` as a saved query. Keeps id / createdAt / folder / favourite of `base`. */
export function savedQueryFromTab(
  tab: SavableTab,
  meta: { id: string; name: string; now: number },
  base?: SavedQuery,
): SavedQuery {
  const common = {
    id: meta.id,
    name: meta.name,
    createdAt: base?.createdAt ?? meta.now,
    updatedAt: meta.now,
    ...(base?.folder ? { folder: base.folder } : {}),
    ...(base?.favorite ? { favorite: true } : {}),
  };
  if (tab.kind === 'table' && tab.tableSchema && tab.tableName) {
    return {
      ...common,
      kind: 'table',
      tableSchema: tab.tableSchema,
      tableName: tab.tableName,
      filters: tab.filters.map((f) => ({ ...f })) as Extract<
        SavedQuery,
        { kind: 'table' }
      >['filters'],
      sort: tab.tableSort.map((s) => ({ ...s })) as Extract<SavedQuery, { kind: 'table' }>['sort'],
      hidden: [...tab.hiddenColumns],
      sticky: [...tab.stickyColumns],
      pageSize: tab.pageSize,
    };
  }
  return { ...common, kind: 'sql', sql: tab.sql, pageSize: tab.pageSize };
}

export type SavedQueryPatch = { name?: string; folder?: string | null; favorite?: boolean };

/** Apply a rename / move / favourite patch. Returns the same list when nothing changed. */
export function patchSavedQuery(
  list: SavedQuery[],
  id: string,
  patch: SavedQueryPatch,
  now: number,
): SavedQuery[] {
  let changed = false;
  const next = list.map((q) => {
    if (q.id !== id) return q;
    let out: SavedQuery = { ...q };
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (name && name !== q.name) {
        out.name = name;
        changed = true;
      }
    }
    if (patch.folder !== undefined) {
      const folder = patch.folder?.trim() || undefined;
      if (folder !== q.folder) {
        if (folder) out.folder = folder;
        else {
          const { folder: _drop, ...rest } = out;
          out = rest as SavedQuery;
        }
        changed = true;
      }
    }
    if (patch.favorite !== undefined && Boolean(q.favorite) !== patch.favorite) {
      if (patch.favorite) out.favorite = true;
      else {
        const { favorite: _drop, ...rest } = out;
        out = rest as SavedQuery;
      }
      changed = true;
    }
    if (changed) out.updatedAt = now;
    return out;
  });
  return changed ? next : list;
}

/** Replace entry `id` with `entry` (update in place), keeping its position. */
export function replaceSavedQuery(list: SavedQuery[], entry: SavedQuery): SavedQuery[] {
  const idx = list.findIndex((q) => q.id === entry.id);
  if (idx === -1) return [entry, ...list];
  const next = list.slice();
  next[idx] = entry;
  return next;
}

/** Folder names in use, sorted. */
export function savedQueryFolders(list: SavedQuery[]): string[] {
  return [...new Set(list.map((q) => q.folder).filter((f): f is string => Boolean(f)))].sort(
    (a, b) => a.localeCompare(b),
  );
}
