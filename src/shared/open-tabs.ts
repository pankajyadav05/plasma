import {
  type OpenTabsSnapshot,
  type PersistedOpenTab,
  OpenTabsSnapshot as OpenTabsSnapshotSchema,
  PersistedOpenTab as PersistedOpenTabSchema,
} from './protocol';

/**
 * Pure helpers for U25 session restore. Kept free of Electron/Zustand so
 * vitest can cover serialize ↔ restore without a renderer.
 */

export type TabLike = {
  id: string;
  title: string;
  kind: PersistedOpenTab['kind'];
  sql: string;
  pageSize: number;
  tableSchema?: string;
  tableName?: string;
  tableSort: Array<{ column: string; direction: 'asc' | 'desc' }>;
  filters: Array<{ id: string; column: string; op: string; value: string }>;
  hiddenColumns: Set<string> | string[];
  stickyColumns: Set<string> | string[];
  viewMode: 'data' | 'definition';
  redisKey?: string;
  redisChannel?: string;
  redisPattern?: boolean;
  osIndex?: string;
  osBody?: string;
  osQueryString?: string;
  osSql?: string;
};

function setToArray(v: Set<string> | string[] | undefined): string[] | undefined {
  if (!v) return undefined;
  const arr = v instanceof Set ? [...v] : [...v];
  return arr.length > 0 ? arr : undefined;
}

/** Project a live tab down to the persisted shape (no results / selection). */
export function serializeTab(tab: TabLike): PersistedOpenTab {
  const base: PersistedOpenTab = {
    id: tab.id,
    title: tab.title,
    kind: tab.kind,
    sql: tab.sql ?? '',
  };

  if (tab.pageSize) base.pageSize = tab.pageSize;

  if (tab.kind === 'table') {
    if (tab.tableSchema) base.tableSchema = tab.tableSchema;
    if (tab.tableName) base.tableName = tab.tableName;
    if (tab.tableSort?.length) base.tableSort = tab.tableSort;
    if (tab.filters?.length) {
      base.filters = tab.filters.map((f) => ({
        id: f.id,
        column: f.column,
        op: f.op,
        value: f.value,
      }));
    }
    const hidden = setToArray(tab.hiddenColumns);
    if (hidden) base.hiddenColumns = hidden;
    const sticky = setToArray(tab.stickyColumns);
    if (sticky) base.stickyColumns = sticky;
    if (tab.viewMode) base.viewMode = tab.viewMode;
  }

  if (tab.redisKey) base.redisKey = tab.redisKey;
  if (tab.redisChannel) base.redisChannel = tab.redisChannel;
  if (tab.redisPattern) base.redisPattern = tab.redisPattern;
  if (tab.osIndex) base.osIndex = tab.osIndex;
  if (tab.osBody) base.osBody = tab.osBody;
  if (tab.osQueryString) base.osQueryString = tab.osQueryString;
  if (tab.osSql) base.osSql = tab.osSql;

  return PersistedOpenTabSchema.parse(base);
}

export function serializeSnapshot(
  tabs: TabLike[],
  activeTabId: string | null,
): OpenTabsSnapshot {
  return OpenTabsSnapshotSchema.parse({
    tabs: tabs.map(serializeTab),
    activeTabId,
  });
}

/** True when editable content differs from the restore/run baseline. */
export function isTabDirty(
  tab: { sql: string; kind: string; osBody?: string; osSql?: string },
  baseline: { sql: string; osBody?: string; osSql?: string },
): boolean {
  if ((tab.sql ?? '') !== (baseline.sql ?? '')) return true;
  if (tab.kind === 'os-search' && (tab.osBody ?? '') !== (baseline.osBody ?? '')) return true;
  if (tab.kind === 'os-sql' && (tab.osSql ?? '') !== (baseline.osSql ?? '')) return true;
  return false;
}
