import { SectionHeading } from '@/components/ui/view-parts';
import { cleanIpcError } from '@/lib/errors';
import { ipc } from '@/lib/ipc';
import {
  type AllocationExplanation,
  explainAllocation,
  interpretClusterHealth,
  interpretDisks,
  interpretHotThreads,
  parseNodeDisks,
  parseUnassignedShards,
  parseWatermarks,
  summarizeHotThreads,
} from '@shared/health/os-health';
import { type CheckResult, classifyHealthError, unknownResult } from '@shared/health/types';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckSection, HealthTile, type PendingFix, TileStrip } from './health-ui';

const EXPLAIN_LIMIT = 5;
const TIMEOUT_MS = 15_000;

class OsHttpError extends Error {
  constructor(
    readonly status: number,
    path: string,
    detail: string,
  ) {
    super(`${status} on ${path}: ${detail}`);
  }
}

async function get(path: string): Promise<unknown> {
  const res = await ipc.os.request({ method: 'GET', path, timeoutMs: TIMEOUT_MS });
  if (res.status >= 400) throw new OsHttpError(res.status, path, errorText(res.body));
  return res.body;
}

function errorText(body: unknown): string {
  if (typeof body === 'string') return body.slice(0, 200);
  if (body && typeof body === 'object') {
    const e = (body as { error?: unknown }).error;
    if (typeof e === 'string') return e;
    if (e && typeof e === 'object') return String((e as { reason?: unknown }).reason ?? '');
  }
  return '';
}

async function guarded(fn: () => Promise<CheckResult>): Promise<CheckResult> {
  try {
    return await fn();
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const c = classifyHealthError(cleanIpcError(raw));
    if (err instanceof OsHttpError && (err.status === 401 || err.status === 403)) {
      return unknownResult({ ...c, kind: 'privilege', badge: 'needs cluster monitor permission' });
    }
    return unknownResult(c);
  }
}

interface State {
  cluster?: CheckResult;
  disks?: CheckResult;
  threads?: CheckResult;
  explanations: AllocationExplanation[];
}

export function OsHealth({ refreshKey }: { refreshKey: number }) {
  const [state, setState] = useState<State>({ explanations: [] });
  const [loading, setLoading] = useState(true);
  const runId = useRef(0);

  const load = useCallback(async () => {
    const id = ++runId.current;
    setLoading(true);
    const next: State = { explanations: [] };
    next.cluster = await guarded(async () => {
      const health = await get('/_cluster/health?level=indices');
      const shards = parseUnassignedShards(
        await get('/_cat/shards?format=json&h=index,shard,prirep,state,unassigned.reason').catch(
          () => [],
        ),
      );
      // Ask the cluster why, for a few distinct unassigned shards (primaries first).
      const seen = new Set<string>();
      const targets = [...shards]
        .sort((a, b) => Number(b.primary) - Number(a.primary))
        .filter((s) => {
          const k = `${s.index}:${s.shard}:${s.primary}`;
          if (seen.has(k) || seen.size >= EXPLAIN_LIMIT) return false;
          seen.add(k);
          return true;
        });
      for (const t of targets) {
        const res = await ipc.os
          .request({
            method: 'POST',
            path: '/_cluster/allocation/explain',
            body: JSON.stringify({ index: t.index, shard: t.shard, primary: t.primary }),
            timeoutMs: TIMEOUT_MS,
          })
          .catch(() => null);
        const e = res && res.status < 400 ? explainAllocation(res.body) : null;
        if (e) next.explanations.push(e);
      }
      return interpretClusterHealth(health, next.explanations, shards);
    });
    next.disks = await guarded(async () => {
      const disks = parseNodeDisks(await get('/_cat/allocation?format=json&bytes=b'));
      const settings = await get(
        '/_cluster/settings?include_defaults=true&flat_settings=true',
      ).catch(() => null);
      return interpretDisks(disks, parseWatermarks(settings));
    });
    next.threads = await guarded(async () => {
      const body = await get('/_nodes/hot_threads?threads=3&interval=500ms');
      return interpretHotThreads(summarizeHotThreads(typeof body === 'string' ? body : ''));
    });
    if (runId.current === id) {
      setState(next);
      setLoading(false);
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is the trigger
  useEffect(() => {
    void load();
    return () => {
      runId.current++;
    };
  }, [load, refreshKey]);

  const noFix = (_f: PendingFix) => {};

  return (
    <>
      <TileStrip>
        <HealthTile
          label="Cluster"
          status={state.cluster?.status ?? 'unknown'}
          summary={state.cluster?.summary ?? ''}
          loading={!state.cluster}
        />
        <HealthTile
          label="Disk watermarks"
          status={state.disks?.status ?? 'unknown'}
          summary={state.disks?.summary ?? ''}
          loading={!state.disks}
        />
        <HealthTile
          label="Hot threads"
          status={state.threads?.status ?? 'unknown'}
          summary={state.threads?.summary ?? ''}
          loading={!state.threads}
        />
      </TileStrip>
      <div className="min-h-0 flex-1 overflow-auto pb-6">
        <CheckSection
          title="Cluster health and unassigned shards"
          result={state.cluster}
          loading={loading}
          onFix={noFix}
        />
        {state.explanations.length > 0 && (
          <section aria-label="Allocation explanations">
            <SectionHeading>Why shards are unassigned</SectionHeading>
            <ul className="mx-4 mb-2 space-y-2">
              {state.explanations.map((e) => (
                <li
                  key={`${e.index}:${e.shard}:${e.primary}`}
                  className="rounded-[6px] border border-[var(--wb-separator)] px-3 py-2"
                >
                  <div className="font-mono text-[12px] text-[var(--wb-text)]">
                    {e.index} shard {e.shard} ({e.primary ? 'primary' : 'replica'})
                  </div>
                  <div className="text-[12px] text-[var(--wb-text-2)]">{e.reason}</div>
                  <ul className="mt-1 list-disc pl-5 text-[12px] text-[var(--wb-text-2)]">
                    {e.causes.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                  {e.fix && (
                    <div className="mt-1 text-[12px] text-[var(--wb-text)]">Fix: {e.fix}</div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
        <CheckSection
          title="Disk usage and watermarks per node"
          result={state.disks}
          loading={loading}
          onFix={noFix}
        />
        <CheckSection title="Hot threads" result={state.threads} loading={loading} onFix={noFix} />
      </div>
    </>
  );
}
