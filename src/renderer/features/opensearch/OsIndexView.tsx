import { Button } from '@/components/ui/button';
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import type { OsIndex, OsMappingNode } from '@shared/protocol';
import { ChevronDown, ChevronRight, Loader2, RefreshCw, Search } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

/**
 * Mapping + stats view for one OpenSearch index. The mapping is fetched
 * lazily; the cluster summary is read from the cached overview to keep
 * the canvas snappy.
 */
export function OsIndexView({ indexName }: { indexName: string }) {
  const overview = useSession((s) => s.osOverview);
  const openSearch = useSession((s) => s.openOsSearch);

  const [mapping, setMapping] = useState<OsMappingNode | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stats: OsIndex | undefined = overview?.indices.find((i) => i.index === indexName);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const root = await ipc.os.mapping(indexName);
      setMapping(root);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [indexName]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-mono text-sm">{indexName}</h1>
          {stats && (
            <p className="mt-0.5 font-display text-[11px] italic text-muted-foreground">
              {stats.docsCount.toLocaleString()} docs · {fmtBytes(stats.storeBytes)} ·{' '}
              {stats.primaries}p / {stats.replicas}r · {stats.health}
            </p>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          Refresh
        </Button>
        <Button variant="primary" size="sm" onClick={() => openSearch(indexName)}>
          <Search />
          Search
        </Button>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {error && (
          <div className="mb-3 rounded-md border-l-4 border-destructive bg-muted px-4 py-2 text-sm text-foreground">
            {error}
          </div>
        )}

        <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Mapping
        </h2>
        {loading && !mapping && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> loading…
          </div>
        )}
        {mapping && mapping.children.length === 0 && (
          <div className="font-display text-sm italic text-muted-foreground">
            no fields declared (dynamic mapping)
          </div>
        )}
        {mapping && mapping.children.length > 0 && (
          <ul className="rounded-md border border-border bg-muted/20">
            {mapping.children.map((child) => (
              <FieldRow key={child.name} node={child} depth={0} />
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

function FieldRow({ node, depth }: { node: OsMappingNode; depth: number }) {
  const [open, setOpen] = useState(depth < 1);
  const hasChildren = node.children.length > 0;
  return (
    <li className="border-b border-border/40 last:border-b-0">
      <button
        type="button"
        onClick={() => hasChildren && setOpen((v) => !v)}
        className={
          hasChildren
            ? 'flex w-full cursor-pointer items-center gap-1.5 px-3 py-1.5 text-left font-mono text-xs hover:bg-muted/30'
            : 'flex w-full items-center gap-1.5 px-3 py-1.5 text-left font-mono text-xs'
        }
        style={{ paddingLeft: 12 + depth * 14 }}
      >
        {hasChildren ? (
          open ? (
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
          )
        ) : (
          <span className="inline-block w-3" />
        )}
        <span className="truncate text-foreground">{node.name}</span>
        {node.type && (
          <span className="ml-auto shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            {node.type}
          </span>
        )}
      </button>
      {open && hasChildren && (
        <ul>
          {node.children.map((c) => (
            <FieldRow key={c.name} node={c} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}
