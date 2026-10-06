/** What the agent is told about the tab the user is looking at (sent only with schema sharing). */
import type { Filter, TableSort } from '@/lib/table-query';
import { columnsForTable } from '@/stores/session-tab-model';
import type { QueryTab, SessionState } from '@/stores/session-types';
import { HIDDEN_FILTER_VALUE } from '@shared/table-view';

const MAX_SQL_CHARS = 2000;
const MAX_CONTEXT_CHARS = 7000;
const MAX_COLUMNS = 40;

/** Values are row data (an FK click sets one from a cell): shown only with the row-data opt-in. */
function describeFilter(f: Filter, showValues: boolean): string {
  const nullary = f.op === 'IS NULL' || f.op === 'IS NOT NULL';
  const off = f.enabled === false ? ' (off)' : '';
  return `${f.column} ${f.op}${nullary ? '' : ` ${showValues ? f.value : HIDDEN_FILTER_VALUE}`}${off}`;
}

/** `Current tab: …` for the active table or SQL tab, or undefined for anything else. */
export function buildAgentContext(
  state: Pick<SessionState, 'tabs' | 'activeTabId' | 'schema'>,
  opts: { rowData?: boolean } = {},
): string | undefined {
  const tab: QueryTab | undefined = state.tabs.find((t) => t.id === state.activeTabId);
  if (!tab) return undefined;
  if (tab.kind === 'table' && tab.tableSchema && tab.tableName) {
    const all = columnsForTable(state.schema, tab.tableSchema, tab.tableName);
    const hidden = tab.hiddenColumns as Set<string>;
    const shown = all.filter((c) => !hidden.has(c));
    const cols =
      shown.length > MAX_COLUMNS
        ? `${shown.slice(0, MAX_COLUMNS).join(', ')} +${shown.length - MAX_COLUMNS} more`
        : shown.join(', ');
    const sort = (tab.tableSort as TableSort[]).map((s) => `${s.column} ${s.direction}`).join(', ');
    const filters = (tab.filters as Filter[]).map((f) => describeFilter(f, opts.rowData === true));
    return `Current tab: table ${tab.tableSchema}.${tab.tableName}; columns shown: ${
      cols || 'all'
    }; sort: ${sort || 'none'}; filters: ${filters.join('; ') || 'none'}; page size: ${
      tab.pageSize
    }`.slice(0, MAX_CONTEXT_CHARS);
  }
  if (tab.kind === 'sql') {
    const sql = String(tab.sql ?? '').trim();
    return `Current tab: SQL editor${
      sql
        ? `\n${sql.length > MAX_SQL_CHARS ? `${sql.slice(0, MAX_SQL_CHARS)}\n-- … truncated` : sql}`
        : ''
    }`.slice(0, MAX_CONTEXT_CHARS);
  }
  return undefined;
}
