import type { OnChange, OnMount } from '@monaco-editor/react';
import type * as MonacoType from 'monaco-editor';
import { Suspense, lazy, useCallback, useEffect, useRef } from 'react';
import { PLASMA_THEME_ID, applyMonacoTheme } from './paperTheme';
import { registerSqlCompletions } from './sqlCompletions';

// Lazy-load Monaco to keep the initial renderer bundle small. The
// ~3MB editor only loads the first time the drawer is expanded.
const Editor = lazy(() => import('@monaco-editor/react').then((m) => ({ default: m.default })));

interface Props {
  value: string;
  onChange: (value: string) => void;
  onRun: () => void;
  onToggle: () => void;
  theme: 'light' | 'dark';
  fontSize: number;
  readOnly?: boolean;
  onFormat?: () => void;
  onAskAi?: (selection: string) => void;
  /** ⌘↑ / Ctrl+↑ when the buffer is empty — recall previous history statement. */
  onRecallPrevious?: () => void;
}

/**
 * Monaco wrapper — registers the Plasma themes on first mount,
 * wires ⌘⏎ / ⌘J / ⌘↑ (empty-buffer history recall) shortcuts, and applies the Paper Editor type
 * scale (JetBrains Mono at configurable size).
 */
export function MonacoEditor({
  value,
  onChange,
  onRun,
  onToggle,
  theme,
  fontSize,
  readOnly = false,
  onFormat,
  onAskAi,
  onRecallPrevious,
}: Props) {
  const monacoRef = useRef<typeof MonacoType | null>(null);
  // Keep latest callbacks in refs so the addCommand bindings (registered
  // once at mount) always see the current closure without re-binding.
  const onRunRef = useRef(onRun);
  const onToggleRef = useRef(onToggle);
  const onFormatRef = useRef(onFormat);
  const onAskAiRef = useRef(onAskAi);
  const onRecallPreviousRef = useRef(onRecallPrevious);
  useEffect(() => {
    onRunRef.current = onRun;
    onToggleRef.current = onToggle;
    onFormatRef.current = onFormat;
    onAskAiRef.current = onAskAi;
    onRecallPreviousRef.current = onRecallPrevious;
  }, [onRun, onToggle, onFormat, onAskAi, onRecallPrevious]);

  const handleMount = useCallback<OnMount>(
    (editor, monaco) => {
      monacoRef.current = monaco;
      applyMonacoTheme(monaco, theme);
      registerSqlCompletions(monaco);

      // ⌘⏎ / Ctrl+Enter — run query
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
        onRunRef.current();
      });
      // ⌘J / Ctrl+J — toggle drawer
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyJ, () => {
        onToggleRef.current();
      });
      // ⌘⇧F / Ctrl+Shift+F — format SQL
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF, () => {
        onFormatRef.current?.();
      });
      // ⌘I / Ctrl+I — ask AI about the current selection (or whole doc)
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI, () => {
        const sel = editor.getSelection();
        const text =
          sel && !sel.isEmpty()
            ? (editor.getModel()?.getValueInRange(sel) ?? '')
            : editor.getValue();
        onAskAiRef.current?.(text);
      });
      // Esc — close drawer when focused
      editor.addCommand(monaco.KeyCode.Escape, () => {
        onToggleRef.current();
      });

      // ⌘↑ / Ctrl+↑ — when the buffer is empty, recall the previous
      // statement from history (psql muscle memory). Only intercept when
      // empty so the default "go to top" binding still works otherwise.
      editor.onKeyDown((e) => {
        const mod = e.metaKey || e.ctrlKey;
        if (!mod || e.keyCode !== monaco.KeyCode.UpArrow) return;
        if (editor.getValue().trim().length > 0) return;
        e.preventDefault();
        e.stopPropagation();
        onRecallPreviousRef.current?.();
      });
    },
    [theme],
  );

  // Re-apply Monaco theme whenever the app theme or palette changes.
  // `theme` prop covers light/dark flips; the window event covers palette
  // swaps (themeName) without a prop plumbing round-trip.
  useEffect(() => {
    const monaco = monacoRef.current;
    if (monaco) applyMonacoTheme(monaco, theme);
  }, [theme]);

  useEffect(() => {
    const onChanged = () => {
      const monaco = monacoRef.current;
      if (!monaco) return;
      const mode = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
      applyMonacoTheme(monaco, mode);
    };
    window.addEventListener('plasma:theme-changed', onChanged);
    return () => window.removeEventListener('plasma:theme-changed', onChanged);
  }, []);

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
        theme={PLASMA_THEME_ID}
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
