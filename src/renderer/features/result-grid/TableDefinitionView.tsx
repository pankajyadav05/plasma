import { Button } from '@/components/ui/button';
import { PLASMA_THEME_ID, applyMonacoTheme } from '@/features/editor/paperTheme';
import { ipc } from '@/lib/ipc';
import { buildDefinitionQuerySql } from '@/lib/table-query';
import { useActiveTab, useSession } from '@/stores/session';
import type { OnMount } from '@monaco-editor/react';
import { Copy, Loader2 } from 'lucide-react';
import type * as MonacoType from 'monaco-editor';
import { Suspense, lazy, useEffect, useMemo, useState } from 'react';

const Editor = lazy(() => import('@monaco-editor/react').then((m) => ({ default: m.default })));

interface DefRow {
  kind: 'col' | 'con' | 'idx';
  c1: string; // name (col) / conname / indexname
  c2: string; // type (col) / constraintdef / indexdef
  c3: string; // NOT NULL (col only)
  c4: string; // default expr (col only)
}

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
  const schema = useSession((s) => s.schema);
  const [ddl, setDdl] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const schemaIndexes = useMemo(() => {
    if (!tab || tab.kind !== 'table' || !tab.tableSchema || !tab.tableName || !schema) {
      return [];
    }
    return (schema.indexes ?? []).filter(
      (i) => i.schema === tab.tableSchema && i.table === tab.tableName,
    );
  }, [schema, tab?.kind, tab?.tableSchema, tab?.tableName]);

  useEffect(() => {
    if (!tab || tab.kind !== 'table' || !tab.tableSchema || !tab.tableName) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const { sql, params } = buildDefinitionQuerySql(tab.tableSchema!, tab.tableName!);
        const res = await ipc.query.run(sql, params, { internal: true });
        if (cancelled) return;
        const rows: DefRow[] = res.rows.map((r) => ({
          kind: String(r[0]) as DefRow['kind'],
          c1: String(r[2] ?? ''),
          c2: String(r[3] ?? ''),
          c3: String(r[4] ?? ''),
          c4: String(r[5] ?? ''),
        }));
        const fromQuery = composeDdl(tab.tableSchema!, tab.tableName!, rows);
        setDdl(
          appendSchemaIndexes(
            fromQuery,
            tab.tableSchema!,
            tab.tableName!,
            (schema?.indexes ?? []).filter(
              (i) => i.schema === tab.tableSchema && i.table === tab.tableName,
            ),
            rows,
          ),
        );
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab?.tableSchema, tab?.tableName, tab?.kind, schema]);

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
    <div className="relative flex min-h-0 flex-1 flex-col bg-card">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
        <span className="font-display text-sm italic text-muted-foreground">SQL Definition of</span>
        <span className="font-mono text-sm text-foreground">
          {tab.tableSchema}.{tab.tableName}
        </span>
        <span className="rounded-sm border border-border px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
          read-only
        </span>
        <div className="flex-1" />
        <Button variant="ghost" size="xs" onClick={onCopy} title="Copy DDL to clipboard">
          <Copy />
          Copy
        </Button>
        <Button
          variant="outline"
          size="xs"
          onClick={onOpenInEditor}
          title="Open in a new SQL editor tab"
        >
          Open in SQL Editor
        </Button>
      </div>

      {loading && (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="ml-2 font-display text-sm italic">building definition…</span>
        </div>
      )}

      {!loading && error && (
        <div className="p-6">
          <div className="mb-2 font-display text-lg italic text-destructive">
            could not build definition
          </div>
          <pre className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
            {error}
          </pre>
        </div>
      )}

      {!loading && !error && schemaIndexes.length > 0 && (
        <div className="shrink-0 border-b border-border bg-background px-3 py-2">
          <div className="mb-1 font-display text-[10px] italic uppercase tracking-wider text-muted-foreground">
            Indexes · {schemaIndexes.length}
          </div>
          <ul className="flex flex-col gap-0.5">
            {schemaIndexes.map((idx) => (
              <li
                key={idx.name}
                className="flex items-baseline gap-2 font-mono text-[11px] text-foreground"
                title={idx.definition}
              >
                <span className="truncate font-medium">{idx.name}</span>
                <span className="shrink-0 text-[9px] uppercase text-muted-foreground">
                  {idx.isPrimary ? 'pk' : idx.isUnique ? 'unique' : 'index'}
                </span>
                {idx.columns.length > 0 && (
                  <span className="truncate text-muted-foreground">
                    ({idx.columns.join(', ')})
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!loading && !error && (
        <Suspense
          fallback={
            <div className="flex flex-1 items-center justify-center text-muted-foreground">
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

function quoteIdent(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

function composeDdl(schema: string, table: string, rows: DefRow[]): string {
  const cols = rows.filter((r) => r.kind === 'col');
  const cons = rows.filter((r) => r.kind === 'con');
  const idxs = rows.filter((r) => r.kind === 'idx');
  const ident = `${quoteIdent(schema)}.${quoteIdent(table)}`;

  const colLines = cols.map((c) => {
    const parts = [`  ${quoteIdent(c.c1)} ${c.c2}`];
    if (c.c3) parts.push(c.c3); // NOT NULL
    if (c.c4) parts.push(`DEFAULT ${c.c4}`);
    return parts.join(' ');
  });

  const head = `CREATE TABLE ${ident} (\n${colLines.join(',\n')}\n);\n`;

  const consLines = cons
    .map((c) => `ALTER TABLE ${ident}\n  ADD CONSTRAINT ${quoteIdent(c.c1)} ${c.c2};`)
    .join('\n\n');

  // pg_indexes returns the full CREATE INDEX statement already; we just
  // skip ones that match a constraint's auto-created index (Postgres
  // returns them as both — keep the constraint version).
  const consNames = new Set(cons.map((c) => c.c1));
  const idxLines = idxs
    .filter((i) => !consNames.has(i.c1))
    .map((i) => `${i.c2};`)
    .join('\n\n');

  return [head, consLines, idxLines].filter(Boolean).join('\n\n');
}

/**
 * If the live DDL query already emitted CREATE INDEX lines, leave them.
 * Otherwise append any introspected indexes that are not constraint-backed
 * duplicates already covered by ALTER TABLE … ADD CONSTRAINT.
 */
function appendSchemaIndexes(
  ddl: string,
  _schema: string,
  _table: string,
  indexes: Array<{
    name: string;
    definition: string;
    isPrimary: boolean;
    isUnique: boolean;
  }>,
  rows: DefRow[],
): string {
  if (indexes.length === 0) return ddl;
  const consNames = new Set(rows.filter((r) => r.kind === 'con').map((r) => r.c1));
  const idxFromQuery = new Set(rows.filter((r) => r.kind === 'idx').map((r) => r.c1));
  const missing = indexes.filter(
    (i) => !i.isPrimary && !consNames.has(i.name) && !idxFromQuery.has(i.name),
  );
  if (missing.length === 0) return ddl;
  const extra = missing.map((i) => `${i.definition};`).join('\n\n');
  return `${ddl}\n\n${extra}`;
}
