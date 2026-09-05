import { setEditorCaret } from '@/lib/editor-run-context';
import type { OnChange, OnMount } from '@monaco-editor/react';
import { binding, monacoKeybinding } from '@shared/keymap';
import type * as MonacoType from 'monaco-editor';
import { Suspense, lazy, useCallback, useEffect, useRef } from 'react';
import { PLASMA_THEME_ID, applyMonacoTheme } from './paperTheme';
import { registerSqlCompletions } from './sqlCompletions';

// Lazy-load Monaco to keep the initial renderer bundle small. The
// ~3MB editor only loads the first time the drawer is expanded.
const Editor = lazy(() => import('@monaco-editor/react').then((m) => ({ default: m.default })));

const RUNNING_DECORATION = 'plasma-sql-running';
const ERROR_MARKER_OWNER = 'plasma-sql-error';

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** ⌘⏎ — selection else statement-at-cursor (resolved in session via caret). */
  onRun: () => void;
  /** ⌘⇧⏎ — whole buffer. */
  onRunAll: () => void;
  onToggle: () => void;
  theme: 'light' | 'dark';
  fontSize: number;
  readOnly?: boolean;
  onFormat?: () => void;
  onAskAi?: (selection: string) => void;
  /** Buffer offsets of the statement currently executing. */
  runningRange?: { start: number; end: number } | null;
  /** Buffer offsets of the statement that last failed. */
  errorRange?: { start: number; end: number } | null;
  errorMessage?: string | null;
}

/**
 * Monaco wrapper — registers the Plasma themes on first mount,
 * wires keymap chords (run / run-all / toggle / format / ask-AI),
 * publishes caret state for menu-driven Run, and paints running /
 * error decorations for U24.
 */
export function MonacoEditor({
  value,
  onChange,
  onRun,
  onRunAll,
  onToggle,
  theme,
  fontSize,
  readOnly = false,
  onFormat,
  onAskAi,
  runningRange = null,
  errorRange = null,
  errorMessage = null,
}: Props) {
  const monacoRef = useRef<typeof MonacoType | null>(null);
  const editorRef = useRef<MonacoType.editor.IStandaloneCodeEditor | null>(null);
  const decorationIdsRef = useRef<string[]>([]);
  // Keep latest callbacks in refs so the addCommand bindings (registered
  // once at mount) always see the current closure without re-binding.
  const onRunRef = useRef(onRun);
  const onRunAllRef = useRef(onRunAll);
  const onToggleRef = useRef(onToggle);
  const onFormatRef = useRef(onFormat);
  const onAskAiRef = useRef(onAskAi);
  useEffect(() => {
    onRunRef.current = onRun;
    onRunAllRef.current = onRunAll;
    onToggleRef.current = onToggle;
    onFormatRef.current = onFormat;
    onAskAiRef.current = onAskAi;
  }, [onRun, onRunAll, onToggle, onFormat, onAskAi]);

  const publishCaret = useCallback((editor: MonacoType.editor.IStandaloneCodeEditor) => {
    const model = editor.getModel();
    if (!model) {
      setEditorCaret(null);
      return;
    }
    const sel = editor.getSelection();
    const pos = editor.getPosition();
    if (!sel || !pos) {
      setEditorCaret(null);
      return;
    }
    setEditorCaret({
      cursorOffset: model.getOffsetAt(pos),
      selectionStart: model.getOffsetAt(sel.getStartPosition()),
      selectionEnd: model.getOffsetAt(sel.getEndPosition()),
    });
  }, []);

  const handleMount = useCallback<OnMount>(
    (editor, monaco) => {
      monacoRef.current = monaco;
      editorRef.current = editor;
      applyMonacoTheme(monaco, theme);
      registerSqlCompletions(monaco);

      // Chords from `@shared/keymap` so U24 registers through the same module.
      editor.addCommand(monacoKeybinding(monaco, binding('runQuery').chord), () => {
        publishCaret(editor);
        onRunRef.current();
      });
      editor.addCommand(monacoKeybinding(monaco, binding('runQueryAll').chord), () => {
        publishCaret(editor);
        onRunAllRef.current();
      });
      editor.addCommand(monacoKeybinding(monaco, binding('toggleEditor').chord), () => {
        onToggleRef.current();
      });
      editor.addCommand(monacoKeybinding(monaco, binding('formatSql').chord), () => {
        onFormatRef.current?.();
      });
      editor.addCommand(monacoKeybinding(monaco, binding('askAi').chord), () => {
        const sel = editor.getSelection();
        const text =
          sel && !sel.isEmpty()
            ? (editor.getModel()?.getValueInRange(sel) ?? '')
            : editor.getValue();
        onAskAiRef.current?.(text);
      });
      // Esc — close drawer when focused (not in KEYMAP: editor-local only)
      editor.addCommand(monaco.KeyCode.Escape, () => {
        onToggleRef.current();
      });

      publishCaret(editor);
      const disposables = [
        editor.onDidChangeCursorPosition(() => publishCaret(editor)),
        editor.onDidChangeCursorSelection(() => publishCaret(editor)),
      ];
      editor.onDidDispose(() => {
        for (const d of disposables) d.dispose();
        if (editorRef.current === editor) {
          editorRef.current = null;
          setEditorCaret(null);
        }
      });
    },
    [theme, publishCaret],
  );

  // Re-apply Monaco theme whenever the app theme or palette changes.
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

  // Running-statement decoration (U24).
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    const model = editor.getModel();
    if (!model) return;

    if (!runningRange || runningRange.end <= runningRange.start) {
      decorationIdsRef.current = editor.deltaDecorations(decorationIdsRef.current, []);
      return;
    }

    const start = model.getPositionAt(
      Math.max(0, Math.min(runningRange.start, model.getValueLength())),
    );
    const end = model.getPositionAt(
      Math.max(0, Math.min(runningRange.end, model.getValueLength())),
    );
    decorationIdsRef.current = editor.deltaDecorations(decorationIdsRef.current, [
      {
        range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
        options: {
          className: RUNNING_DECORATION,
          isWholeLine: false,
          overviewRuler: {
            color: 'rgba(235, 94, 78, 0.55)',
            position: monaco.editor.OverviewRulerLane.Center,
          },
          minimap: {
            color: 'rgba(235, 94, 78, 0.55)',
            position: monaco.editor.MinimapPosition.Inline,
          },
        },
      },
    ]);
  }, [runningRange]);

  // Error marker on the offending range (U24).
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    const model = editor.getModel();
    if (!model) return;

    if (!errorRange || errorRange.end <= errorRange.start) {
      monaco.editor.setModelMarkers(model, ERROR_MARKER_OWNER, []);
      return;
    }

    const start = model.getPositionAt(
      Math.max(0, Math.min(errorRange.start, model.getValueLength())),
    );
    const end = model.getPositionAt(Math.max(0, Math.min(errorRange.end, model.getValueLength())));
    monaco.editor.setModelMarkers(model, ERROR_MARKER_OWNER, [
      {
        severity: monaco.MarkerSeverity.Error,
        message: errorMessage?.trim() || 'Query failed',
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: end.column,
      },
    ]);
  }, [errorRange, errorMessage]);

  // Inject a lightweight style for the running decoration once.
  useEffect(() => {
    const id = 'plasma-monaco-u24-styles';
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = `
      .monaco-editor .${RUNNING_DECORATION} {
        background-color: rgba(235, 94, 78, 0.12);
      }
    `;
    document.head.appendChild(style);
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
