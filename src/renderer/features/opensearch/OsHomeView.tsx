import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import type { OsAlias, OsIlmPolicy } from '@shared/protocol';
import { Boxes, ChevronDown, ChevronRight, Layers } from 'lucide-react';
import { useEffect, useState } from 'react';

function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

/**
 * Empty-state for OpenSearch — cluster summary + a punch-list of the
 * largest indices. Acts as the "where do I start" surface for users
 * coming straight off a fresh connect.
 */
export function OsHomeView() {
  const overview = useSession((s) => s.osOverview);
  const openIndex = useSession((s) => s.openOsIndex);
  const openSearch = useSession((s) => s.openOsSearch);

  const top = overview
    ? [...overview.indices].sort((a, b) => b.docsCount - a.docsCount).slice(0, 8)
    : [];

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-background">
      <div className="mx-auto w-full max-w-4xl px-8 py-12">
        <div className="mb-8 flex items-start justify-between gap-6">
          <div>
            <p className="font-display text-sm uppercase tracking-[0.25em] text-muted-foreground">
              {overview?.distribution ?? 'OpenSearch'}
            </p>
            <h1 className="mt-2 font-display text-4xl italic">
              {overview?.clusterName ?? 'connecting…'}
            </h1>
            {overview && (
              <p className="mt-1 font-mono text-xs text-muted-foreground">
                v{overview.version} · {overview.nodes} node(s) · {overview.indices.length} indices
              </p>
            )}
          </div>
          {overview && (
            <span className="shrink-0 rounded-md border border-border px-3 py-1 font-mono text-xs uppercase text-muted-foreground">
              {overview.health}
            </span>
          )}
        </div>

        {top.length > 0 && (
          <section className="mb-8">
            <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Largest indices
            </h2>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {top.map((idx) => (
                <div
                  key={idx.index}
                  className="group flex items-stretch rounded-md border border-border bg-muted/30 transition-colors hover:border-foreground/40"
                >
                  <button
                    type="button"
                    onClick={() => openIndex(idx.index)}
                    className="flex min-w-0 flex-1 cursor-pointer flex-col items-start gap-1 p-3 text-left"
                  >
                    <div className="flex w-full items-center gap-2">
                      <Boxes className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="truncate font-mono text-xs font-semibold">{idx.index}</span>
                    </div>
                    <div className="font-display text-[11px] italic text-muted-foreground">
                      {idx.docsCount.toLocaleString()} docs · {fmtBytes(idx.storeBytes)} ·{' '}
                      {idx.primaries}p / {idx.replicas}r
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => openSearch(idx.index)}
                    className="cursor-pointer border-l border-border px-3 font-display text-[11px] italic text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    Search →
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <AliasesPanel />
          <IlmPanel />
        </div>
      </div>
    </main>
  );
}

function AliasesPanel() {
  const [aliases, setAliases] = useState<OsAlias[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await ipc.os.aliases();
        if (!cancelled) setAliases(list);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section>
      <h2 className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        <Layers className="h-3.5 w-3.5" />
        Aliases
      </h2>
      {error && (
        <p className="mt-2 font-display text-[11px] italic text-muted-foreground">
          {error}
        </p>
      )}
      {!error && aliases === null && (
        <p className="mt-2 font-display text-[11px] italic text-muted-foreground">
          loading…
        </p>
      )}
      {!error && aliases && aliases.length === 0 && (
        <p className="mt-2 font-display text-[11px] italic text-muted-foreground">
          no aliases declared
        </p>
      )}
      {!error && aliases && aliases.length > 0 && (
        <div className="mt-2 overflow-auto rounded-md border border-border">
          <table className="w-full font-mono text-xs">
            <thead className="bg-muted/60 text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="border-b border-border px-3 py-1.5 text-left">alias</th>
                <th className="border-b border-border px-3 py-1.5 text-left">index</th>
                <th className="border-b border-border px-3 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {aliases.map((a) => (
                <tr
                  key={`${a.alias}-${a.index}`}
                  className="border-b border-border/50 last:border-b-0 hover:bg-muted/30"
                >
                  <td className="break-all px-3 py-1 align-top text-foreground">{a.alias}</td>
                  <td className="break-all px-3 py-1 align-top text-muted-foreground">
                    {a.index}
                  </td>
                  <td className="px-3 py-1 text-right align-top">
                    {a.isWriteIndex && (
                      <span className="rounded-sm border border-border px-1 py-0 font-mono text-[9px] uppercase text-muted-foreground">
                        write
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function IlmPanel() {
  const [policies, setPolicies] = useState<OsIlmPolicy[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openName, setOpenName] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await ipc.os.ilm();
        if (!cancelled) setPolicies(list);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section>
      <h2 className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Lifecycle policies
      </h2>
      {error && (
        <p className="mt-2 font-display text-[11px] italic text-muted-foreground">
          {error}
        </p>
      )}
      {!error && policies === null && (
        <p className="mt-2 font-display text-[11px] italic text-muted-foreground">
          loading…
        </p>
      )}
      {!error && policies && policies.length === 0 && (
        <p className="mt-2 font-display text-[11px] italic text-muted-foreground">
          no ISM / ILM policies installed
        </p>
      )}
      {!error && policies && policies.length > 0 && (
        <ul className="mt-2 space-y-1">
          {policies.map((p) => {
            const isOpen = openName === p.name;
            return (
              <li
                key={p.name}
                className="overflow-hidden rounded-md border border-border bg-muted/20"
              >
                <button
                  type="button"
                  onClick={() => setOpenName(isOpen ? null : p.name)}
                  className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left font-mono text-xs"
                >
                  {isOpen ? (
                    <ChevronDown className="h-3 w-3 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-3 w-3 text-muted-foreground" />
                  )}
                  <span className="flex-1 truncate text-foreground">{p.name}</span>
                  {p.lastUpdated && (
                    <span className="font-display text-[10px] italic text-muted-foreground">
                      {new Date(p.lastUpdated).toLocaleDateString()}
                    </span>
                  )}
                </button>
                {isOpen && (
                  <pre className="border-t border-border/40 bg-background p-3 font-mono text-[11px] leading-5">
                    {JSON.stringify(p.policy, null, 2)}
                  </pre>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
