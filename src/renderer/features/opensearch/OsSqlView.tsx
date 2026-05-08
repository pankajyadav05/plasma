import { Button } from '@/components/ui/button';
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import type { OsSqlResult } from '@shared/protocol';
import { Loader2, Play } from 'lucide-react';
import { useEffect, useState } from 'react';

const DEFAULT_SQL = 'SELECT * FROM <index> LIMIT 50';

/**
 * OpenSearch SQL plugin canvas — relational-style query editor over the
 * `_plugins/_sql` endpoint (or `_sql` on Elasticsearch). Reuses the
 * grid shape Plasma uses for Postgres queries so users get a familiar
 * tabular result, but the full backing API is OpenSearch SQL: limited
 * JOINs, no transactions, but real aggregates and JSON access via `.`.
 *
 * ⌘⏎ runs from anywhere in the canvas.
 */
export function OsSqlView({ tabId }: { tabId: string }) {
  const tabs = useSession((s) => s.tabs);
  const tab = tabs.find((t) => t.id === tabId);
  const [sql, setSql] = useState(tab?.osSql ?? DEFAULT_SQL);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OsSqlResult | null>(null);

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

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void onRun();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
    // biome-ignore lint/correctness/useExhaustiveDependencies: onRun is stable per render via closure.
  }, [sql]);

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
        <span className="font-mono text-sm font-semibold">OpenSearch SQL</span>
        <span className="font-display text-[11px] italic text-muted-foreground">
          /_plugins/_sql · ⌘⏎ to run
        </span>
        <div className="flex-1" />
        {result && (
          <span className="font-display text-[11px] italic text-muted-foreground">
            {result.rows.length.toLocaleString()} rows · {result.durationMs}ms
          </span>
        )}
        <Button variant="primary" size="sm" onClick={() => void onRun()} disabled={running}>
          {running ? <Loader2 className="animate-spin" /> : <Play className="fill-current" />}
          Run
        </Button>
      </div>

      <div className="grid min-h-0 flex-1 grid-rows-[280px_1fr]">
        <div className="flex min-h-0 flex-col border-b border-border">
          <textarea
            value={sql}
            onChange={(e) => persist(e.target.value)}
            spellCheck={false}
            className="min-h-0 flex-1 resize-none bg-background p-3 font-mono text-xs leading-5 outline-none focus:ring-0"
            placeholder={DEFAULT_SQL}
          />
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {error && (
            <div className="m-3 rounded-md border-l-4 border-destructive bg-muted px-4 py-2 text-sm text-foreground">
              {error}
            </div>
          )}
          {!error && !result && !running && (
            <div className="px-4 py-3 font-display text-sm italic text-muted-foreground">
              press Run to execute
            </div>
          )}
          {!error && result && <SqlResultTable result={result} />}
        </div>
      </div>
    </main>
  );
}

function SqlResultTable({ result }: { result: OsSqlResult }) {
  if (result.columns.length === 0) {
    return (
      <div className="px-4 py-3 font-display text-sm italic text-muted-foreground">
        no columns returned
      </div>
    );
  }
  return (
    <table className="w-full font-mono text-xs">
      <thead className="sticky top-0 z-10 bg-muted/80 text-[10px] uppercase tracking-wider text-muted-foreground backdrop-blur">
        <tr>
          {result.columns.map((c) => (
            <th
              key={c.name}
              className="border-b border-border px-3 py-1.5 text-left"
              title={c.type}
            >
              {c.name}
              <span className="ml-1 text-[9px] text-muted-foreground/70">{c.type}</span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {result.rows.map((row, i) => (
          <tr
            key={`row-${i}-${String(row[0] ?? '')}`}
            className="border-b border-border/50 hover:bg-muted/30"
          >
            {row.map((cell, j) => (
              <td
                key={result.columns[j]?.name ?? `col-${j}`}
                className="break-all px-3 py-1 align-top text-foreground"
              >
                {renderCell(cell)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function renderCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}
