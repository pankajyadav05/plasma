import { TabStrip } from '@/features/editor/TabStrip';
import { useActiveTab } from '@/stores/session';
import { OsHomeView } from './OsHomeView';
import { OsIndexView } from './OsIndexView';
import { OsSearchView } from './OsSearchView';
import { OsSqlView } from './OsSqlView';

const OS_TAB_KINDS = new Set(['os-index', 'os-search', 'os-sql']);

/**
 * OpenSearch canvas — picks the correct view based on the active tab.
 *
 *   - os-index   → OsIndexView (mapping + index stats)
 *   - os-search  → OsSearchView (Discover-style + DSL toggle)
 *   - os-sql     → OsSqlView (SQL plugin canvas)
 *   - other      → OsHomeView (cluster summary + aliases + ILM)
 */
export function OsCanvas() {
  const tab = useActiveTab();
  const hasTabs = tab ? OS_TAB_KINDS.has(tab.kind) : false;
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      {hasTabs && <TabStrip />}
      <OsBody />
    </main>
  );
}

function OsBody() {
  const tab = useActiveTab();
  if (!tab) return <OsHomeView />;
  if (tab.kind === 'os-index' && tab.osIndex) {
    return <OsIndexView indexName={tab.osIndex} />;
  }
  if (tab.kind === 'os-search' && tab.osIndex) {
    return <OsSearchView tabId={tab.id} indexName={tab.osIndex} />;
  }
  if (tab.kind === 'os-sql') return <OsSqlView tabId={tab.id} />;
  return <OsHomeView />;
}
