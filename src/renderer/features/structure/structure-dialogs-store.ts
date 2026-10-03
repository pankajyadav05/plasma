import type { ImportPickedFile } from '@shared/protocol';
import { create } from 'zustand';

/**
 * Which structure / import dialog is open. A tiny store so the sidebar
 * menus, the command palette and the table Structure view can all open
 * the same dialogs, mounted once by `StructureDialogsHost`.
 */
interface DialogsState {
  createTable: { schema: string } | null;
  createView: { schema: string } | null;
  importInto: {
    schema: string;
    table: string | null;
    /** Pre-picked file (the `plasma import` command line). */
    file?: ImportPickedFile;
    /** Suggested name for a new table. */
    newName?: string;
  } | null;
  openCreateTable(schema: string): void;
  openCreateView(schema: string): void;
  openImport(
    schema: string,
    table: string | null,
    prefill?: { file?: ImportPickedFile; newName?: string },
  ): void;
  close(): void;
}

export const useStructureDialogs = create<DialogsState>((set) => ({
  createTable: null,
  createView: null,
  importInto: null,
  openCreateTable: (schema) => set({ createTable: { schema }, createView: null, importInto: null }),
  openCreateView: (schema) => set({ createView: { schema }, createTable: null, importInto: null }),
  openImport: (schema, table, prefill) =>
    set({ importInto: { schema, table, ...prefill }, createTable: null, createView: null }),
  close: () => set({ createTable: null, createView: null, importInto: null }),
}));
