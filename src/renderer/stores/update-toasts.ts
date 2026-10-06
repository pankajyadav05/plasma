import { create } from 'zustand';

/**
 * A tiny queue for the few toasts the updater raises ("Plasma 3.2.2 is ready",
 * "Updated to Plasma 3.2.2", "The update could not be installed"). Not a
 * general notification system: nothing else in the app uses it.
 */
export interface UpdateToastAction {
  label: string;
  run: () => void;
}

export interface UpdateToast {
  id: string;
  tone: 'info' | 'warn';
  title: string;
  detail?: string;
  actions: UpdateToastAction[];
}

interface UpdateToastState {
  toasts: UpdateToast[];
  push(toast: Omit<UpdateToast, 'id'> & { id?: string }, autoDismissMs?: number): string;
  dismiss(id: string): void;
}

let seq = 0;

export const useUpdateToasts = create<UpdateToastState>((set, get) => ({
  toasts: [],
  push(toast, autoDismissMs) {
    const id = toast.id ?? `update-toast-${++seq}`;
    set((s) => ({ toasts: [...s.toasts.filter((t) => t.id !== id), { ...toast, id }] }));
    if (autoDismissMs) setTimeout(() => get().dismiss(id), autoDismissMs);
    return id;
  },
  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

/** `https://github.com/pankajyadav05/plasma/releases/tag/v<version>`, or null for an odd version. */
export function releaseNotesUrl(version: string): string | null {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
    ? `https://github.com/pankajyadav05/plasma/releases/tag/v${version}`
    : null;
}

/** Opens a page in the system browser through the window-open guard in main. */
export function openExternal(url: string): void {
  window.open(url, '_blank', 'noopener');
}
