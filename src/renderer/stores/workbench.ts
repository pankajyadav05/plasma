import type { ColumnStat } from '@/features/result-grid/column-stats';
import type { EditorCaret } from '@/lib/sql-split';
import type { ColumnMeta } from '@shared/protocol';
import { create } from 'zustand';

/**
 * Transient workbench chrome state — which left-sidebar mode is showing,
 * where the SQL caret sits, which result row the Details panel inspects,
 * each tab's result view, and the editor's row limit. Kept out of
 * `session.ts` because none of it touches the connection lifecycle;
 * only the row limit is persisted (localStorage), matching TablePlus
 * remembering the editor's limit between launches.
 */

export type SidebarMode = 'items' | 'queries' | 'history';
export type ResultView = 'data' | 'message' | 'chart';

export interface EditorCursor {
  line: number;
  column: number;
  /** 0-based character offset of the caret in the buffer. */
  offset: number;
  /** Characters in the current selection (0 when collapsed). */
  selectionLength: number;
}

export interface InspectedRow {
  tabId: string;
  /** 1-based position across the whole result (page offset included). */
  rowNumber: number;
  /** Column index of the selected cell, so the panel can highlight it. */
  columnIndex: number;
  columns: ColumnMeta[];
  row: unknown[];
}

/** Quick stats of the grid's selected cell range, shown in the result footer. */
export interface SelectionStats {
  tabId: string;
  rows: number;
  cells: number;
  stats: ColumnStat[];
}

/** Choices for the editor's "No limit" menu. `null` = no limit. */
export const ROW_LIMIT_CHOICES: readonly (number | null)[] = [null, 100, 300, 500, 1000, 5000];

const ROW_LIMIT_KEY = 'plasma.editor.rowLimit';

function readRowLimit(): number | null {
  try {
    const raw = globalThis.localStorage?.getItem(ROW_LIMIT_KEY);
    const n = raw ? Number(raw) : Number.NaN;
    return ROW_LIMIT_CHOICES.includes(n) ? n : null;
  } catch {
    return null;
  }
}

const WORD_WRAP_KEY = 'plasma.editor.wordWrap';

function readWordWrap(): boolean {
  try {
    return globalThis.localStorage?.getItem(WORD_WRAP_KEY) !== 'off';
  } catch {
    return true;
  }
}

/** App-level dialogs any command (keymap, palette, menu) can open. */
export type Overlay =
  | 'codegen'
  | 'notebook'
  | 'schemaDiff'
  | 'cheatSheet'
  | 'backup'
  | 'restore'
  | 'roles'
  | 'dbSearch'
  | null;

/** Caret for one SQL tab, stamped with the buffer length it was read from. */
export interface TabCaret extends EditorCaret {
  bufferLength: number;
}

interface WorkbenchState {
  sidebarMode: SidebarMode;
  /**
   * Per-tab editor caret. Run commands read the *active tab's* entry, so
   * a caret from another tab (or a stale one) can never pick the target.
   */
  carets: Record<string, TabCaret>;
  editorCursor: EditorCursor | null;
  inspectedRow: InspectedRow | null;
  selectionStats: SelectionStats | null;
  rowLimit: number | null;
  resultViews: Record<string, ResultView>;
  /** ⌘J: hide the SQL tab's inline editor so the results take the room. */
  editorHidden: boolean;
  /** Bumped to ask the SQL editor to take focus (history / new tab / ⌘J). */
  editorFocusNonce: number;
  wordWrap: boolean;
  overlay: Overlay;
  setEditorHidden(hidden: boolean): void;
  /** Un-hide the editor and focus it. */
  showEditor(): void;
  setWordWrap(on: boolean): void;
  setOverlay(overlay: Overlay): void;
  setSidebarMode(mode: SidebarMode): void;
  setCaret(tabId: string, caret: TabCaret | null): void;
  setEditorCursor(cursor: EditorCursor | null): void;
  setInspectedRow(row: InspectedRow | null): void;
  setSelectionStats(stats: SelectionStats | null): void;
  setRowLimit(limit: number | null): void;
  setResultView(tabId: string, view: ResultView): void;
}

export const useWorkbench = create<WorkbenchState>((set) => ({
  sidebarMode: 'items',
  carets: {},
  editorCursor: null,
  inspectedRow: null,
  selectionStats: null,
  rowLimit: readRowLimit(),
  resultViews: {},
  editorHidden: false,
  editorFocusNonce: 0,
  wordWrap: readWordWrap(),
  overlay: null,
  setEditorHidden: (editorHidden) => set({ editorHidden }),
  showEditor: () => set((s) => ({ editorHidden: false, editorFocusNonce: s.editorFocusNonce + 1 })),
  setWordWrap: (wordWrap) => {
    try {
      globalThis.localStorage?.setItem(WORD_WRAP_KEY, wordWrap ? 'on' : 'off');
    } catch {
      /* storage unavailable */
    }
    set({ wordWrap });
  },
  setOverlay: (overlay) => set({ overlay }),
  setSidebarMode: (sidebarMode) => set({ sidebarMode }),
  setCaret: (tabId, caret) =>
    set((s) => {
      const next = { ...s.carets };
      if (caret) next[tabId] = caret;
      else delete next[tabId];
      return { carets: next };
    }),
  setEditorCursor: (editorCursor) => set({ editorCursor }),
  setInspectedRow: (inspectedRow) => set({ inspectedRow }),
  setSelectionStats: (selectionStats) => set({ selectionStats }),
  setRowLimit: (rowLimit) => {
    try {
      if (rowLimit === null) globalThis.localStorage?.removeItem(ROW_LIMIT_KEY);
      else globalThis.localStorage?.setItem(ROW_LIMIT_KEY, String(rowLimit));
    } catch {
      /* storage unavailable — keep the in-memory value */
    }
    set({ rowLimit });
  },
  setResultView: (tabId, view) =>
    set((s) => ({ resultViews: { ...s.resultViews, [tabId]: view } })),
}));
