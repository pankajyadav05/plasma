import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import type { RedisAnalyzeResult } from '@shared/protocol';
import { Loader2, Play, Search } from 'lucide-react';
import { useState } from 'react';

/**
 * Memory analyzer — runs a SCAN sample, pulls MEMORY USAGE per key,
 * aggregates by type + namespace prefix, and renders three coordinated
 * panels:
 *
 *   1. Top KPI strip — keys scanned, total bytes, biggest single key.
 *   2. Two horizontal bar charts — one per type, one per top prefix.
 *   3. Drill-down table — top 1000 keys by size, with type + TTL.
 *
 * Sample size is capped (default 5000) so this is safe to run in prod.
 * The "Run analyze" button sets this off; results stay until the user
 * runs again or closes the tab.
 */
export function RedisAnalyzeView() {
  const openRedisKey = useSession((s) => s.openRedisKey);
  const [match, setMatch] = useState('');
  const [sampleCap, setSampleCap] = useState('5000');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RedisAnalyzeResult | null>(null);

  const onRun = async () => {
    const cap = Number.parseInt(sampleCap, 10);
    setRunning(true);
    setError(null);
    try {
      const r = await ipc.redis.analyze({
        sampleCap: Number.isFinite(cap) && cap > 0 ? cap : 5000,
        match: match.trim() || undefined,
      });
      setResult(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setResult(null);
    } finally {
      setRunning(false);
    }
  };

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold">Memory analyzer</h1>
          <p className="font-display text-[11px] italic text-muted-foreground">
            SCAN sample with MEMORY USAGE per key. Safe to run on production —
            capped at the chosen sample size.
          </p>
        </div>
      </div>

      {/* Run controls */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/30 px-4 py-2.5">
        <div className="relative w-64">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={match}
            onChange={(e) => setMatch(e.target.value)}
            placeholder="MATCH pattern (e.g. user:*)"
            className="h-7 pl-7 font-mono text-xs"
          />
        </div>
        <span className="font-display text-[11px] italic text-muted-foreground">sample cap</span>
        <Input
          value={sampleCap}
          onChange={(e) => setSampleCap(e.target.value)}
          inputMode="numeric"
          className="h-7 w-24 font-mono text-xs"
        />
        <div className="flex-1" />
        <Button variant="primary" size="sm" onClick={() => void onRun()} disabled={running}>
          {running ? <Loader2 className="animate-spin" /> : <Play className="fill-current" />}
          Run analyze
        </Button>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {error && (
          <div className="mb-3 rounded-md border-l-4 border-destructive bg-muted px-4 py-2 text-sm text-foreground">
            {error}
          </div>
        )}

        {!result && !running && (
          <div className="font-display text-sm italic text-muted-foreground">
            press Run to scan the keyspace and aggregate memory usage.
          </div>
        )}

        {running && !result && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> scanning…
          </div>
        )}

        {result && <Body result={result} onOpenKey={openRedisKey} />}
      </div>
    </main>
  );
}

function Body({
  result,
  onOpenKey,
}: {
  result: RedisAnalyzeResult;
  onOpenKey: (k: string) => void;
}) {
  const biggest = result.samples[0];
  return (
    <div className="space-y-6">
      {/* KPI strip */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Kpi label="Keys scanned" value={result.scanned.toLocaleString()} />
        <Kpi label="Total bytes" value={fmtBytes(result.totalBytes)} />
        <Kpi
          label="Biggest key"
          value={biggest && biggest.bytes != null ? fmtBytes(biggest.bytes) : '—'}
          sub={biggest?.key}
        />
      </div>

      {/* Type + prefix breakdown side by side */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Section title="By type">
          <BarList
            rows={result.byType.map((t) => ({
              label: t.type,
              count: t.count,
              bytes: t.bytes,
            }))}
          />
        </Section>
        <Section title="By namespace prefix">
          <BarList
            rows={result.byPrefix.map((p) => ({
              label: p.prefix || '(no prefix)',
              count: p.count,
              bytes: p.bytes,
            }))}
          />
        </Section>
      </div>

      {/* Detail table */}
      <Section title={`Top ${result.samples.length.toLocaleString()} keys by size`}>
        <div className="overflow-auto rounded-md border border-border">
          <table className="w-full font-mono text-xs">
            <thead className="bg-muted/60 text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="border-b border-border px-3 py-1.5 text-left">key</th>
                <th className="border-b border-border px-3 py-1.5 text-left">type</th>
                <th className="border-b border-border px-3 py-1.5 text-right">bytes</th>
                <th className="border-b border-border px-3 py-1.5 text-right">ttl</th>
              </tr>
            </thead>
            <tbody>
              {result.samples.map((s) => (
                <tr
                  key={s.key}
                  className="border-b border-border/50 last:border-b-0 hover:bg-muted/30"
                >
                  <td className="break-all px-3 py-1 align-top">
                    <button
                      type="button"
                      onClick={() => onOpenKey(s.key)}
                      className="cursor-pointer text-left text-foreground underline-offset-2 hover:underline"
                    >
                      {s.key}
                    </button>
                  </td>
                  <td className="px-3 py-1 align-top text-muted-foreground">{s.type}</td>
                  <td className="px-3 py-1 text-right align-top">{s.bytes === null ? '—' : fmtBytes(s.bytes)}</td>
                  <td className="px-3 py-1 text-right align-top text-muted-foreground">
                    {s.ttlMs === null ? '—' : `${(s.ttlMs / 1000).toFixed(1)}s`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border border-border bg-muted/30 p-3">
      <div className="font-display text-[11px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 font-display text-2xl">{value}</div>
      {sub && (
        <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={sub}>
          {sub}
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

function BarList({
  rows,
}: {
  rows: { label: string; count: number; bytes: number }[];
}) {
  if (rows.length === 0) {
    return (
      <div className="px-3 py-2 font-display text-sm italic text-muted-foreground">
        empty
      </div>
    );
  }
  const max = rows.reduce((acc, r) => Math.max(acc, r.bytes), 0);
  return (
    <ul className="space-y-1">
      {rows.map((r) => {
        const pct = max > 0 ? (r.bytes / max) * 100 : 0;
        return (
          <li
            key={r.label}
            className="grid grid-cols-[120px_1fr_auto] items-center gap-2 font-mono text-xs"
          >
            <span className="truncate text-foreground" title={r.label}>
              {r.label}
            </span>
            <div className="relative h-3 overflow-hidden rounded-sm bg-muted">
              <div
                className="absolute inset-y-0 left-0 bg-foreground/60"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-right text-muted-foreground">
              {fmtBytes(r.bytes)} · {r.count.toLocaleString()}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}
