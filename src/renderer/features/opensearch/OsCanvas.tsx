import { TabStrip } from '@/features/editor/TabStrip';
import { useActiveTab, useSession } from '@/stores/session';
import { useEffect } from 'react';
import { OsConsoleView } from './OsConsoleView';
import { OsHomeView } from './OsHomeView';
import { OsIndexView } from './OsIndexView';
import { OsSearchView } from './OsSearchView';
import { OsSqlView } from './OsSqlView';
import { useOsStore } from './os-store';

const OS_TAB_KINDS = new Set(['os-index', 'os-search', 'os-sql', 'os-console']);

/**
 * OpenSearch canvas — picks the correct view based on the active tab.
 *
 *   - os-index   → OsIndexView (mapping, settings, aliases, operations)
 *   - os-search  → OsSearchView (Discover-style + DSL toggle)
 *   - os-sql     → OsSqlView (SQL plugin canvas)
 *   - os-console → OsConsoleView (Dev Tools console)
 *   - other      → OsHomeView (cluster overview, nodes, shards, tasks…)
 */
export function OsCanvas() {
  const tab = useActiveTab();
  const hasTabs = tab ? OS_TAB_KINDS.has(tab.kind) : false;
  useDropClosedTabState();
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--wb-content)] text-[var(--wb-text)]">
      {hasTabs && <TabStrip />}
      <OsBody />
    </main>
  );
}

/** Per-tab view state (O7) outlives tab switches but not the tab itself. */
function useDropClosedTabState() {
  const tabIds = useSession((s) => s.tabs.map((t) => t.id).join('\n'));
  useEffect(() => {
    const live = new Set(tabIds.split('\n'));
    const store = useOsStore.getState();
    for (const id of [
      ...Object.keys(store.search),
      ...Object.keys(store.sql),
      ...Object.keys(store.console),
    ]) {
      if (!live.has(id)) store.dropTab(id);
    }
  }, [tabIds]);
}

function OsBody() {
  const tab = useActiveTab();
  if (!tab) return <OsHomeView />;
  if (tab.kind === 'os-index' && tab.osIndex) {
    return <OsIndexView key={tab.id} tabId={tab.id} indexName={tab.osIndex} />;
  }
  if (tab.kind === 'os-search' && tab.osIndex) {
    return <OsSearchView key={tab.id} tabId={tab.id} indexName={tab.osIndex} />;
  }
  if (tab.kind === 'os-sql') return <OsSqlView key={tab.id} tabId={tab.id} />;
  if (tab.kind === 'os-console') return <OsConsoleView key={tab.id} tabId={tab.id} />;
  return <OsHomeView />;
}
