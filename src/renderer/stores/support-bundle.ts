import { ipc } from '@/lib/ipc';
import type { SupportBundlePreview } from '@shared/support-bundle';
import { create } from 'zustand';

/**
 * State of the "Create support bundle" dialog. The bundle is built in main;
 * this holds what the dialog shows: every file's exact text, the toggle that
 * also hides host names and user names, and where it was saved.
 */
interface SupportBundleState {
  open: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  /** Hide host names, IP addresses, user names and e-mail addresses too. */
  redactHostsAndUsers: boolean;
  preview: SupportBundlePreview | null;
  /** Name of the file shown in the viewer. */
  selected: string | null;
  savedPath: string | null;
  openDialog(): Promise<void>;
  close(): void;
  setRedact(on: boolean): Promise<void>;
  select(name: string): void;
  save(): Promise<void>;
}

/** Only the answer to the latest request may land: the toggle can be flipped faster than main answers. */
let seq = 0;

async function load(
  set: (p: Partial<SupportBundleState>) => void,
  get: () => SupportBundleState,
): Promise<void> {
  const mine = ++seq;
  set({ loading: true, error: null });
  try {
    const preview = await ipc.support.preview({ redactHostsAndUsers: get().redactHostsAndUsers });
    if (mine !== seq) return;
    const keep = get().selected;
    set({
      preview,
      loading: false,
      selected:
        keep && preview.files.some((f) => f.name === keep)
          ? keep
          : (preview.files[0]?.name ?? null),
    });
  } catch (err) {
    if (mine !== seq) return;
    // The files on screen no longer match the checkbox, so none of them may be saved.
    set({
      loading: false,
      preview: null,
      selected: null,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export const useSupportBundle = create<SupportBundleState>((set, get) => ({
  open: false,
  loading: false,
  saving: false,
  error: null,
  redactHostsAndUsers: false,
  preview: null,
  selected: null,
  savedPath: null,

  async openDialog() {
    set({ open: true, preview: null, selected: null, savedPath: null, error: null });
    await load(set, get);
  },

  close() {
    seq++;
    set({ open: false, preview: null, selected: null, loading: false, saving: false });
  },

  async setRedact(on) {
    set({ redactHostsAndUsers: on, savedPath: null });
    await load(set, get);
  },

  select(name) {
    set({ selected: name });
  },

  async save() {
    const preview = get().preview;
    if (!preview || get().loading) return;
    set({ saving: true, error: null });
    try {
      const res = await ipc.support.save(preview.token, {
        redactHostsAndUsers: get().redactHostsAndUsers,
      });
      set({ saving: false, savedPath: res.saved ? res.filePath : null });
    } catch (err) {
      set({ saving: false, error: err instanceof Error ? err.message : String(err) });
    }
  },
}));
