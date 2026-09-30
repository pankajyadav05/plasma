/**
 * UI slice: dialogs, the command palette, the canvas mode, the entity-list
 * selection, the right rail and the global edit-mode switch.
 */
import type { ConnectionConfig } from '@shared/protocol';
import { activeTab, toggled } from './session-tab-model';
import type { CanvasMode, EntityKind, RightPanelMode, SliceCreator } from './session-types';
import { useWorkbench } from './workbench';

export interface UiSlice {
  /** Drives what the main right-side canvas renders. */
  canvasMode: CanvasMode;
  /** Current schema selection for the entity list. */
  currentSchema: string | null;
  /** Entity-kind filter for the entity list. */
  entityFilter: Set<EntityKind>;
  // ── right rail panel ──
  /** Which panel is open in the right-side rail. null = collapsed. */
  rightPanelMode: RightPanelMode;

  // ── edit mode ──
  /** Global safety gate for writes. When false, all mutation UI is hidden. */
  editMode: boolean;

  // ── dialogs & overlays ──
  dialogOpen: boolean;
  dialogPrefill: ConnectionConfig | null;
  paletteOpen: boolean;
  settingsOpen: boolean;
  historyOpen: boolean;
  deleteConfirmConnectionId: string | null;
  openDialog(prefill?: ConnectionConfig): void;
  closeDialog(): void;
  setPaletteOpen(open: boolean): void;
  togglePalette(): void;
  toggleEditMode(): void;
  requestDeleteConnection(id: string | null): void;
  // Canvas mode + entity filtering
  setCanvasMode(mode: CanvasMode): void;
  setCurrentSchema(name: string | null): void;
  toggleEntityFilter(kind: EntityKind): void;
  toggleEditor(): void;
  setEditorExpanded(expanded: boolean): void;
  setRightPanelMode(mode: RightPanelMode): void;
}

export const createUiSlice: SliceCreator<UiSlice> = (set, get) => ({
  canvasMode: 'database',
  currentSchema: null,
  entityFilter: new Set<EntityKind>([
    'table',
    'view',
    'matview',
    'foreign',
    'partitioned',
    'function',
    'procedure',
    'sequence',
    'type',
    'extension',
  ]),
  rightPanelMode: 'details',
  editMode: false,
  dialogOpen: false,
  dialogPrefill: null,
  paletteOpen: false,
  settingsOpen: false,
  historyOpen: false,
  deleteConfirmConnectionId: null,

  // ── dialog / palette / settings toggles ──

  openDialog: (prefill) => set({ dialogOpen: true, dialogPrefill: prefill ?? null }),
  closeDialog: () => set({ dialogOpen: false, dialogPrefill: null }),

  setPaletteOpen: (open) => set({ paletteOpen: open }),
  togglePalette: () => set({ paletteOpen: !get().paletteOpen }),

  toggleEditMode: () => set({ editMode: !get().editMode }),

  requestDeleteConnection: (id) => set({ deleteConfirmConnectionId: id }),

  // ── canvas mode + entity filtering ──

  setCanvasMode(mode) {
    set({ canvasMode: mode });
    if (mode === 'history') {
      void get().loadHistory();
    }
  },

  setCurrentSchema(name) {
    set({ currentSchema: name });
    if (name) void get().ensureSchemaColumns(name);
  },

  toggleEntityFilter(kind) {
    set({ entityFilter: toggled(get().entityFilter, kind) });
  },

  // ── right rail panel ──

  toggleEditor() {
    // ⌘J: SQL tabs show / hide the inline editor (results take the room);
    // table tabs toggle the compiled-SQL pane of the right sidebar.
    const tab = activeTab(get());
    if (tab?.kind === 'table') {
      set({ rightPanelMode: get().rightPanelMode === 'query' ? 'details' : 'query' });
      return;
    }
    const wb = useWorkbench.getState();
    if (wb.editorHidden) wb.showEditor();
    else wb.setEditorHidden(true);
  },

  setEditorExpanded(expanded) {
    // "Open the editor" = show + focus the inline editor of a SQL tab
    // (a new one when a table tab is active). Never touches the sidebar.
    if (!expanded) {
      useWorkbench.getState().setEditorHidden(true);
      return;
    }
    if (activeTab(get())?.kind !== 'sql') get().addTab();
    set({ canvasMode: 'database' });
    useWorkbench.getState().showEditor();
  },

  setRightPanelMode(mode) {
    set({ rightPanelMode: mode });
  },
});
