import { type DataColumn, DataTable } from '@/components/ui/data-table';
import {
  Badge,
  EmptyState,
  SectionHeading,
  StatTile,
  ViewFooter,
  ViewTitle,
  ViewToolbar,
} from '@/components/ui/view-parts';
import { Pill } from '@/components/ui/workbench';
import { cleanIpcError } from '@/lib/errors';
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import { useWorkbench } from '@/stores/workbench';
import type { RedisAnalyzeResult, RedisAnalyzeSample } from '@shared/protocol';
import { ExternalLink, Loader2, Play, Search, Square } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_ANALYZE, useRedisTabs } from './redis-store';

/** R14: the analyzer never samples more than this. */
const MAX_SAMPLE = 50_000;

const FIELD =
  'h-6 rounded-[6px] bg-[var(--wb-field)] font-mono text-[12px] text-[var(--wb-text)] outline-none ring-1 ring-inset ring-[var(--wb-separator)] placeholder:text-[var(--wb-text-3)] focus:ring-[var(--wb-accent)]';

/**
 * Memory analyzer — runs a SCAN sample, pulls MEMORY USAGE per key,
 * aggregates by type + namespace prefix, and renders:
 *
 *   1. Stat tiles — keys scanned, total bytes, biggest single key.
 *   2. Two compact bar lists — bytes per type, bytes per top prefix.
 *   3. Drill-down grid — sampled keys by size, with type + TTL.
 *      Selecting a key shows it in Details; double-click / Enter opens it.
 *
 * Sample size is capped (default 5000, max 50,000) and the scan can be
 * cancelled, so this is safe to run in prod. Results live in the tab
 * store, so they survive tab switches (R14/R18).
 */
export function RedisAnalyzeView({ tabId }: { tabId: string }) {
  const openRedisKey = useSession((s) => s.openRedisKey);
  const db = useSession((s) => s.redisDb as number);
  const st = useRedisTabs((s) => s.analyze[tabId]) ?? DEFAULT_ANALYZE;
  const update = useRedisTabs((s) => s.updateAnalyze);
  const { match, sampleCap, running, error, result, tookMs } = st;
  const setMatch = (v: string) => update(tabId, { match: v });
  const setSampleCap = (v: string) => update(tabId, { sampleCap: v });
  const [selected, setSelected] = useState<number | null>(null);

  // Clear the Details pane when leaving the view.
  useEffect(() => () => useWorkbench.getState().setInspectedRow(null), []);

  const capN = Number.parseInt(sampleCap, 10);
  const capBad = !Number.isFinite(capN) || capN <= 0 || capN > MAX_SAMPLE;

  const onRun = async () => {
    if (capBad) return;
    update(tabId, { running: true, error: null });
    setSelected(null);
    useWorkbench.getState().setInspectedRow(null);
    const started = performance.now();
    try {
      const r = await ipc.redis.analyze({ sampleCap: capN, match: match.trim() || undefined, db });
      update(tabId, { result: r, tookMs: Math.round(performance.now() - started) });
    } catch (err) {
      update(tabId, {
        error: cleanIpcError(err instanceof Error ? err.message : String(err)),
        result: null,
        tookMs: null,
      });
    } finally {
      update(tabId, { running: false });
    }
  };

  const onSelect = (s: RedisAnalyzeSample, index: number) => {
    setSelected(index);
    if (!tabId) return;
    useWorkbench.getState().setInspectedRow({
      tabId,
      rowNumber: index + 1,
      columnIndex: 0,
      columns: [
        { name: 'key', dataTypeID: 0, dataTypeName: 'redis key' },
        { name: 'type', dataTypeID: 0, dataTypeName: 'redis type' },
        { name: 'bytes', dataTypeID: 0, dataTypeName: 'MEMORY USAGE' },
        { name: 'size', dataTypeID: 0, dataTypeName: 'formatted' },
        { name: 'ttl_ms', dataTypeID: 0, dataTypeName: 'PTTL' },
      ],
      row: [s.key, s.type, s.bytes, s.bytes === null ? 'unavailable' : fmtBytes(s.bytes), s.ttlMs],
    });
  };

  const selectedSample = result && selected !== null ? result.samples[selected] : undefined;

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--wb-content)]">
      <ViewToolbar>
        <ViewTitle title="Memory analyzer" meta={`db${db} · SCAN sample · MEMORY USAGE per key`} />
        <div className="flex-1" />
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!running) void onRun();
          }}
        >
          <div className="relative w-56">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--wb-text-3)]" />
            <input
              value={match}
              onChange={(e) => setMatch(e.target.value)}
              placeholder="MATCH pattern (e.g. user:*)"
              aria-label="MATCH pattern"
              spellCheck={false}
              className={`${FIELD} w-full pl-7 pr-2`}
            />
          </div>
          <label className="flex items-center gap-1.5 text-[12px] text-[var(--wb-text-2)]">
            Sample
            <input
              value={sampleCap}
              onChange={(e) => setSampleCap(e.target.value)}
              inputMode="numeric"
              aria-label="Sample cap"
              aria-invalid={capBad || undefined}
              title={`1 – ${MAX_SAMPLE.toLocaleString()} keys`}
              className={`${FIELD} w-20 px-2 text-right tabular-nums ${capBad ? 'ring-destructive' : ''}`}
            />
          </label>
          {running ? (
            <Pill
              onClick={() => void ipc.redis.cancel().catch(() => {})}
              aria-label="Cancel analyze"
            >
              <Square />
              Stop
            </Pill>
          ) : (
            <Pill
              type="submit"
              disabled={capBad}
              aria-label="Run analyze"
              title={capBad ? `Sample must be 1 – ${MAX_SAMPLE.toLocaleString()}` : undefined}
            >
              <Play />
              Run
            </Pill>
          )}
        </form>
      </ViewToolbar>

      {error && (
        <div
          role="alert"
          className="shrink-0 border-b border-[var(--wb-separator)] px-3 py-1.5 text-[13px] text-destructive"
        >
          {error}
        </div>
      )}

      {result ? (
        <Body result={result} selected={selected} onSelect={onSelect} onOpenKey={openRedisKey} />
      ) : running ? (
        <EmptyState
          title={
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Scanning keyspace…
            </span>
          }
        />
      ) : (
        !error && (
          <EmptyState
            title="No analysis yet"
            hint="Samples keys with SCAN and sizes each with MEMORY USAGE, then aggregates by type and prefix. Capped at the sample size, so it is safe to run on production."
            action={
              <Pill onClick={() => void onRun()}>
                <Play />
                Run analyze
              </Pill>
            }
          />
        )
      )}

      {result && (
        <ViewFooter>
          <span className="tabular-nums">
            {result.scanned.toLocaleString()} {result.scanned === 1 ? 'key' : 'keys'} sampled
            {result.cancelled ? ' · stopped early' : ''}
            {result.unsized ? ` · ${result.unsized.toLocaleString()} without MEMORY USAGE` : ''}
          </span>
          {tookMs !== null && <span className="tabular-nums">· {fmtMs(tookMs)}</span>}
          <div className="flex-1" />
          {selectedSample ? (
            <Pill
              onClick={() => openRedisKey(selectedSample.key)}
              title={`Open ${selectedSample.key}`}
            >
              <ExternalLink />
              Open key
            </Pill>
          ) : (
            <span className="text-[12px] text-[var(--wb-text-3)]">
              Double-click a key to open it
            </span>
          )}
        </ViewFooter>
      )}
    </main>
  );
}

function Body({
  result,
  selected,
  onSelect,
  onOpenKey,
}: {
  result: RedisAnalyzeResult;
  selected: number | null;
  onSelect: (s: RedisAnalyzeSample, index: number) => void;
  onOpenKey: (k: string) => void;
}) {
  const biggest = result.samples[0];

  const columns = useMemo<DataColumn<RedisAnalyzeSample>[]>(
    () => [
      {
        key: 'key',
        label: 'key',
        render: (s) => s.key,
        titleOf: (s) => s.key,
      },
      {
        key: 'type',
        label: 'type',
        width: 90,
        sans: true,
        render: (s) => <Badge>{s.type}</Badge>,
      },
      {
        key: 'size',
        label: 'size',
        title: 'MEMORY USAGE',
        align: 'right',
        width: 100,
        render: (s) => (s.bytes === null ? null : fmtBytes(s.bytes)),
        titleOf: (s) =>
          s.bytes === null ? 'MEMORY USAGE unavailable' : `${s.bytes.toLocaleString()} bytes`,
      },
      {
        key: 'ttl',
        label: 'ttl',
        title: 'Time to live (— = no expiry)',
        align: 'right',
        width: 100,
        render: (s) =>
          s.ttlMs === null ? <span className="text-[var(--grid-null)]">—</span> : fmtTtl(s.ttlMs),
      },
    ],
    [],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="max-h-[50%] shrink-0 overflow-y-auto border-b border-[var(--wb-separator)] pb-3">
        <div className="grid grid-cols-3 gap-2 px-4 pt-3">
          <StatTile label="Keys scanned" value={result.scanned.toLocaleString()} />
          <StatTile label="Total bytes" value={fmtBytes(result.totalBytes)} />
          <StatTile
            label="Biggest key"
            value={biggest && biggest.bytes !== null ? fmtBytes(biggest.bytes) : '—'}
            hint={biggest ? <span title={biggest.key}>{biggest.key}</span> : undefined}
          />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2">
          <div className="min-w-0">
            <SectionHeading>By type</SectionHeading>
            <BarList
              ariaLabel="Memory by type"
              rows={result.byType.map((t) => ({
                label: t.type,
                count: t.count,
                bytes: t.bytes,
              }))}
            />
          </div>
          <div className="min-w-0">
            <SectionHeading>By prefix</SectionHeading>
            <BarList
              ariaLabel="Memory by prefix"
              rows={result.byPrefix.map((p) => ({
                label: p.prefix || '(no prefix)',
                count: p.count,
                bytes: p.bytes,
              }))}
            />
          </div>
        </div>
      </div>

      <div className="flex h-[30px] shrink-0 items-center gap-2 px-3 text-[13px]">
        <span className="font-semibold text-[var(--wb-text)]">Largest keys</span>
        <span className="text-[12px] text-[var(--wb-text-2)]">
          top {result.samples.length.toLocaleString()} by size
        </span>
      </div>
      <DataTable
        ariaLabel="Largest keys"
        className="border-t border-[var(--wb-separator)]"
        columns={columns}
        rows={result.samples}
        rowKey={(s) => s.key}
        selectedIndex={selected}
        onSelect={onSelect}
        onActivate={(s) => onOpenKey(s.key)}
        empty={<span>No keys matched</span>}
      />
    </div>
  );
}

/** Compact horizontal bars (TablePlus-dense), filled with --wb-accent. */
function BarList({
  rows,
  ariaLabel,
}: {
  rows: { label: string; count: number; bytes: number }[];
  ariaLabel: string;
}) {
  if (rows.length === 0) {
    return <div className="px-4 text-[13px] text-[var(--wb-text-2)]">No keys</div>;
  }
  const max = rows.reduce((acc, r) => Math.max(acc, r.bytes), 0);
  return (
    <ul aria-label={ariaLabel} className="px-4">
      {rows.map((r) => {
        const pct = max > 0 ? (r.bytes / max) * 100 : 0;
        return (
          <li
            key={r.label}
            className="grid h-6 grid-cols-[minmax(0,120px)_1fr_auto] items-center gap-2.5 text-[13px]"
            title={`${r.label}: ${r.bytes.toLocaleString()} bytes in ${r.count.toLocaleString()} keys`}
          >
            <span className="truncate font-mono text-[var(--wb-text)]">{r.label}</span>
            <div className="h-2 overflow-hidden rounded-[3px] bg-[var(--wb-control)]">
              <div
                className="h-full rounded-[3px] bg-[var(--wb-accent)]"
                style={{ width: `${Math.max(pct, r.bytes > 0 ? 1 : 0)}%` }}
              />
            </div>
            <span className="whitespace-nowrap text-right font-mono text-[12px] tabular-nums text-[var(--wb-text-2)]">
              {fmtBytes(r.bytes)}
              <span className="text-[var(--wb-text-3)]"> · {r.count.toLocaleString()}</span>
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

function fmtTtl(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
}
