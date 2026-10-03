/**
 * Renderer-side lookups behind "Referenced by" and the FK peek: small
 * read-only SELECTs on the side connection (never queued behind — or
 * cancelled with — the user's own query), cached briefly per connection.
 */
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import type { ColumnMeta } from '@shared/protocol';
import { dialectFor, engineCaps } from '@shared/sql-dialect';
import { useEffect, useMemo, useState } from 'react';
import {
  type FkLookup,
  type IncomingCount,
  type IncomingCountRequest,
  buildIncomingCountSql,
  buildPeekSql,
  parseIncomingCounts,
  requestsKey,
} from './fk-nav';

const LOOKUP_TIMEOUT_MS = 8_000;
const TTL_MS = 20_000;

interface Cached<T> {
  at: number;
  gen: number;
  value: T;
}
const countCache = new Map<string, Cached<IncomingCount | null>>();
const peekCache = new Map<string, Cached<PeekResult>>();

function connectionGen(): number {
  return useSession.getState().connectionGen ?? 0;
}

function currentDialect() {
  return dialectFor(useSession.getState().activeConfig?.engine);
}

async function lookup(sql: string, params: unknown[]) {
  const state = useSession.getState();
  // Under SET ROLE the lookup must see what the role sees: stay on the primary.
  // Engines without a second connection (SQLite) use the primary too.
  if (state.activeRole || !engineCaps(state.activeConfig?.engine).sideband) {
    return ipc.query.run(sql, params, { internal: true });
  }
  return ipc.query.sideband(sql, params, { timeoutMs: LOOKUP_TIMEOUT_MS });
}

/** Counts for each request (null = the lookup failed, e.g. no SELECT privilege). */
export async function fetchIncomingCounts(
  requests: readonly IncomingCountRequest[],
): Promise<Array<IncomingCount | null>> {
  const gen = connectionGen();
  const now = Date.now();
  const keyOf = (r: IncomingCountRequest) => requestsKey([r]);
  const out: Array<IncomingCount | null | undefined> = requests.map((r) => {
    const hit = countCache.get(keyOf(r));
    return hit && hit.gen === gen && now - hit.at < TTL_MS ? hit.value : undefined;
  });
  const missing = requests.filter((_, i) => out[i] === undefined);
  if (missing.length > 0) {
    // One statement for all; if it fails (a table we can't read), fall back
    // to per-request lookups so one forbidden table doesn't blank the rest.
    const run = async (rs: IncomingCountRequest[]) => {
      const { sql, params } = buildIncomingCountSql(rs, currentDialect());
      const res = await lookup(sql, params);
      return parseIncomingCounts(res.rows[0] ?? [], rs.length);
    };
    let fetched: Array<IncomingCount | null>;
    try {
      fetched = await run(missing);
    } catch {
      fetched = await Promise.all(
        missing.map((r) =>
          run([r]).then(
            (x) => x[0] ?? null,
            () => null,
          ),
        ),
      );
    }
    missing.forEach((r, i) => {
      const value = fetched[i] ?? null;
      countCache.set(keyOf(r), { at: now, gen, value });
      out[requests.indexOf(r)] = value;
    });
  }
  return out.map((v) => v ?? null);
}

/** Counts keyed by FK group key; entries appear as they arrive. */
export function useIncomingCounts(
  requests: readonly IncomingCountRequest[],
): ReadonlyMap<string, IncomingCount | null> {
  const key = requestsKey(requests);
  const [counts, setCounts] = useState<ReadonlyMap<string, IncomingCount | null>>(new Map());
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` identifies `requests`
  useEffect(() => {
    const clear = () => setCounts((prev) => (prev.size === 0 ? prev : new Map()));
    if (requests.length === 0) {
      clear();
      return;
    }
    let cancelled = false;
    clear();
    void fetchIncomingCounts(requests).then((res) => {
      if (cancelled) return;
      setCounts(new Map(requests.map((r, i) => [r.group.key, res[i] ?? null] as const)));
    });
    return () => {
      cancelled = true;
    };
  }, [key]);
  return counts;
}

export type PeekResult =
  | { status: 'ok'; columns: ColumnMeta[]; row: unknown[] }
  | { status: 'missing' }
  | { status: 'error'; message: string };

/** The referenced row for an FK peek. */
export async function fetchPeekRow(
  refSchema: string,
  refTable: string,
  match: FkLookup,
): Promise<PeekResult> {
  const { sql, params } = buildPeekSql(refSchema, refTable, match, currentDialect());
  const cacheKey = `${sql}\n${params.join('\u0000')}`;
  const gen = connectionGen();
  const hit = peekCache.get(cacheKey);
  if (hit && hit.gen === gen && Date.now() - hit.at < TTL_MS) return hit.value;
  let value: PeekResult;
  try {
    const res = await lookup(sql, params);
    value = res.rows[0]
      ? { status: 'ok', columns: res.columns, row: res.rows[0] }
      : { status: 'missing' };
  } catch (err) {
    value = { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
  if (value.status !== 'error') peekCache.set(cacheKey, { at: Date.now(), gen, value });
  return value;
}

/** Peek state for a lookup (undefined while loading). */
export function usePeekRow(
  refSchema: string | null,
  refTable: string | null,
  match: FkLookup | null,
): PeekResult | undefined {
  const [result, setResult] = useState<PeekResult | undefined>(undefined);
  const key = useMemo(
    () =>
      refSchema && refTable && match
        ? `${refSchema}.${refTable}:${match.match.map((m) => `${m.column}=${m.value}`).join('&')}`
        : null,
    [refSchema, refTable, match],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` identifies the lookup
  useEffect(() => {
    setResult(undefined);
    if (!key || !refSchema || !refTable || !match) return;
    let cancelled = false;
    void fetchPeekRow(refSchema, refTable, match).then((r) => {
      if (!cancelled) setResult(r);
    });
    return () => {
      cancelled = true;
    };
  }, [key]);
  return result;
}

/** Test hook: forget cached lookups. */
export function clearFkLookupCache(): void {
  countCache.clear();
  peekCache.clear();
}
