import type * as MonacoType from 'monaco-editor';

/**
 * The SQL editor that last had focus, so the Snippets panel can insert a
 * snippet (with live tab stops) into it after the click moved focus away.
 */
let last: MonacoType.editor.IStandaloneCodeEditor | null = null;

export function rememberEditor(editor: MonacoType.editor.IStandaloneCodeEditor | null): void {
  last = editor;
}

export function forgetEditor(editor: MonacoType.editor.IStandaloneCodeEditor): void {
  if (last === editor) last = null;
}

/** Insert `body` as a snippet at the caret of the last focused editor. False when there is none. */
export function insertSnippetIntoEditor(body: string): boolean {
  const editor = last;
  const node = editor?.getDomNode();
  if (!editor || !node || !node.isConnected || editor.getRawOptions().readOnly) return false;
  editor.focus();
  const controller = editor.getContribution('snippetController2') as {
    insert(template: string): void;
  } | null;
  if (!controller) return false;
  controller.insert(body);
  return true;
}
