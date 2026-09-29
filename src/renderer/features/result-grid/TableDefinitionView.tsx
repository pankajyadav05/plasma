import { cleanIpcError } from '@/lib/errors';
import { Pill } from '@/components/ui/workbench';
import { PLASMA_THEME_ID, applyMonacoTheme } from '@/features/editor/paperTheme';
import { ipc } from '@/lib/ipc';
import { buildTableDdlSql, composeTableDdl } from '@/lib/table-ddl';
import { useActiveTab, useSession } from '@/stores/session';
import type { OnMount } from '@monaco-editor/react';
import { Copy, Loader2 } from 'lucide-react';
import type * as MonacoType from 'monaco-editor';
import { Suspense, lazy, useEffect, useState } from 'react';

const Editor = lazy(() => import('@monaco-editor/react').then((m) => ({ default: m.default })));

/**
 * Read-only DDL view for a table tab. Issues a single multi-result-set
 * query against pg_catalog and composes a CREATE TABLE + ALTER TABLE
 * + CREATE INDEX block from the result. Falls back to a friendly
 * placeholder if the query fails (e.g. role lacks SELECT on pg_catalog).
 */
export function TableDefinitionView() {
  const tab = useActiveTab();
  const setSql = useSession((s) => s.setSql);
  const setEditorExpanded = useSession((s) => s.setEditorExpanded);
  const addTab = useSession((s) => s.addTab);
  const fontSize = useSession((s) => s.settings.editorFontSize);
  const theme = useSession((s) => s.settings.theme);
  const [ddl, setDdl] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!tab || tab.kind !== 'table' || !tab.tableSchema || !tab.tableName) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        // PF10: views/matviews via pg_get_viewdef; tables with identity,
        // constraints, indexes, triggers, comments, RLS and owner.
        const { sql, params } = buildTableDdlSql(tab.tableSchema!, tab.tableName!);
        const res = await ipc.query.sideband(sql, params, { timeoutMs: 15_000 });
        if (cancelled) return;
        setDdl(composeTableDdl(tab.tableSchema!, tab.tableName!, res.rows));
      } catch (err) {
        if (!cancelled) {
          setError(cleanIpcError(err instanceof Error ? err.message : String(err)));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab?.tableSchema, tab?.tableName, tab?.kind]);

  const handleMount: OnMount = (_editor, monaco) => {
    applyMonacoTheme(monaco as typeof MonacoType, theme);
  };

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(ddl);
    } catch {
      /* clipboard unavailable */
    }
  };

  const onOpenInEditor = () => {
    addTab();
    setSql(ddl);
    setEditorExpanded(true);
  };

  if (!tab || tab.kind !== 'table') return null;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-[var(--wb-content)]">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--wb-separator)] bg-[var(--wb-content)] px-3">
        <span className="text-[13px] text-[var(--wb-text-2)]">SQL Definition of</span>
        <span className="font-mono text-[13px] text-[var(--wb-text)]">
          {tab.tableSchema}.{tab.tableName}
        </span>
        <span className="rounded-[4px] bg-[var(--wb-control)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--wb-text-2)]">
          read-only
        </span>
        <div className="flex-1" />
        <Pill onClick={onCopy} title="Copy DDL to clipboard">
          <Copy />
          Copy
        </Pill>
        <Pill onClick={onOpenInEditor} title="Open in a new SQL editor tab">
          Open in SQL Editor
        </Pill>
      </div>

      {loading && (
        <div className="flex flex-1 items-center justify-center text-[var(--wb-text-2)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="ml-2 text-[13px]">building definition…</span>
        </div>
      )}

      {!loading && error && (
        <div className="p-6">
          <div className="mb-2 text-[15px] font-semibold text-destructive">
            could not build definition
          </div>
          <pre className="whitespace-pre-wrap break-words font-mono text-[12px] text-[var(--wb-text-2)]">
            {error}
          </pre>
        </div>
      )}

      {!loading && !error && (
        <Suspense
          fallback={
            <div className="flex flex-1 items-center justify-center text-[var(--wb-text-2)]">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          }
        >
          <div className="min-h-0 flex-1">
            <Editor
              language="sql"
              value={ddl}
              theme={PLASMA_THEME_ID}
              onMount={handleMount}
              options={{
                readOnly: true,
                domReadOnly: true,
                fontFamily: 'JetBrains Mono, ui-monospace, SFMono-Regular, monospace',
                fontSize,
                lineNumbers: 'on',
                folding: false,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                renderLineHighlight: 'none',
                wordWrap: 'on',
                guides: { indentation: false },
                scrollbar: {
                  verticalScrollbarSize: 10,
                  horizontalScrollbarSize: 10,
                },
              }}
            />
          </div>
        </Suspense>
      )}
    </div>
  );
}
