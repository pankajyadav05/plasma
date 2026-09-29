import { type DataColumn, DataTable } from '@/components/ui/data-table';
import { EmptyState, ViewFooter } from '@/components/ui/view-parts';
import { Pill, Segmented } from '@/components/ui/workbench';
import { cn } from '@/lib/cn';
import { cleanIpcError } from '@/lib/errors';
import { ipc } from '@/lib/ipc';
import { kbd } from '@/lib/platform';
import { useSession } from '@/stores/session';
import { useWorkbench } from '@/stores/workbench';
import type { OsSqlResult } from '@shared/protocol';
import { AlertCircle, Loader2, Play, SlidersHorizontal } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

const DEFAULT_SQL = 'SELECT * FROM <index> LIMIT 50';

type ResultMode = 'data' | 'json';

/** OpenSearch SQL column types that read as numbers (right-aligned, like Postgres). */
const NUMERIC_TYPES = new Set([
  'byte',
  'short',
  'integer',
  'long',
  'float',
  'half_float',
  'scaled_float',
  'double',
  'unsigned_long',
]);

/**
 * OpenSearch SQL plugin canvas — relational-style query editor over the
 * `_plugins/_sql` endpoint (or `_sql` on Elasticsearch). Laid out like
 * the Postgres SQL tab: editor → editor footer (caret info, neutral Run
 * pill) → result grid → results footer (Data | JSON, timing, row count).
 *
 * ⌘⏎ runs from anywhere in the canvas.
 */
export function OsSqlView({ tabId }: { tabId: string }) {
  // Keyed so switching between two SQL tabs never leaks editor/result state.
  return <OsSqlViewInner key={tabId} tabId={tabId} />;
}

function OsSqlViewInner({ tabId }: { tabId: string }) {
  const tabs = useSession((s) => s.tabs);
  const tab = tabs.find((t) => t.id === tabId);
  const [sql, setSql] = useState(tab?.osSql ?? DEFAULT_SQL);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OsSqlResult | null>(null);
  const [caret, setCaret] = useState<CaretInfo | null>(null);
  const [mode, setMode] = useState<ResultMode>('data');
  const [selected, setSelected] = useState<number | null>(null);

  const persist = (next: string) => {
    setSql(next);
    useSession.setState((state) => ({
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, osSql: next } : t)),
    }));
  };

  const onRun = async () => {
    if (!sql.trim()) return;
    setRunning(true);
    setError(null);
    setSelected(null);
    clearInspected(tabId);
    try {
      const r = await ipc.os.sql(sql.trim());
      setResult(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setResult(null);
    } finally {
      setRunning(false);
    }
  };

  // ⌘⏎ from anywhere; the ref always points at the latest closure.
  const runRef = useRef(onRun);
  runRef.current = onRun;
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void runRef.current();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // The Details sidebar must not keep showing a row from this tab once it's gone.
  useEffect(() => () => clearInspected(tabId), [tabId]);

  const columns = useMemo<DataColumn<unknown[]>[]>(
    () =>
      (result?.columns ?? []).map((c, j) => ({
        key: `${j}:${c.name}`,
        label: c.name,
        title: `${c.name} — ${c.type}`,
        align: NUMERIC_TYPES.has(c.type.toLowerCase()) ? 'right' : 'left',
        render: (row) => cellText(row[j]),
        titleOf: (row) => cellText(row[j]) ?? undefined,
      })),
    [result],
  );

  const onSelectRow = (row: unknown[], index: number) => {
    if (!result) return;
    setSelected(index);
    useWorkbench.getState().setInspectedRow({
      tabId,
      rowNumber: index + 1,
      columnIndex: 0,
      columns: result.columns.map((c) => ({
        name: c.name,
        dataTypeID: 0,
        dataTypeName: c.type,
      })),
      row,
    });
  };

  const rowCount = result?.rows.length ?? 0;

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--wb-content)]">
      <CodeArea
        value={sql}
        onChange={persist}
        onCaret={setCaret}
        placeholder={DEFAULT_SQL}
        ariaLabel="OpenSearch SQL"
        className="h-[280px] shrink-0"
      />

      <EditorBar
        hint={caret ? caretText(caret) : '/_plugins/_sql · OpenSearch SQL plugin'}
        right={<RunPill running={running} disabled={!sql.trim()} onRun={() => void onRun()} />}
      />

      <div className="flex min-h-0 flex-1 flex-col border-t border-[var(--wb-separator)]">
        {error ? (
          <QueryErrorPanel message={error} />
        ) : running && !result ? (
          <RunningState label="Running query…" />
        ) : !result ? (
          <EmptyState title="No results" hint={`Write a query and press Run (${kbd('⏎')}).`} />
        ) : result.columns.length === 0 ? (
          <EmptyState title="No columns returned" />
        ) : mode === 'json' ? (
          <JsonBody value={{ columns: result.columns, rows: result.rows, total: result.total }} />
        ) : (
          <DataTable
            ariaLabel="SQL results"
            columns={columns}
            rows={result.rows}
            rowKey={(_row, i) => String(i)}
            selectedIndex={selected}
            onSelect={onSelectRow}
            empty="No rows"
          />
        )}
      </div>

      {result && !error && (
        <ViewFooter>
          <Segmented
            variant="track"
            ariaLabel="Result view"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'data', label: 'Data' },
              { value: 'json', label: 'JSON' },
            ]}
          />
          <span className="tabular-nums">{formatMs(result.durationMs)}</span>
          <div className="flex flex-1 justify-center tabular-nums">
            {rowCount === 1 ? '1 row' : `${rowCount.toLocaleString()} rows`}
            {result.total > rowCount && ` of ${result.total.toLocaleString()}`}
          </div>
          <span className="tabular-nums">
            {result.columns.length.toLocaleString()}{' '}
            {result.columns.length === 1 ? 'column' : 'columns'}
          </span>
        </ViewFooter>
      )}
    </main>
  );
}

// ───────────── Shared pieces (also used by OsSearchView) ─────────────

export interface CaretInfo {
  line: number;
  column: number;
  offset: number;
}

export function caretText(c: CaretInfo): string {
  return `line ${c.line}, column ${c.column}, location ${c.offset}`;
}

function caretOf(el: HTMLTextAreaElement): CaretInfo {
  const offset = el.selectionStart ?? 0;
  const before = el.value.slice(0, offset);
  const lines = before.split('\n');
  return { line: lines.length, column: (lines[lines.length - 1]?.length ?? 0) + 1, offset };
}

/**
 * Plain-textarea code editor with a line-number gutter, dressed like the
 * Postgres editor (JetBrains Mono 13/20, --wb-content, --wb-text-3 numbers).
 */
export function CodeArea({
  value,
  onChange,
  onCaret,
  placeholder,
  ariaLabel,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  onCaret?: (c: CaretInfo) => void;
  placeholder?: string;
  ariaLabel: string;
  className?: string;
}) {
  const gutterRef = useRef<HTMLDivElement>(null);
  const lineCount = Math.max(1, value.split('\n').length);
  const report = (el: HTMLTextAreaElement) => onCaret?.(caretOf(el));

  return (
    <div className={cn('flex min-h-0 bg-[var(--wb-content)]', className)}>
      <div
        ref={gutterRef}
        aria-hidden
        className="w-11 shrink-0 select-none overflow-hidden py-2 pr-2 text-right font-mono text-[13px] leading-5 tabular-nums text-[var(--wb-text-3)]"
      >
        {Array.from({ length: lineCount }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: line numbers are positional
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <textarea
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          report(e.target);
        }}
        onSelect={(e) => report(e.currentTarget)}
        onScroll={(e) => {
          if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop;
        }}
        spellCheck={false}
        wrap="off"
        aria-label={ariaLabel}
        placeholder={placeholder}
        className="min-h-0 min-w-0 flex-1 resize-none whitespace-pre bg-transparent py-2 pl-1 pr-3 font-mono text-[13px] leading-5 text-[var(--wb-text)] outline-none placeholder:text-[var(--wb-text-3)]"
      />
    </div>
  );
}

/** 36px editor footer: sliders glyph + mono hint left, pills right (Postgres editor bar). */
export function EditorBar({ hint, right }: { hint: React.ReactNode; right: React.ReactNode }) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-1.5 border-t border-[var(--wb-separator)] bg-[var(--wb-content)] px-2.5">
      <SlidersHorizontal
        className="h-4 w-4 shrink-0 text-[var(--wb-text-2)]"
        strokeWidth={1.5}
        aria-hidden
      />
      <span className="min-w-0 truncate font-mono text-[12px] tabular-nums text-[var(--wb-text-2)]">
        {hint}
      </span>
      <div className="flex-1" />
      {right}
    </div>
  );
}

/** Neutral `Run ⌘↵` pill — never coloured (TablePlus). */
export function RunPill({
  running,
  disabled,
  onRun,
}: {
  running: boolean;
  disabled?: boolean;
  onRun: () => void;
}) {
  return (
    <Pill
      onClick={onRun}
      disabled={running || disabled}
      title={`Run (${kbd('⏎')})`}
      aria-label="Run"
    >
      {running ? <Loader2 className="animate-spin" /> : <Play className="fill-current" />}
      {running ? 'Running' : 'Run'}
      <span className="font-mono text-[12px] opacity-70">{kbd('⏎')}</span>
    </Pill>
  );
}

/** Destructive "Query failed" panel, identical to the Postgres result grid's. */
export function QueryErrorPanel({ message }: { message: string }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-[var(--wb-content)]">
      <div className="max-w-4xl p-5">
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-[8px] bg-destructive/10 px-3.5 py-3 ring-1 ring-inset ring-destructive/30"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div className="min-w-0">
            <div className="mb-1 text-xs font-semibold text-destructive">Query failed</div>
            <pre className="whitespace-pre-wrap break-words font-mono text-[13px] text-[var(--wb-text)]">
              {cleanIpcError(message)}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}

export function RunningState({ label }: { label: string }) {
  return (
    <EmptyState
      title={
        <span className="inline-flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          {label}
        </span>
      }
    />
  );
}

/** Raw JSON body for the footer's "JSON" view. */
export function JsonBody({ value }: { value: unknown }) {
  const text = useMemo(() => JSON.stringify(value, null, 2), [value]);
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-[var(--wb-content)]">
      <pre className="p-3 font-mono text-[12px] leading-5 text-[var(--wb-text)]">{text}</pre>
    </div>
  );
}

export function clearInspected(tabId: string) {
  const wb = useWorkbench.getState();
  if (wb.inspectedRow?.tabId === tabId) wb.setInspectedRow(null);
}

export function formatMs(ms: number): string {
  return `${Math.round(ms).toLocaleString()} ms`;
}

/** Grid text for a cell; `null` renders as the dim NULL word. */
export function cellText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}
