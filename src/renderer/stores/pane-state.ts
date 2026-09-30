/**
 * Split editor panes — pure state transitions.
 *
 * Tabs still live in the session store (one list, one `activeTabId`).
 * This state only records which tabs sit in the *secondary* (right)
 * pane; every other tab is in the primary pane. With no split
 * (`secondary === null`) nothing here changes how the app behaves.
 *
 * `session.activeTabId` always equals the focused pane's active tab, so
 * everything that reads "the active tab" keeps working per pane focus.
 */

export type PaneId = 'primary' | 'secondary';

export interface PaneState {
  /** Tab ids in the right pane, in strip order; null = no split. */
  secondary: string[] | null;
  primaryActive: string | null;
  secondaryActive: string | null;
  focus: PaneId;
}

export const NO_SPLIT: PaneState = {
  secondary: null,
  primaryActive: null,
  secondaryActive: null,
  focus: 'primary',
};

export function isSplit(s: PaneState): boolean {
  return s.secondary !== null;
}

/** Tabs of one pane, in session order (primary) / pane order (secondary). */
export function paneTabIds(s: PaneState, allIds: readonly string[], pane: PaneId): string[] {
  const sec = new Set(s.secondary ?? []);
  if (pane === 'secondary') return (s.secondary ?? []).filter((id) => allIds.includes(id));
  return allIds.filter((id) => !sec.has(id));
}

export function paneOf(s: PaneState, tabId: string): PaneId {
  return s.secondary?.includes(tabId) ? 'secondary' : 'primary';
}

/** The pane's active tab, falling back to its first tab when stale. */
export function activeIn(s: PaneState, allIds: readonly string[], pane: PaneId): string | null {
  const ids = paneTabIds(s, allIds, pane);
  const want = pane === 'primary' ? s.primaryActive : s.secondaryActive;
  return want && ids.includes(want) ? want : (ids[0] ?? null);
}

/** The session-level active tab implied by the focused pane. */
export function focusedActive(s: PaneState, allIds: readonly string[]): string | null {
  return activeIn(s, allIds, s.focus);
}

function collapse(s: PaneState, allIds: readonly string[]): PaneState {
  const active = focusedActive(s, allIds);
  return { ...NO_SPLIT, primaryActive: active };
}

/**
 * Move a tab to a pane (dragging, "Move to other pane"). Moving into a
 * pane that doesn't exist opens it. The primary pane never empties: its
 * last tab refuses to leave.
 */
export function moveTab(
  s: PaneState,
  allIds: readonly string[],
  tabId: string,
  to: PaneId,
  index?: number,
): PaneState {
  if (!allIds.includes(tabId)) return s;
  const from = paneOf(s, tabId);
  if (from === to && !isSplit(s)) return s;
  const primary = paneTabIds(s, allIds, 'primary');
  if (to === 'secondary' && from === 'primary' && primary.length <= 1) return s;

  if (to === 'secondary') {
    const rest = (s.secondary ?? []).filter((id) => id !== tabId);
    const at = index === undefined ? rest.length : Math.max(0, Math.min(index, rest.length));
    const next: PaneState = {
      secondary: [...rest.slice(0, at), tabId, ...rest.slice(at)],
      primaryActive:
        s.primaryActive === tabId ? (primary.find((id) => id !== tabId) ?? null) : s.primaryActive,
      secondaryActive: tabId,
      focus: 'secondary',
    };
    return next;
  }
  // to primary
  if (from === 'primary') return s;
  const secLeft = (s.secondary ?? []).filter((id) => id !== tabId);
  const next: PaneState = {
    ...s,
    secondary: secLeft,
    primaryActive: tabId,
    secondaryActive: s.secondaryActive === tabId ? (secLeft[0] ?? null) : s.secondaryActive,
    focus: 'primary',
  };
  return secLeft.length === 0 ? collapse(next, allIds) : next;
}

/** "Split pane right": the given tab moves into a new right pane. */
export function splitRight(s: PaneState, allIds: readonly string[], tabId: string): PaneState {
  return moveTab(s, allIds, tabId, 'secondary');
}

/** Close the right pane: its tabs rejoin the primary strip. */
export function closePane(s: PaneState, allIds: readonly string[]): PaneState {
  if (!isSplit(s)) return s;
  return collapse(s, allIds);
}

export function focusPane(s: PaneState, pane: PaneId): PaneState {
  if (!isSplit(s) || s.focus === pane) return s;
  return { ...s, focus: pane };
}

/** ⌥⌘] / ⌥⌘[ — no-op without a split. */
export function switchPane(s: PaneState, step: 1 | -1): PaneState {
  if (!isSplit(s)) return s;
  const order: PaneId[] = ['primary', 'secondary'];
  const at = order.indexOf(s.focus);
  return { ...s, focus: order[(at + step + order.length) % order.length] as PaneId };
}

/** A tab became active in the session (click, palette, table open). */
export function noteActive(s: PaneState, allIds: readonly string[], tabId: string): PaneState {
  if (!allIds.includes(tabId)) return s;
  if (!isSplit(s)) return s.primaryActive === tabId ? s : { ...s, primaryActive: tabId };
  const pane = paneOf(s, tabId);
  if (pane === 'secondary') {
    return s.focus === 'secondary' && s.secondaryActive === tabId
      ? s
      : { ...s, secondaryActive: tabId, focus: 'secondary' };
  }
  return s.focus === 'primary' && s.primaryActive === tabId
    ? s
    : { ...s, primaryActive: tabId, focus: 'primary' };
}

/** Drop ids that no longer exist; collapse an emptied pane. */
export function prune(s: PaneState, allIds: readonly string[]): PaneState {
  if (!isSplit(s)) return s;
  const secondary = (s.secondary ?? []).filter((id) => allIds.includes(id));
  const primary = allIds.filter((id) => !secondary.includes(id));
  if (secondary.length === 0 || primary.length === 0) {
    return collapse({ ...s, secondary }, allIds);
  }
  if (secondary.length === (s.secondary ?? []).length) return s;
  return { ...s, secondary };
}

// ─── Persistence ─────────────────────────────────────────────────────

/** Tabs are persisted by index (ids are regenerated on restore). */
export interface PersistedLayout {
  secondary: number[];
  secondaryActive: number;
  focus: PaneId;
}

export function serializeLayout(
  s: PaneState,
  persistableIds: readonly string[],
): PersistedLayout | null {
  if (!s.secondary) return null;
  const secondary = s.secondary.map((id) => persistableIds.indexOf(id)).filter((i) => i >= 0);
  if (secondary.length === 0 || secondary.length >= persistableIds.length) return null;
  const active = s.secondaryActive ? persistableIds.indexOf(s.secondaryActive) : -1;
  return {
    secondary,
    secondaryActive: active >= 0 ? active : (secondary[0] as number),
    focus: s.focus,
  };
}

export function parseLayout(raw: unknown): PersistedLayout | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<PersistedLayout>;
  if (!Array.isArray(r.secondary) || !r.secondary.every((n) => Number.isInteger(n) && n >= 0))
    return null;
  return {
    secondary: r.secondary,
    secondaryActive: Number.isInteger(r.secondaryActive)
      ? (r.secondaryActive as number)
      : (r.secondary[0] ?? 0),
    focus: r.focus === 'secondary' ? 'secondary' : 'primary',
  };
}

export function applyLayout(
  layout: PersistedLayout,
  persistableIds: readonly string[],
  activeId: string | null,
): PaneState {
  const secondary = layout.secondary
    .map((i) => persistableIds[i])
    .filter((id): id is string => Boolean(id));
  if (secondary.length === 0 || secondary.length >= persistableIds.length) return NO_SPLIT;
  const secondaryActive = persistableIds[layout.secondaryActive] ?? secondary[0] ?? null;
  const primary = persistableIds.filter((id) => !secondary.includes(id));
  return {
    secondary,
    secondaryActive,
    primaryActive: activeId && primary.includes(activeId) ? activeId : (primary[0] ?? null),
    focus: layout.focus,
  };
}
