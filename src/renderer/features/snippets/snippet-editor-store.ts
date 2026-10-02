import { create } from 'zustand';

export interface SnippetDraft {
  /** Present when editing an existing user snippet. */
  id?: string;
  name: string;
  prefix: string;
  description: string;
  body: string;
}

interface SnippetEditorState {
  draft: SnippetDraft | null;
  open(draft: SnippetDraft): void;
  close(): void;
}

/** The snippet create / edit dialog (opened from the Snippets panel and the editor menu). */
export const useSnippetEditor = create<SnippetEditorState>()((set) => ({
  draft: null,
  open: (draft) => set({ draft }),
  close: () => set({ draft: null }),
}));
