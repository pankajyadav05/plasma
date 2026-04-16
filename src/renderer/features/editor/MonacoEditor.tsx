import { lazy, Suspense, useCallback } from 'react';
import type { OnMount, OnChange } from '@monaco-editor/react';
import { DARK_THEME_ID, LIGHT_THEME_ID, registerMonacoThemes } from './paperTheme';
import { registerSqlCompletions } from './sqlCompletions';

// Lazy-load Monaco to keep the initial renderer bundle small. The
// ~3MB editor only loads the first time the drawer is expanded.
const Editor = lazy(() =>
  import('@monaco-editor/react').then((m) => ({ default: m.default })),
);

interface Props {
  value: string;
  onChange: (value: string) => void;
  onRun: () => void;
  onToggle: () => void;
  theme: 'light' | 'dark';
  fontSize: number;
  readOnly?: boolean;
}

/**
 * Monaco wrapper — registers the Plasma themes on first mount,
 * wires ⌘⏎ and ⌘J shortcuts, and applies the Paper Editor type
 * scale (JetBrains Mono at configurable size).
 */
export function MonacoEditor({ value, onChange, onRun, onToggle, theme, fontSize, readOnly = false }: Props) {
  const handleMount = useCallback<OnMount>(
    (editor, monaco) => {
      registerMonacoThemes(monaco);
      registerSqlCompletions(monaco);
      monaco.editor.setTheme(theme === 'dark' ? DARK_THEME_ID : LIGHT_THEME_ID);

      // ⌘⏎ / Ctrl+Enter — run query
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
        onRun();
      });
      // ⌘J / Ctrl+J — toggle drawer
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyJ, () => {
        onToggle();
      });
      // Esc — close drawer when focused
      editor.addCommand(monaco.KeyCode.Escape, () => {
        onToggle();
      });
    },
    [onRun, onToggle, theme],
  );

  const handleChange = useCallback<OnChange>(
    (v) => {
      onChange(v ?? '');
    },
    [onChange],
  );

  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          Loading editor…
        </div>
      }
    >
      <Editor
        language="sql"
        value={value}
        onChange={handleChange}
        onMount={handleMount}
        theme={theme === 'dark' ? DARK_THEME_ID : LIGHT_THEME_ID}
        loading={
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Loading editor…
          </div>
        }
        options={{
          fontFamily: '"JetBrains Mono", ui-monospace, monospace',
          fontSize,
          lineHeight: 1.6,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          lineNumbers: 'on',
          glyphMargin: false,
          folding: false,
          renderLineHighlight: 'line',
          wordWrap: 'on',
          padding: { top: 16, bottom: 16 },
          scrollbar: {
            vertical: 'auto',
            horizontal: 'auto',
            verticalScrollbarSize: 12,
            horizontalScrollbarSize: 12,
          },
          automaticLayout: true,
          cursorStyle: 'line',
          cursorBlinking: 'smooth',
          smoothScrolling: true,
          tabSize: 2,
          insertSpaces: true,
          readOnly,
          domReadOnly: readOnly,
          contextmenu: false,
          fixedOverflowWidgets: true,
        }}
      />
    </Suspense>
  );
}
