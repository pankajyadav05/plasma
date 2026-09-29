import { type DataColumn, DataTable } from '@/components/ui/data-table';
import { EmptyState, ViewFooter } from '@/components/ui/view-parts';
import { Pill, Segmented } from '@/components/ui/workbench';
import { ipc } from '@/lib/ipc';
import { kbd } from '@/lib/platform';
import { useSession } from '@/stores/session';
import { useWorkbench } from '@/stores/workbench';
import { isReadOnlyOsSql } from '@shared/os-write-policy';
import { ListTree, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { type CaretInfo, OsCodeEditor, SplitHandle, caretText } from './OsCodeEditor';
import { displayValue, formatMs } from './os-format';
import {
  EditorBar,
  JsonBody,
  QueryErrorPanel,
  QueryLibraryMenu,
  RunPill,
  RunningState,
  TimeoutMenu,
  clearInspected,
  errMessage,
  isRunShortcut,
} from './os-parts';
import { type OsSqlTabState, defaultSqlState, newOsId, useOsStore, useSqlTab } from './os-store';
import { confirmOsWrite, useOsWriteAccess } from './os-write';

/** Rows kept in memory across "Load more" pages (the grid isn't virtualised). */
const MAX_SQL_ROWS = 10_000;

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
 * OpenSearch SQL plugin canvas — Monaco SQL editor over `_plugins/_sql`
 * (or `_sql` on Elasticsearch). Editor → editor bar (caret, history,
 * timeout, Explain, Run/Cancel) → result grid → footer (Data | JSON,
 * timing, rows, Load more through the SQL cursor).
 *
 * Non-SELECT statements are writes: blocked unless edit mode is on and
 * the connection isn't read-only, and confirmed (S1).
 */
export function OsSqlView({ tabId }: { tabId: string }) {
  return <OsSqlViewInner key={tabId} tabId={tabId} />;
}

function OsSqlViewInner({ tabId }: { tabId: string }) {
  const tab = useSession((s) => s.tabs.find((t) => t.id === tabId));
  const indices = useSession((s) => s.osOverview?.indices);
  const st = useSqlTab(tabId);
  const patch = useCallback(
    (p: Partial<OsSqlTabState>) => useOsStore.getState().patchSql(tabId, p),
    [tabId],
  );
  const getSt = useCallback(() => useOsStore.getState().sql[tabId] ?? defaultSqlState(), [tabId]);
  const addHistory = useOsStore((s) => s.addHistory);
  const access = useOsWriteAccess();
  const [sql, setSql] = useState(tab?.osSql ?? 'SHOW TABLES LIKE %');
  const [caret, setCaret] = useState<CaretInfo | null>(null);
  const [height, setHeight] = useState(240);
  const [loadingMore, setLoadingMore] = useState(false);

  const persist = (next: string) => {
    setSql(next);
    useSession.setState((state) => ({
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, osSql: next } : t)),
    }));
  };

  const onRun = async () => {
    const text = sql.trim();
    if (!text || getSt().running) return;
    if (!isReadOnlyOsSql(text)) {
      if (!access.canWrite) {
        patch({ error: `${access.reason} — only SELECT, SHOW, DESCRIBE and EXPLAIN can run.` });
        return;
      }
      const ok = await confirmOsWrite({
        title: 'Run a write statement?',
        description: 'This SQL statement is not a read and may change or delete data.',
        confirmLabel: 'Run statement',
        destructive: /^\s*(delete|drop|truncate)\b/i.test(text),
      });
      if (!ok) return;
    }
    const requestId = newOsId('sql');
    patch({ running: true, requestId, error: null, selected: null, explain: null });
    clearInspected(tabId);
    try {
      const r = await ipc.os.sql(text, {
        fetchSize: getSt().fetchSize,
        timeoutMs: getSt().timeoutMs,
        requestId,
      });
      if (getSt().requestId !== requestId) return;
      patch({ running: false, requestId: null, result: r, mode: 'data' });
      addHistory({ kind: 'sql', text, ok: true });
    } catch (err) {
      if (getSt().requestId !== requestId) return;
      const msg = errMessage(err);
      patch({
        running: false,
        requestId: null,
        error: /request cancelled/i.test(msg) ? 'Request cancelled' : msg,
        result: null,
      });
      addHistory({ kind: 'sql', text, ok: false });
    }
  };

  const onExplain = async () => {
    const text = sql.trim();
    if (!text || getSt().running) return;
    const requestId = newOsId('sql');
    patch({ running: true, requestId, error: null });
    try {
      const res = await ipc.os.request({
        method: 'POST',
        path: '/_plugins/_sql/_explain',
        body: JSON.stringify({ query: text }),
        timeoutMs: getSt().timeoutMs,
        requestId,
      });
      if (getSt().requestId !== requestId) return;
      if (res.status >= 400) {
        patch({ running: false, requestId: null, error: JSON.stringify(res.body, null, 2) });
        return;
      }
      patch({ running: false, requestId: null, explain: res.body, mode: 'json' });
    } catch (err) {
      if (getSt().requestId !== requestId) return;
      patch({ running: false, requestId: null, error: errMessage(err) });
    }
  };

  const loadMore = async () => {
    const cur = getSt();
    const cursor = cur.result?.cursor;
    if (!cursor || !cur.result || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await ipc.os.sql('', { cursor, timeoutMs: cur.timeoutMs });
      const latest = getSt().result;
      if (!latest || latest.cursor !== cursor) return;
      const rows = [...latest.rows, ...next.rows].slice(0, MAX_SQL_ROWS);
      patch({
        result: {
          ...latest,
          rows,
          cursor: rows.length >= MAX_SQL_ROWS ? null : (next.cursor ?? null),
          durationMs: latest.durationMs + next.durationMs,
        },
      });
    } catch (err) {
      patch({ error: errMessage(err) });
    } finally {
      setLoadingMore(false);
    }
  };

  const cancel = () => {
    const id = getSt().requestId;
    if (id) void ipc.os.cancel(id).catch(() => undefined);
  };

  // The Details sidebar must not keep showing a row from this tab once it's gone.
  useEffect(() => () => clearInspected(tabId), [tabId]);

  const result = st.result;
  const columns = useMemo<DataColumn<unknown[]>[]>(
    () =>
      (result?.columns ?? []).map((c, j) => ({
        key: `${j}:${c.name}`,
        label: c.name,
        title: `${c.name} — ${c.type}`,
        align: NUMERIC_TYPES.has(c.type.toLowerCase()) ? 'right' : 'left',
        render: (row) => displayValue(row[j], c.type.toLowerCase()),
        titleOf: (row) => displayValue(row[j], c.type.toLowerCase()) ?? undefined,
      })),
    [result],
  );

  const completions = useMemo(() => {
    const names = (indices ?? []).filter((i) => !i.index.startsWith('.')).map((i) => i.index);
    return [...names, ...(result?.columns.map((c) => c.name) ?? [])];
  }, [indices, result]);

  const onSelectRow = (row: unknown[], index: number) => {
    if (!result) return;
    patch({ selected: index });
    useWorkbench.getState().setInspectedRow({
      tabId,
      rowNumber: index + 1,
      columnIndex: 0,
      columns: result.columns.map((c) => ({ name: c.name, dataTypeID: 0, dataTypeName: c.type })),
      row,
    });
  };

  const rowCount = result?.rows.length ?? 0;

  return (
    <main
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--wb-content)]"
      onKeyDown={(e) => {
        if (isRunShortcut(e)) {
          e.preventDefault();
          void onRun();
        }
      }}
    >
      <div className="shrink-0" style={{ height }}>
        <OsCodeEditor
          value={sql}
          onChange={persist}
          onCaret={setCaret}
          onRun={() => void onRun()}
          language="sql"
          ariaLabel="OpenSearch SQL"
          fields={completions}
          className="h-full"
        />
      </div>
      <SplitHandle height={height} onResize={setHeight} />

      <EditorBar
        hint={caret ? caretText(caret) : '/_plugins/_sql · OpenSearch SQL plugin'}
        right={
          <>
            <QueryLibraryMenu
              kinds={['sql']}
              current={{ kind: 'sql', text: sql }}
              onPick={(e) => persist(e.text)}
            />
            <TimeoutMenu value={st.timeoutMs} onChange={(ms) => patch({ timeoutMs: ms })} />
            <Pill
              onClick={() => void onExplain()}
              disabled={st.running || !sql.trim()}
              title="Show the query plan (_plugins/_sql/_explain)"
            >
              <ListTree />
              Explain
            </Pill>
            <RunPill
              running={st.running}
              disabled={!sql.trim()}
              onRun={() => void onRun()}
              onCancel={cancel}
            />
          </>
        }
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col border-t border-[var(--wb-separator)]">
        {st.error ? (
          <QueryErrorPanel message={st.error} />
        ) : st.running && !result && !st.explain ? (
          <RunningState label="Running query…" />
        ) : st.explain != null && st.mode === 'json' && !result ? (
          <JsonBody value={st.explain} />
        ) : !result ? (
          <EmptyState title="No results" hint={`Write a query and press Run (${kbd('⏎')}).`} />
        ) : st.mode === 'json' ? (
          <JsonBody
            value={
              st.explain ?? { columns: result.columns, rows: result.rows, total: result.total }
            }
          />
        ) : result.columns.length === 0 ? (
          <EmptyState title="No columns returned" />
        ) : (
          <DataTable
            ariaLabel="SQL results"
            columns={columns}
            rows={result.rows}
            rowKey={(_row, i) => String(i)}
            selectedIndex={st.selected}
            onSelect={onSelectRow}
            empty="No rows"
          />
        )}
      </div>

      {(result !== null || st.explain != null) && !st.error && (
        <ViewFooter className="min-w-0 overflow-hidden whitespace-nowrap">
          <Segmented
            variant="track"
            ariaLabel="Result view"
            value={st.mode}
            onChange={(m) => patch({ mode: m })}
            options={[
              { value: 'data', label: 'Data', disabled: !result },
              { value: 'json', label: st.explain ? 'Plan' : 'JSON' },
            ]}
          />
          {result && <span className="shrink-0 tabular-nums">{formatMs(result.durationMs)}</span>}
          <div className="flex min-w-0 flex-1 items-center justify-center gap-2 tabular-nums">
            {result && (
              <span className="truncate">
                {rowCount === 1 ? '1 row' : `${rowCount.toLocaleString()} rows`}
                {result.total > rowCount && ` of ${result.total.toLocaleString()}`}
              </span>
            )}
            {result?.cursor && (
              <Pill onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore && <Loader2 className="animate-spin" />}
                Load more
              </Pill>
            )}
          </div>
          {result && (
            <span className="shrink-0 tabular-nums">
              {result.columns.length.toLocaleString()}{' '}
              {result.columns.length === 1 ? 'column' : 'columns'}
            </span>
          )}
        </ViewFooter>
      )}
    </main>
  );
}
