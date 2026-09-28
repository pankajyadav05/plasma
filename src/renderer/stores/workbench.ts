import type { ColumnMeta } from '@shared/protocol';
import { create } from 'zustand';

/**
 * Transient workbench chrome state — which left-sidebar mode is showing,
 * where the SQL caret sits, and which result row the Details panel
 * inspects. Kept out of `session.ts` because none of it is persisted or
 * touches the connection lifecycle; components publish and read it
 * directly.
 */

export type SidebarMode = 'items' | 'queries' | 'history';

export interface EditorCursor {
  line: number;
  column: number;
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

interface WorkbenchState {
  sidebarMode: SidebarMode;
  editorCursor: EditorCursor | null;
  inspectedRow: InspectedRow | null;
  setSidebarMode(mode: SidebarMode): void;
  setEditorCursor(cursor: EditorCursor | null): void;
  setInspectedRow(row: InspectedRow | null): void;
}

export const useWorkbench = create<WorkbenchState>((set) => ({
  sidebarMode: 'items',
  editorCursor: null,
  inspectedRow: null,
  setSidebarMode: (sidebarMode) => set({ sidebarMode }),
  setEditorCursor: (editorCursor) => set({ editorCursor }),
  setInspectedRow: (inspectedRow) => set({ inspectedRow }),
}));
