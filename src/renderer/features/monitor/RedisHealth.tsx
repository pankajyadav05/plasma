import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { type DataColumn, DataTable } from '@/components/ui/data-table';
import { Badge, SectionHeading } from '@/components/ui/view-parts';
import { Pill } from '@/components/ui/workbench';
import { cleanIpcError } from '@/lib/errors';
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import {
  type HotKey,
  type RedisClient,
  type SampledKey,
  buildPrefixTree,
  clientKillCommand,
  interpretBigKeys,
  interpretClients,
  interpretHotKeys,
  interpretLatency,
  interpretMemory,
  interpretSlowlog,
  isLfuError,
  parseClientList,
  parseInfo,
  parseLatencyLatest,
  topPrefixes,
} from '@shared/health/redis-health';
import {
  type CheckResult,
  classifyHealthError,
  fmtBytes,
  fmtDurationMs,
  fmtInt,
  num,
  unknownResult,
} from '@shared/health/types';
import type { RedisAnalyzeResult } from '@shared/protocol';
import { Loader2, Play, Square } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Treemap } from './Treemap';
import { CheckSection, HealthTile, type PendingFix, ResultTable, TileStrip } from './health-ui';

const MAX_SAMPLE = 50_000;
const HOT_KEY_SAMPLE = 300;
const HOT_BATCH = 25;
const FIELD =
  'h-6 rounded-[6px] bg-[var(--wb-field)] font-mono text-[12px] text-[var(--wb-text)] outline-none ring-1 ring-inset ring-[var(--wb-separator)] placeholder:text-[var(--wb-text-3)] focus:ring-[var(--wb-accent)]';

const msg = (err: unknown) => cleanIpcError(err instanceof Error ? err.message : String(err));

async function guarded(fn: () => Promise<CheckResult>): Promise<CheckResult> {
  try {
    return await fn();
  } catch (err) {
    return unknownResult(classifyHealthError(msg(err)));
  }
}

interface Cheap {
  memory?: CheckResult;
  latency?: CheckResult;
  slowlog?: CheckResult;
  clients?: CheckResult;
  clientRows: RedisClient[];
  doctor: string | null;
}

export function RedisHealth({ refreshKey }: { refreshKey: number }) {
  const db = useSession((s) => s.redisDb as number);
  const readOnly = useSession((s) => s.activeConfig?.readOnly === true);
  const [cheap, setCheap] = useState<Cheap>({ clientRows: [], doctor: null });
  const [loading, setLoading] = useState(true);
  const runId = useRef(0);

  const [match, setMatch] = useState('');
  const [capText, setCapText] = useState('5000');
  const [sampling, setSampling] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [sample, setSample] = useState<RedisAnalyzeResult | null>(null);
  const [sampleError, setSampleError] = useState<string | null>(null);
  const [hot, setHot] = useState<{
    keys: HotKey[];
    lfu: boolean;
    done: number;
    total: number;
    running: boolean;
  } | null>(null);
  const hotCancel = useRef(false);
  const [prefix, setPrefix] = useState<string | null>(null);
  const [kill, setKill] = useState<RedisClient | null>(null);
  const [killError, setKillError] = useState<string | null>(null);

  const cmd = useCallback((parts: string[]) => ipc.redis.command(parts, { db }), [db]);

  const loadCheap = useCallback(async () => {
    const id = ++runId.current;
    setLoading(true);
    const next: Cheap = { clientRows: [], doctor: null };
    const maxClients = await cmd(['CONFIG', 'GET', 'maxclients'])
      .then((r) => (Array.isArray(r.reply) ? num(r.reply[1]) : 0))
      .catch(() => 0);
    const monitorOn = await cmd(['CONFIG', 'GET', 'latency-monitor-threshold'])
      .then((r) => (Array.isArray(r.reply) ? num(r.reply[1]) > 0 : true))
      .catch(() => true);
    next.memory = await guarded(async () =>
      interpretMemory(parseInfo((await cmd(['INFO', 'memory'])).reply)),
    );
    next.latency = await guarded(async () =>
      interpretLatency(parseLatencyLatest((await cmd(['LATENCY', 'LATEST'])).reply), monitorOn),
    );
    next.doctor = await cmd(['LATENCY', 'DOCTOR'])
      .then((r) => (typeof r.reply === 'string' ? r.reply : null))
      .catch(() => null);
    next.slowlog = await guarded(async () => interpretSlowlog(await ipc.redis.slowlog(128)));
    next.clients = await guarded(async () => {
      const rows = parseClientList((await cmd(['CLIENT', 'LIST'])).reply);
      next.clientRows = rows;
      return interpretClients(rows, maxClients || undefined);
    });
    if (runId.current === id) {
      setCheap(next);
      setLoading(false);
    }
  }, [cmd]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is the trigger
  useEffect(() => {
    void loadCheap();
    return () => {
      runId.current++;
    };
  }, [loadCheap, refreshKey]);

  // Elapsed counter while the scan runs (the worker reports no partial progress).
  useEffect(() => {
    if (!sampling) return;
    const t0 = Date.now();
    setElapsed(0);
    const t = setInterval(() => setElapsed(Date.now() - t0), 250);
    return () => clearInterval(t);
  }, [sampling]);

  const cap = Number.parseInt(capText, 10);
  const capBad = !Number.isFinite(cap) || cap <= 0 || cap > MAX_SAMPLE;

  const runHot = async (samples: SampledKey[]) => {
    const picks: SampledKey[] = [];
    const stride = Math.max(1, Math.floor(samples.length / HOT_KEY_SAMPLE));
    for (let i = 0; i < samples.length && picks.length < HOT_KEY_SAMPLE; i += stride) {
      const s = samples[i];
      if (s) picks.push(s);
    }
    hotCancel.current = false;
    const keys: HotKey[] = [];
    setHot({ keys, lfu: true, done: 0, total: picks.length, running: true });
    for (let i = 0; i < picks.length; i += HOT_BATCH) {
      if (hotCancel.current) break;
      const batch = picks.slice(i, i + HOT_BATCH);
      const res = await Promise.all(
        batch.map((s) =>
          cmd(['OBJECT', 'FREQ', s.key]).then(
            (r) => ({ key: s.key, freq: num(r.reply), err: null as string | null }),
            (e: unknown) => ({ key: s.key, freq: 0, err: msg(e) }),
          ),
        ),
      );
      const lfuErr = res.find((r) => r.err && isLfuError(r.err));
      if (lfuErr) {
        setHot({ keys: [], lfu: false, done: picks.length, total: picks.length, running: false });
        return;
      }
      for (const r of res) if (!r.err) keys.push({ key: r.key, freq: r.freq });
      setHot({
        keys: [...keys],
        lfu: true,
        done: Math.min(picks.length, i + HOT_BATCH),
        total: picks.length,
        running: true,
      });
    }
    setHot({ keys: [...keys], lfu: true, done: picks.length, total: picks.length, running: false });
  };

  const runSample = async () => {
    if (capBad || sampling) return;
    setSampling(true);
    setSampleError(null);
    setHot(null);
    setPrefix(null);
    try {
      const r = await ipc.redis.analyze({ sampleCap: cap, match: match.trim() || undefined, db });
      setSample(r);
      await runHot(r.samples);
    } catch (err) {
      setSampleError(msg(err));
    } finally {
      setSampling(false);
    }
  };

  const stop = () => {
    hotCancel.current = true;
    void ipc.redis.cancel().catch(() => {});
  };

  const samples: SampledKey[] = useMemo(() => sample?.samples ?? [], [sample]);
  const tree = useMemo(() => buildPrefixTree(samples), [samples]);
  const prefixes = useMemo(() => topPrefixes(tree), [tree]);
  const big = sample ? interpretBigKeys(samples, sample.scanned) : undefined;
  const hotResult = hot ? interpretHotKeys(hot.keys, hot.lfu) : undefined;

  const onKill = async () => {
    if (!kill) return;
    const parts = clientKillCommand(kill.id);
    setKillError(null);
    try {
      if (!parts) throw new Error('Invalid client id');
      await cmd(parts);
    } catch (err) {
      setKillError(msg(err));
    } finally {
      setKill(null);
      void loadCheap();
    }
  };

  const noFix = (_f: PendingFix) => {};
  const unavailable = (r: CheckResult | undefined) => r?.status === 'unknown';

  const clientColumns: DataColumn<RedisClient>[] = [
    { key: 'id', label: 'ID', width: 70, render: (c) => c.id },
    { key: 'addr', label: 'Address', width: 170, render: (c) => c.addr },
    { key: 'name', label: 'Name', width: 120, render: (c) => c.name || null },
    { key: 'db', label: 'DB', width: 50, render: (c) => c.db },
    {
      key: 'age',
      label: 'Age',
      align: 'right',
      width: 80,
      render: (c) => fmtDurationMs(c.ageS * 1000),
    },
    {
      key: 'idle',
      label: 'Idle',
      align: 'right',
      width: 80,
      render: (c) => fmtDurationMs(c.idleS * 1000),
    },
    { key: 'cmd', label: 'Last cmd', width: 110, render: (c) => c.cmd },
    {
      key: 'omem',
      label: 'Output buf',
      align: 'right',
      width: 100,
      render: (c) => fmtBytes(c.omem),
    },
    {
      key: 'kill',
      label: '',
      sans: true,
      width: 80,
      render: (c) => (
        <Button
          size="xs"
          variant="secondary"
          disabled={readOnly}
          title={readOnly ? 'This connection is read-only' : 'CLIENT KILL'}
          onClick={(e) => {
            e.stopPropagation();
            setKill(c);
          }}
        >
          Kill…
        </Button>
      ),
    },
  ];

  const keyColumns: DataColumn<SampledKey>[] = [
    { key: 'key', label: 'Key', width: 380, render: (k) => k.key, titleOf: (k) => k.key },
    { key: 'type', label: 'Type', width: 80, render: (k) => k.type },
    {
      key: 'bytes',
      label: 'Memory',
      align: 'right',
      width: 110,
      render: (k) => (k.bytes === null ? null : fmtBytes(k.bytes)),
    },
  ];
  const tableHeight = (n: number) => Math.min(n, 10) * 24 + 30;
  const bigKeys = [...samples].filter((s) => s.bytes !== null).slice(0, 15);

  return (
    <>
      <TileStrip>
        <HealthTile
          label="Memory"
          status={cheap.memory?.status ?? 'unknown'}
          summary={cheap.memory?.summary ?? ''}
          loading={!cheap.memory}
        />
        <HealthTile
          label="Latency"
          status={cheap.latency?.status ?? 'unknown'}
          summary={cheap.latency?.summary ?? ''}
          loading={!cheap.latency}
        />
        <HealthTile
          label="Slow log"
          status={cheap.slowlog?.status ?? 'unknown'}
          summary={cheap.slowlog?.summary ?? ''}
          loading={!cheap.slowlog}
        />
        <HealthTile
          label="Clients"
          status={cheap.clients?.status ?? 'unknown'}
          summary={cheap.clients?.summary ?? ''}
          loading={!cheap.clients}
        />
        <HealthTile
          label="Big keys"
          status={big?.status ?? 'unknown'}
          summary={big ? big.summary : 'Run a sample'}
          loading={sampling}
        />
        <HealthTile
          label="Hot keys"
          status={hotResult?.status ?? 'unknown'}
          summary={hotResult ? hotResult.summary : 'Run a sample'}
          loading={Boolean(hot?.running)}
        />
      </TileStrip>

      <div className="min-h-0 flex-1 overflow-auto pb-6">
        <SectionHeading
          action={sample ? <Badge>{fmtInt(sample.scanned)} keys sampled</Badge> : undefined}
        >
          Big keys, hot keys and memory by prefix
        </SectionHeading>
        <form
          className="flex flex-wrap items-center gap-2 px-4 pb-2"
          onSubmit={(e) => {
            e.preventDefault();
            void runSample();
          }}
        >
          <input
            value={match}
            onChange={(e) => setMatch(e.target.value)}
            placeholder="MATCH pattern (e.g. user:*)"
            aria-label="MATCH pattern"
            spellCheck={false}
            className={`${FIELD} w-48 px-2`}
          />
          <label className="flex items-center gap-1.5 text-[12px] text-[var(--wb-text-2)]">
            Sample
            <input
              value={capText}
              onChange={(e) => setCapText(e.target.value)}
              inputMode="numeric"
              aria-label="Sample cap"
              aria-invalid={capBad || undefined}
              className={`${FIELD} w-20 px-2 text-right tabular-nums ${capBad ? 'ring-destructive' : ''}`}
            />
          </label>
          {sampling || hot?.running ? (
            <Pill onClick={stop} aria-label="Stop sampling">
              <Square />
              Stop
            </Pill>
          ) : (
            <Pill type="submit" disabled={capBad}>
              <Play />
              Run sample
            </Pill>
          )}
          {sampling && (
            <span
              className="flex items-center gap-1.5 text-[12px] text-[var(--wb-text-2)]"
              aria-live="polite"
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              SCAN + MEMORY USAGE, up to {fmtInt(cap)} keys, {Math.round(elapsed / 1000)}s
            </span>
          )}
          {hot?.running && (
            <span className="text-[12px] text-[var(--wb-text-2)]" aria-live="polite">
              OBJECT FREQ {hot.done} / {hot.total}
            </span>
          )}
          {sample?.cancelled && <Badge tone="warn">stopped early, partial results</Badge>}
        </form>
        <p className="px-4 pb-2 text-[11px] text-[var(--wb-text-3)]">
          Sampling uses SCAN (never KEYS) and read-only commands, so it is safe on a busy server,
          but a bigger sample takes longer. Stop at any time to keep what was scanned.
        </p>
        {sampleError && (
          <p className="px-4 pb-2 text-[12px] text-destructive" role="alert">
            {sampleError}
          </p>
        )}

        {sample && (
          <>
            <Treemap root={tree} selected={prefix} onSelect={(n) => setPrefix(n.path)} />
            <div className="flex flex-wrap items-center gap-2 px-4 pb-2 text-[12px] text-[var(--wb-text-2)]">
              {prefix ? (
                <>
                  <span className="font-mono text-[var(--wb-text)]">{prefix}:*</span>
                  <Button size="xs" variant="secondary" onClick={() => setMatch(`${prefix}:*`)}>
                    Use as MATCH
                  </Button>
                </>
              ) : (
                'Click a rectangle to see its prefix. Area is memory.'
              )}
            </div>
            <ResultTable
              label="Top prefixes"
              table={{
                columns: [
                  { key: 'prefix', label: 'Top prefixes', width: 320 },
                  { key: 'keys', label: 'Keys', align: 'right', width: 90 },
                  { key: 'bytes', label: 'Memory', align: 'right', width: 110 },
                  { key: 'share', label: 'Share', align: 'right', width: 80 },
                ],
                rows: prefixes.map((p) => ({
                  prefix: p.path,
                  keys: fmtInt(p.count),
                  bytes: fmtBytes(p.bytes),
                  share: `${tree.bytes > 0 ? Math.round((p.bytes / tree.bytes) * 100) : 0}%`,
                })),
              }}
            />
            <CheckSection title="Big keys" result={big} loading={sampling} onFix={noFix} />
            {bigKeys.length > 0 && (
              <div
                className="mx-4 mb-3 overflow-hidden rounded-[6px] border border-[var(--wb-separator)]"
                style={{ height: tableHeight(bigKeys.length) }}
              >
                <DataTable
                  ariaLabel="Largest sampled keys"
                  columns={keyColumns}
                  rows={bigKeys}
                  rowKey={(k) => k.key}
                  rowNumbers={false}
                  stripeFill={false}
                />
              </div>
            )}
            <CheckSection
              title="Hot keys"
              result={hotResult}
              loading={Boolean(hot?.running)}
              onFix={noFix}
            />
          </>
        )}

        <CheckSection title="Memory" result={cheap.memory} loading={loading} onFix={noFix} />
        <CheckSection title="Latency" result={cheap.latency} loading={loading} onFix={noFix} />
        {cheap.doctor && !unavailable(cheap.latency) && (
          <details className="mx-4 mb-3">
            <summary className="cursor-pointer text-[12px] text-[var(--wb-text-2)]">
              LATENCY DOCTOR report
            </summary>
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-[7px] bg-[var(--wb-field)] p-2 font-mono text-[11.5px] text-[var(--wb-text-2)]">
              {cheap.doctor}
            </pre>
          </details>
        )}
        <CheckSection
          title="Slow log summary"
          result={cheap.slowlog}
          loading={loading}
          onFix={noFix}
        />
        <CheckSection title="Clients" result={cheap.clients} loading={loading} onFix={noFix} />
        {killError && (
          <p className="px-4 pb-2 text-[12px] text-destructive" role="alert">
            {killError}
          </p>
        )}
        {cheap.clientRows.length > 0 && (
          <div
            className="mx-4 mb-3 overflow-hidden rounded-[6px] border border-[var(--wb-separator)]"
            style={{ height: tableHeight(cheap.clientRows.length) }}
          >
            <DataTable
              ariaLabel="Connected clients"
              columns={clientColumns}
              rows={cheap.clientRows}
              rowKey={(c) => c.id}
              rowNumbers={false}
              stripeFill={false}
            />
          </div>
        )}
      </div>

      <ConfirmDialog
        open={kill !== null}
        onOpenChange={(v) => !v && setKill(null)}
        title={`Kill client ${kill?.id}?`}
        description={`CLIENT KILL ID ${kill?.id} closes the connection from ${kill?.addr}${kill?.name ? ` (${kill.name})` : ''}. The application may reconnect. If this is Plasma's own connection it will reconnect on the next command.`}
        confirmLabel="Kill client"
        variant="destructive"
        onConfirm={() => void onKill()}
      />
    </>
  );
}
