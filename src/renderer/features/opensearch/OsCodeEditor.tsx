import { PLASMA_THEME_ID, registerMonacoThemes } from '@/features/editor/paperTheme';
import { cn } from '@/lib/cn';
import { useSession } from '@/stores/session';
import type { OnMount } from '@monaco-editor/react';
import type * as MonacoType from 'monaco-editor';
import { Suspense, lazy, useEffect, useRef } from 'react';

const Editor = lazy(() => import('@monaco-editor/react').then((m) => ({ default: m.default })));

export interface CaretInfo {
  line: number;
  column: number;
  offset: number;
}

export function caretText(c: CaretInfo): string {
  return `line ${c.line}, column ${c.column}, location ${c.offset}`;
}

/** Query DSL keywords offered next to mapping field names (O21). */
const DSL_KEYWORDS = [
  'query',
  'bool',
  'must',
  'must_not',
  'should',
  'filter',
  'match',
  'match_all',
  'match_phrase',
  'multi_match',
  'term',
  'terms',
  'range',
  'exists',
  'prefix',
  'wildcard',
  'query_string',
  'simple_query_string',
  'nested',
  'aggs',
  'terms',
  'date_histogram',
  'histogram',
  'avg',
  'sum',
  'min',
  'max',
  'cardinality',
  'size',
  'from',
  'sort',
  'order',
  '_source',
  'track_total_hits',
  'search_after',
  'highlight',
  'gte',
  'lte',
  'gt',
  'lt',
];

const SQL_KEYWORDS = [
  'SELECT',
  'FROM',
  'WHERE',
  'GROUP BY',
  'ORDER BY',
  'LIMIT',
  'OFFSET',
  'HAVING',
  'AND',
  'OR',
  'NOT',
  'LIKE',
  'IN',
  'BETWEEN',
  'IS NULL',
  'IS NOT NULL',
  'COUNT',
  'AVG',
  'SUM',
  'MIN',
  'MAX',
  'DISTINCT',
  'AS',
  'SHOW TABLES LIKE',
  'DESCRIBE TABLES LIKE',
  'MATCH',
  'MATCH_PHRASE',
  'QUERY',
];

/**
 * Monaco editor for DSL (JSON) and SQL (O21): syntax highlighting,
 * bracket matching, JSON validation, Tab indentation, completion of
 * mapping field names, and ⌘⏎ bound inside the editor only (O8).
 * Monaco loads lazily; a plain textarea stands in until it does.
 */
export function OsCodeEditor({
  value,
  onChange,
  language,
  ariaLabel,
  onRun,
  onCaret,
  fields = [],
  className,
  readOnly = false,
}: {
  value: string;
  onChange: (v: string) => void;
  language: 'json' | 'sql';
  ariaLabel: string;
  onRun?: () => void;
  onCaret?: (c: CaretInfo) => void;
  /** Field names offered by completion (mapping paths or SQL tables/columns). */
  fields?: string[];
  className?: string;
  readOnly?: boolean;
}) {
  const fontSize = useSession((s) => s.settings.editorFontSize);
  const runRef = useRef(onRun);
  runRef.current = onRun;
  const caretRef = useRef(onCaret);
  caretRef.current = onCaret;
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const disposers = useRef<Array<{ dispose(): void }>>([]);

  useEffect(
    () => () => {
      for (const d of disposers.current) d.dispose();
      disposers.current = [];
    },
    [],
  );

  const handleMount: OnMount = (editor, monacoAny) => {
    const monaco = monacoAny as typeof MonacoType;
    registerMonacoThemes(monaco);
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runRef.current?.());
    disposers.current.push(
      editor.onDidChangeCursorPosition(() => {
        const model = editor.getModel();
        const pos = editor.getPosition();
        if (!model || !pos) return;
        caretRef.current?.({
          line: pos.lineNumber,
          column: pos.column,
          offset: model.getOffsetAt(pos),
        });
      }),
    );
    const ownModel = editor.getModel();
    disposers.current.push(
      monaco.languages.registerCompletionItemProvider(language, {
        triggerCharacters: language === 'json' ? ['"'] : [' ', '.'],
        provideCompletionItems(model, position) {
          if (model !== ownModel) return { suggestions: [] };
          const word = model.getWordUntilPosition(position);
          const range = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn,
          };
          const kw = language === 'json' ? DSL_KEYWORDS : SQL_KEYWORDS;
          const seen = new Set<string>();
          const suggestions: MonacoType.languages.CompletionItem[] = [];
          for (const f of fieldsRef.current) {
            if (seen.has(f)) continue;
            seen.add(f);
            suggestions.push({
              label: f,
              kind: monaco.languages.CompletionItemKind.Field,
              insertText: f,
              detail: 'field',
              range,
            });
          }
          for (const k of kw) {
            if (seen.has(k)) continue;
            seen.add(k);
            suggestions.push({
              label: k,
              kind: monaco.languages.CompletionItemKind.Keyword,
              insertText: k,
              range,
            });
          }
          return { suggestions };
        },
      }),
    );
  };

  return (
    <div className={cn('min-h-0 min-w-0 overflow-hidden bg-[var(--wb-content)]', className)}>
      <Suspense
        fallback={
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                runRef.current?.();
              }
            }}
            aria-label={ariaLabel}
            spellCheck={false}
            wrap="off"
            readOnly={readOnly}
            className="h-full w-full resize-none whitespace-pre bg-transparent px-3 py-2 font-mono text-[13px] leading-5 text-[var(--wb-text)] outline-none"
          />
        }
      >
        <div className="h-full w-full">
          <Editor
            language={language}
            value={value}
            onChange={(v) => onChange(v ?? '')}
            onMount={handleMount}
            theme={PLASMA_THEME_ID}
            options={{
              fontFamily: 'JetBrains Mono, ui-monospace, SFMono-Regular, monospace',
              fontSize,
              lineNumbers: 'on',
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              wordWrap: 'off',
              tabSize: 2,
              automaticLayout: true,
              readOnly,
              renderLineHighlight: 'none',
              padding: { top: 6, bottom: 6 },
              ariaLabel,
              fixedOverflowWidgets: true,
            }}
          />
        </div>
      </Suspense>
    </div>
  );
}

/**
 * Vertical drag handle between an editor and the results (O21: the
 * editor split is resizable). Calls `onResize` with the new height.
 */
export function SplitHandle({
  height,
  onResize,
  min = 80,
  max = 800,
}: {
  height: number;
  onResize: (h: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize editor"
      aria-valuenow={height}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp') onResize(Math.max(min, height - 20));
        if (e.key === 'ArrowDown') onResize(Math.min(max, height + 20));
      }}
      onPointerDown={(e) => {
        e.preventDefault();
        const startY = e.clientY;
        const start = height;
        const move = (ev: PointerEvent) =>
          onResize(Math.min(max, Math.max(min, start + ev.clientY - startY)));
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }}
      className="h-1 shrink-0 cursor-row-resize bg-transparent hover:bg-[var(--wb-separator)] focus-visible:bg-[var(--wb-accent)] focus-visible:outline-none"
    />
  );
}
