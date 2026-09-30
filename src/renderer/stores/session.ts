import { useContext } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { PaneTabContext } from './pane-context';
import { createAiSlice } from './session-ai';
import { createConnectionSlice } from './session-connection';
import { createHistorySlice } from './session-history';
import { createOpenSearchSlice } from './session-opensearch';
import { createProdGateSlice } from './session-prod-gate';
import { createQuerySlice } from './session-query';
import { createRedisSlice } from './session-redis';
import { createRolesSlice } from './session-roles';
import { createSavedQueriesSlice } from './session-saved-queries';
import { createSchemaSlice } from './session-schema';
import { createSettingsSlice } from './session-settings';
import { createTableSlice } from './session-table';
import { createTabsSlice, installTabPersistence } from './session-tabs';
import type { QueryTab, SessionState } from './session-types';
import { createUiSlice } from './session-ui';

/**
 * Session store — the single source of truth for all renderer state.
 *
 * The store is composed from slices, one module per domain; each owns its
 * state fields and actions, and reaches the others through `get()`:
 *   - connection / schema / roles  — session lifecycle, introspection, SET ROLE
 *   - query / table                — editor runs, table browsing + row edits
 *   - tabs / saved-queries         — the tab strip, persistence, snippets
 *   - redis / opensearch           — non-relational engines
 *   - ai / history / settings      — assistant chat, query history, settings mirror
 *   - prod-gate / ui               — write confirmations, dialogs and panels
 *
 * Multi-tab: `tabs` holds one `QueryTab` per editor / table / key viewer,
 * each with its own SQL, result, pagination, sort and selection;
 * `activeTabId` picks the one the editor + grid render. `txnState` mirrors
 * the primary connection's real transaction status, which the worker reads
 * from the server after every statement (F4/F9).
 *
 * Everything callers import lives here: the public types and helpers are
 * re-exported below so `@/stores/session` stays the single entry point.
 */
export const useSession = create<SessionState>()((...a) => ({
  ...createConnectionSlice(...a),
  ...createSchemaSlice(...a),
  ...createRedisSlice(...a),
  ...createOpenSearchSlice(...a),
  ...createQuerySlice(...a),
  ...createTableSlice(...a),
  ...createTabsSlice(...a),
  ...createRolesSlice(...a),
  ...createSavedQueriesSlice(...a),
  ...createSettingsSlice(...a),
  ...createHistorySlice(...a),
  ...createAiSlice(...a),
  ...createProdGateSlice(...a),
  ...createUiSlice(...a),
}));

installTabPersistence(useSession);

export type {
  AiTurn,
  CanvasMode,
  ConnectionState,
  EntityKind,
  PendingEdit,
  QueryRunState,
  QueryTab,
  RightPanelMode,
  TabKind,
  TableViewMode,
} from './session-types';
export { activeTab } from './session-tab-model';
export { withDefaults } from './session-settings';

/** React hook helper: selects the currently active tab with proper memoization. */
export function useActiveTab(): QueryTab | undefined {
  // Inside a split pane the context names that pane's tab (see pane-context).
  const paneTab = useContext(PaneTabContext);
  return useSession((s) => s.tabs.find((t) => t.id === (paneTab ?? s.activeTabId)));
}

/**
 * Narrow subscription to the active tab (F13). `useActiveTab()` returns the
 * whole tab, so every keystroke in the editor (which patches `sql`)
 * re-renders its subscribers; pick only the fields a component reads:
 *
 *   const { kind, queryRunState } = useActiveTabSelect((t) => ({ kind: t?.kind, queryRunState: t?.queryRunState }));
 *
 * Objects / arrays are compared shallowly.
 */
export function useActiveTabSelect<T>(pick: (tab: QueryTab | undefined) => T): T {
  const paneTab = useContext(PaneTabContext);
  return useSession(
    useShallow((s) => pick(s.tabs.find((t) => t.id === (paneTab ?? s.activeTabId)))),
  );
}
