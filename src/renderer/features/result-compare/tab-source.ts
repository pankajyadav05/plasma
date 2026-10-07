import { tableFullExport } from '@/lib/export';
import type { SideSeed } from '@/stores/compare';
import { useSession } from '@/stores/session';
import type { QueryTab } from '@/stores/session-types';

/**
 * What to compare for a tab. A SQL tab contributes the result it shows. A
 * table tab only holds one page, so it contributes the whole table (with the
 * tab's filters and sort) run fresh through the read-only path.
 */
export function seedForTab(tab: QueryTab): SideSeed | null {
  const st = useSession.getState();
  if (tab.kind === 'table' && tab.tableSchema && tab.tableName) {
    const cols = (st.schema?.columns ?? []) as Array<{
      schema: string;
      table: string;
      name: string;
      ordinal: number;
      isPrimaryKey?: boolean;
    }>;
    const mine = cols.filter((c) => c.schema === tab.tableSchema && c.table === tab.tableName);
    const full = tableFullExport({
      schema: tab.tableSchema,
      table: tab.tableName,
      allColumns: [...mine].sort((a, b) => a.ordinal - b.ordinal).map((c) => c.name),
      hiddenColumns: tab.hiddenColumns,
      sort: tab.tableSort,
      filters: tab.filters,
      primaryKey: mine.filter((c) => c.isPrimaryKey).map((c) => c.name),
    });
    return {
      kind: 'query',
      connectionId: st.activeConfig?.id ?? null,
      sql: full.sql,
      tabTitle: tab.title,
    };
  }
  if (tab.kind === 'sql' && tab.queryResult && tab.queryResult.columns.length > 0) {
    return { kind: 'tab', tabId: tab.id };
  }
  return null;
}

/** Tabs that can be a side of a comparison, with a short note for the picker. */
export function comparableTabs(tabs: QueryTab[]): Array<{ tab: QueryTab; note: string }> {
  const out: Array<{ tab: QueryTab; note: string }> = [];
  for (const tab of tabs) {
    if (tab.kind === 'sql' && tab.queryResult && tab.queryResult.columns.length > 0) {
      const n = tab.queryResult.rows.length;
      out.push({ tab, note: `${n.toLocaleString()} row${n === 1 ? '' : 's'}` });
    } else if (tab.kind === 'table' && tab.tableName) {
      out.push({ tab, note: 'whole table' });
    }
  }
  return out;
}
