import { Button } from '@/components/ui/button';
import { ipc } from '@/lib/ipc';
import type { RedisSlowlogEntry } from '@shared/protocol';
import { Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

/**
 * SLOWLOG GET viewer — table of recent slow commands. Sorted by Redis
 * (newest first); we just render. Click a row to expand the full argv
 * if it was truncated for the table column.
 */
export function RedisSlowlogView() {
  const [entries, setEntries] = useState<RedisSlowlogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const e = await ipc.redis.slowlog(128);
      setEntries(e);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold">Slowlog</h1>
          <p className="font-display text-[11px] italic text-muted-foreground">
            commands that exceeded `slowlog-log-slower-than` (config). Cleared
            on restart unless persisted by your config.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          Refresh
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {error && (
          <div className="m-3 rounded-md border-l-4 border-destructive bg-muted px-4 py-2 text-sm text-foreground">
            {error}
          </div>
        )}
        {!error && entries.length === 0 && !loading && (
          <div className="px-4 py-3 font-display text-sm italic text-muted-foreground">
            no slow entries logged
          </div>
        )}
        {entries.length > 0 && (
          <table className="w-full font-mono text-xs">
            <thead className="sticky top-0 z-10 bg-muted/80 text-[10px] uppercase tracking-wider text-muted-foreground backdrop-blur">
              <tr>
                <th className="border-b border-border px-3 py-1.5 text-right">id</th>
                <th className="border-b border-border px-3 py-1.5 text-left">timestamp</th>
                <th className="border-b border-border px-3 py-1.5 text-right">duration</th>
                <th className="border-b border-border px-3 py-1.5 text-left">command</th>
                <th className="border-b border-border px-3 py-1.5 text-left">client</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const isOpen = openId === e.id;
                const cmdShort =
                  e.argv.length === 0
                    ? '(empty)'
                    : e.argv.slice(0, 6).join(' ') + (e.argv.length > 6 ? ' …' : '');
                return (
                  <>
                    <tr
                      key={e.id}
                      onClick={() => setOpenId(isOpen ? null : e.id)}
                      onKeyDown={(ev) => {
                        if (ev.key === 'Enter' || ev.key === ' ') {
                          ev.preventDefault();
                          setOpenId(isOpen ? null : e.id);
                        }
                      }}
                      tabIndex={0}
                      className="cursor-pointer border-b border-border/50 hover:bg-muted/30"
                    >
                      <td className="px-3 py-1 text-right align-top text-muted-foreground">{e.id}</td>
                      <td className="px-3 py-1 align-top text-muted-foreground">
                        {fmtTimestamp(e.timestamp)}
                      </td>
                      <td className="px-3 py-1 text-right align-top">{fmtDuration(e.durationUs)}</td>
                      <td className="break-all px-3 py-1 align-top text-foreground">{cmdShort}</td>
                      <td className="px-3 py-1 align-top text-muted-foreground">
                        {e.clientName ?? e.client ?? '—'}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr key={`detail-${e.id}`} className="border-b border-border bg-muted/20">
                        <td colSpan={5} className="px-3 py-2">
                          <pre className="overflow-auto rounded-md border border-border bg-background p-3 font-mono text-[11px] leading-5">
                            {e.argv.join(' ')}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}

function fmtTimestamp(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const yy = d.getFullYear();
  const mm = (d.getMonth() + 1).toString().padStart(2, '0');
  const dd = d.getDate().toString().padStart(2, '0');
  const HH = d.getHours().toString().padStart(2, '0');
  const MM = d.getMinutes().toString().padStart(2, '0');
  const SS = d.getSeconds().toString().padStart(2, '0');
  return `${yy}-${mm}-${dd} ${HH}:${MM}:${SS}`;
}

function fmtDuration(us: number): string {
  if (us < 1000) return `${us}µs`;
  if (us < 1_000_000) return `${(us / 1000).toFixed(2)}ms`;
  return `${(us / 1_000_000).toFixed(2)}s`;
}
