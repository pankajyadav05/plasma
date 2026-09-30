import { create } from 'zustand';
import {
  NO_SPLIT,
  type PaneId,
  type PaneState,
  applyLayout,
  closePane,
  focusPane,
  focusedActive,
  moveTab,
  noteActive,
  parseLayout,
  prune,
  serializeLayout,
  splitRight,
  switchPane,
} from './pane-state';
import { type QueryTab, useSession } from './session';
import { MAX_SQL_CHARS } from './session-tabs';

/**
 * Split editor panes (TablePlus "Split pane right"). The reducer is in
 * `pane-state.ts`; this store wires it to the session's tab list and
 * persists the layout per connection next to the persisted tabs.
 */

interface PanesStore extends PaneState {
  /** Move the active tab into a new right pane (opens a scratch tab when it is the only one). */
  splitRight(tabId?: string): void;
  closePane(): void;
  moveTab(tabId: string, to: PaneId, index?: number): void;
  focusPane(pane: PaneId): void;
  switchPane(step: 1 | -1): void;
}

const LAYOUT_PREFIX = 'plasma.panes.';

/** Same rule the tab persistence uses, so indices line up on restore. */
function isPersistable(t: QueryTab): boolean {
  if (t.kind === 'sql') return t.sql.length <= MAX_SQL_CHARS;
  return t.kind === 'table' && Boolean(t.tableSchema) && Boolean(t.tableName);
}

const persistableIds = (tabs: readonly QueryTab[]) => tabs.filter(isPersistable).map((t) => t.id);
const allIds = () => useSession.getState().tabs.map((t) => t.id);

function commit(next: PaneState): void {
  const cur = usePanes.getState();
  if (
    next.secondary === cur.secondary &&
    next.primaryActive === cur.primaryActive &&
    next.secondaryActive === cur.secondaryActive &&
    next.focus === cur.focus
  ) {
    return;
  }
  usePanes.setState({
    secondary: next.secondary,
    primaryActive: next.primaryActive,
    secondaryActive: next.secondaryActive,
    focus: next.focus,
  });
  // Keep the session's active tab equal to the focused pane's.
  const active = focusedActive(next, allIds());
  const session = useSession.getState();
  if (active && active !== session.activeTabId) session.setActiveTab(active);
}

const snapshot = (): PaneState => {
  const { secondary, primaryActive, secondaryActive, focus } = usePanes.getState();
  return { secondary, primaryActive, secondaryActive, focus };
};

export const usePanes = create<PanesStore>(() => ({
  ...NO_SPLIT,
  splitRight(tabId) {
    const session = useSession.getState();
    let id = tabId ?? session.activeTabId;
    if (session.tabs.length < 2) {
      // Only one tab: keep it on the left and give the right pane a fresh query tab.
      session.addTab();
      id = useSession.getState().activeTabId;
    }
    commit(splitRight(snapshot(), allIds(), id));
  },
  closePane: () => commit(closePane(snapshot(), allIds())),
  moveTab: (tabId, to, index) => commit(moveTab(snapshot(), allIds(), tabId, to, index)),
  focusPane: (pane) => commit(focusPane(snapshot(), pane)),
  switchPane: (step) => commit(switchPane(snapshot(), step)),
}));

// ─── Session sync + persistence ──────────────────────────────────────

let lastConn: string | null = null;
let lastTabs: readonly QueryTab[] = [];
let lastActive = '';

function layoutKey(connId: string): string {
  return `${LAYOUT_PREFIX}${connId}`;
}

function saveLayout(): void {
  const { tabsConnectionId, tabs } = useSession.getState();
  if (!tabsConnectionId) return;
  try {
    const layout = serializeLayout(snapshot(), persistableIds(tabs));
    if (layout)
      globalThis.localStorage?.setItem(layoutKey(tabsConnectionId), JSON.stringify(layout));
    else globalThis.localStorage?.removeItem(layoutKey(tabsConnectionId));
  } catch {
    /* storage unavailable */
  }
}

function restoreLayout(connId: string): void {
  let layout = null;
  try {
    const raw = globalThis.localStorage?.getItem(layoutKey(connId));
    layout = raw ? parseLayout(JSON.parse(raw)) : null;
  } catch {
    layout = null;
  }
  if (!layout) return;
  const session = useSession.getState();
  const next = applyLayout(layout, persistableIds(session.tabs), session.activeTabId);
  if (!next.secondary) return;
  usePanes.setState(next);
  // Restored table tabs load lazily when first activated: touch each pane's
  // tab, then leave the session on the focused one.
  for (const id of [next.secondaryActive, next.primaryActive]) if (id) session.setActiveTab(id);
  const focused = focusedActive(next, allIds());
  if (focused) session.setActiveTab(focused);
}

useSession.subscribe((state) => {
  if (state.tabsConnectionId !== lastConn) {
    lastConn = state.tabsConnectionId;
    lastTabs = state.tabs;
    lastActive = state.activeTabId;
    usePanes.setState(NO_SPLIT);
    if (lastConn) restoreLayout(lastConn);
    return;
  }
  if (state.tabs !== lastTabs) {
    lastTabs = state.tabs;
    const ids = state.tabs.map((t) => t.id);
    const cur = snapshot();
    if (cur.secondary) {
      const pruned = prune(cur, ids);
      if (pruned !== cur) {
        usePanes.setState(pruned);
        saveLayout();
      }
    }
  }
  if (state.activeTabId !== lastActive) {
    lastActive = state.activeTabId;
    const cur = snapshot();
    const next = noteActive(
      cur,
      state.tabs.map((t) => t.id),
      state.activeTabId,
    );
    if (next !== cur) usePanes.setState(next);
  }
});

usePanes.subscribe((state, prev) => {
  if (
    state.secondary !== prev.secondary ||
    state.secondaryActive !== prev.secondaryActive ||
    state.focus !== prev.focus
  ) {
    saveLayout();
  }
});
