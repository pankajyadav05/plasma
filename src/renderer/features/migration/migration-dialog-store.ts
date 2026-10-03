import { create } from 'zustand';

interface MigrationDialogState {
  open: boolean;
  show(): void;
  close(): void;
}

/** "Check migration": lints the whole editor script in a dialog. */
export const useMigrationDialog = create<MigrationDialogState>()((set) => ({
  open: false,
  show: () => set({ open: true }),
  close: () => set({ open: false }),
}));
