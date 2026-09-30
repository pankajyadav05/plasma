import { runCommand } from '@/features/keymap/commands';
import { statementPosition } from '@/lib/sql-split';
import type { EditorCursor, TabCaret } from '@/stores/workbench';
import type { OnChange, OnMount } from '@monaco-editor/react';
import {
  EDITOR_PASSTHROUGH,
  type KeyId,
  binding,
  matchGlobalBinding,
  monacoKeybinding,
} from '@shared/keymap';
import type * as MonacoType from 'monaco-editor';
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { PLASMA_THEME_ID, applyMonacoTheme } from './paperTheme';
import { registerSqlCompletions } from './sqlCompletions';

// Lazy-load Monaco to keep the initial renderer bundle small. The
// ~3MB editor only loads the first time the drawer is expanded.
const Editor = lazy(() => import('@monaco-editor/react').then((m) => ({ default: m.default })));

const RUNNING_DECORATION = 'plasma-sql-running';
const CURRENT_STMT_DECORATION = 'plasma-sql-current';
const ERROR_MARKER_OWNER = 'plasma-sql-error';

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** ⌘⏎ — selection else statement-at-cursor (resolved in session via caret). */
  onRun: () => void;
  /** ⌘⇧⏎ — whole buffer. */
  onRunAll: () => void;
  /** @deprecated ⌘J is dispatched globally now; kept for callers. */
  onToggle?: () => void;
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
  /** Caret line/column + selection size, for the editor action bar. */
  onCursorChange?: (cursor: EditorCursor | null) => void;
  /** Caret offsets for run commands — stored per tab by the caller. */
  onCaret?: (caret: TabCaret) => void;
  /**
   * Model identity. Each distinct path gets its own Monaco model, so a
   * tab keeps its cursor, scroll position and undo history when you
   * switch away and back.
   */
  path?: string;
  /** Tint the statement "Run Current" would execute (multi-statement buffers). */
  highlightCurrentStatement?: boolean;
  wordWrap?: boolean;
  /** Changing this focuses the editor (history / new tab / ⌘J). */
  focusNonce?: number;
  /** Hide the overview ruler in the scrollbar (narrow panes, VF27). */
  hideOverviewRuler?: boolean;
}

/** Editor-scoped chords dispatched through the shared command table. */
const EDITOR_COMMANDS: KeyId[] = ['fontBigger', 'fontSmaller', 'fontReset', 'wordWrap'];

/** The user's mono font (`--font-mono`), resolved for Monaco's measurer. */
function monoFontFamily(): string {
  if (typeof document === 'undefined') return 'monospace';
  const v = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim();
  return v || '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
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
  theme,
  fontSize,
  readOnly = false,
  onFormat,
  onAskAi,
  runningRange = null,
  errorRange = null,
  errorMessage = null,
  onCursorChange,
  onCaret,
  path,
  highlightCurrentStatement = false,
  wordWrap = true,
  focusNonce,
  hideOverviewRuler = false,
}: Props) {
  const monacoRef = useRef<typeof MonacoType | null>(null);
  const editorRef = useRef<MonacoType.editor.IStandaloneCodeEditor | null>(null);
  const decorationIdsRef = useRef<string[]>([]);
  // Keep latest callbacks in refs so the addCommand bindings (registered
  // once at mount) always see the current closure without re-binding.
  const onRunRef = useRef(onRun);
  const onRunAllRef = useRef(onRunAll);
  const onFormatRef = useRef(onFormat);
  const onAskAiRef = useRef(onAskAi);
  const onCursorChangeRef = useRef(onCursorChange);
  onCursorChangeRef.current = onCursorChange;
  const onCaretRef = useRef(onCaret);
  onCaretRef.current = onCaret;
  const highlightRef = useRef(highlightCurrentStatement);
  highlightRef.current = highlightCurrentStatement;
  // Owned by Monaco (replace-in-place), so re-entrant cursor/content
  // events can never leak a stale tint the way manual id tracking did.
  const currentStmtRef = useRef<MonacoType.editor.IEditorDecorationsCollection | null>(null);
  useEffect(() => {
    onRunRef.current = onRun;
    onRunAllRef.current = onRunAll;
    onFormatRef.current = onFormat;
    onAskAiRef.current = onAskAi;
  }, [onRun, onRunAll, onFormat, onAskAi]);

  const publishCaret = useCallback((editor: MonacoType.editor.IStandaloneCodeEditor) => {
    const model = editor.getModel();
    const sel = editor.getSelection();
    const pos = editor.getPosition();
    if (!model || !sel || !pos) {
      onCursorChangeRef.current?.(null);
      return;
    }
    const offset = model.getOffsetAt(pos);
    const selectionLength = model.getValueLengthInRange(sel);
    onCursorChangeRef.current?.({
      line: pos.lineNumber,
      column: pos.column,
      offset,
      selectionLength,
    });
    onCaretRef.current?.({
      cursorOffset: offset,
      selectionStart: model.getOffsetAt(sel.getStartPosition()),
      selectionEnd: model.getOffsetAt(sel.getEndPosition()),
      bufferLength: model.getValueLength(),
    });

    // Current-statement tint: whole lines of the statement at the caret,
    // only when there is more than one statement and no selection.
    const monaco = monacoRef.current;
    if (!monaco) return;
    const where =
      highlightRef.current && selectionLength === 0
        ? statementPosition(model.getValue(), offset)
        : null;
    currentStmtRef.current ??= editor.createDecorationsCollection();
    if (!where || where.total < 2) {
      currentStmtRef.current.clear();
      return;
    }
    const start = model.getPositionAt(where.statement.start);
    const end = model.getPositionAt(where.statement.end);
    currentStmtRef.current.set([
      {
        range: new monaco.Range(start.lineNumber, 1, end.lineNumber, 1),
        options: {
          isWholeLine: true,
          className: CURRENT_STMT_DECORATION,
          linesDecorationsClassName: `${CURRENT_STMT_DECORATION}-bar`,
        },
      },
    ]);
  }, []);

  const handleMount = useCallback<OnMount>(
    (editor, monaco) => {
      monacoRef.current = monaco;
      editorRef.current = editor;
      applyMonacoTheme(monaco, theme);
      registerSqlCompletions(monaco);

      // VF21: a run closes the suggest widget so it can't linger over results.
      const hideWidgets = () => editor.trigger('plasma', 'hideSuggestWidget', {});

      // Chords from `@shared/keymap` so U24 registers through the same module.
      editor.addCommand(monacoKeybinding(monaco, binding('runQuery').chord), () => {
        hideWidgets();
        publishCaret(editor);
        onRunRef.current();
      });
      editor.addCommand(monacoKeybinding(monaco, binding('runQueryAll').chord), () => {
        hideWidgets();
        publishCaret(editor);
        onRunAllRef.current();
      });
      const format = binding('formatSql');
      for (const chord of [format.chord, ...(format.altChords ?? [])]) {
        editor.addCommand(monacoKeybinding(monaco, chord), () => {
          onFormatRef.current?.();
        });
      }
      for (const id of EDITOR_COMMANDS) {
        editor.addCommand(monacoKeybinding(monaco, binding(id).chord), () => {
          runCommand(id);
        });
      }
      editor.addCommand(monacoKeybinding(monaco, binding('askAi').chord), () => {
        const sel = editor.getSelection();
        const text =
          sel && !sel.isEmpty()
            ? (editor.getModel()?.getValueInRange(sel) ?? '')
            : editor.getValue();
        onAskAiRef.current?.(text);
      });
      // No Esc binding: Esc stays Monaco's (close suggest / find / hints,
      // collapse multi-cursor) — E2 / K2.

      // K2 / VF22: global chords Monaco would swallow (⌘K is its chord
      // prefix; ⌘J / ⌘B / ⌘W … would otherwise do nothing while typing)
      // run the app command. Stopping propagation keeps Monaco's keybinding
      // service (on the container) from also handling them.
      const keyDisposable = editor.onKeyDown((e) => {
        const hit = matchGlobalBinding(e.browserEvent);
        if (!hit || !EDITOR_PASSTHROUGH.has(hit.id)) return;
        if (runCommand(hit.id)) {
          e.preventDefault();
          e.stopPropagation();
        }
      });

      publishCaret(editor);
      const disposables = [
        editor.onDidChangeCursorPosition(() => publishCaret(editor)),
        editor.onDidChangeCursorSelection(() => publishCaret(editor)),
        // Tab switch swaps the model (per-tab `path`); the restored
        // cursor must be re-published for the new tab.
        editor.onDidChangeModel(() => publishCaret(editor)),
        editor.onDidChangeModelContent(() => publishCaret(editor)),
        keyDisposable,
      ];
      editor.onDidDispose(() => {
        for (const d of disposables) d.dispose();
        if (editorRef.current === editor) editorRef.current = null;
      });
    },
    [theme, publishCaret],
  );

  useEffect(() => {
    if (focusNonce === undefined || focusNonce === 0) return;
    editorRef.current?.focus();
  }, [focusNonce]);

  // Track the user's mono font (Settings → font) — Monaco needs a
  // concrete family string and a re-measure when it changes.
  const [fontFamily, setFontFamily] = useState(monoFontFamily);
  useEffect(() => {
    const update = () => {
      setFontFamily(monoFontFamily());
      monacoRef.current?.editor.remeasureFonts();
    };
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
    return () => mo.disconnect();
  }, []);

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
    const id = 'plasma-monaco-u24-styles-v3';
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = `
      .monaco-editor .${RUNNING_DECORATION} {
        background-color: color-mix(in oklch, var(--wb-accent) 14%, transparent);
      }
      .monaco-editor .${CURRENT_STMT_DECORATION} {
        background-color: color-mix(in oklch, var(--wb-accent) 6%, transparent);
      }
      .monaco-editor .${CURRENT_STMT_DECORATION}-bar {
        background-color: var(--wb-accent);
        width: 2px !important;
        margin-left: 3px;
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
        path={path}
        defaultValue={value}
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
          fontFamily,
          fontSize,
          // TablePlus: 13px text on a 20px line; scale the line with the
          // user's font-size setting so larger sizes keep the same rhythm.
          lineHeight: Math.round((fontSize * 20) / 13),
          fontLigatures: false,
          minimap: { enabled: false },
          ...(hideOverviewRuler
            ? { overviewRulerLanes: 0, overviewRulerBorder: false, hideCursorInOverviewRuler: true }
            : {}),
          scrollBeyondLastLine: false,
          lineNumbers: 'on',
          glyphMargin: false,
          folding: false,
          renderLineHighlight: 'line',
          wordWrap: wordWrap ? 'on' : 'off',
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
          contextmenu: true,
          // VF21: keep suggest / hover widgets inside the editor instead
          // of floating over the result grid and the right sidebar.
          fixedOverflowWidgets: false,
        }}
      />
    </Suspense>
  );
}
