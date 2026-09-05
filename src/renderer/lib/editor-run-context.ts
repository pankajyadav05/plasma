import type { EditorCaret } from '@/lib/sql-split';

/**
 * Latest Monaco caret/selection for the active SQL editor.
 * Menu-driven ⌘⏎ reads this so Run works the same whether the chord
 * came from Monaco or the native menu.
 */
let caret: EditorCaret | null = null;

export function setEditorCaret(next: EditorCaret | null): void {
  caret = next;
}

export function getEditorCaret(): EditorCaret | null {
  return caret;
}
