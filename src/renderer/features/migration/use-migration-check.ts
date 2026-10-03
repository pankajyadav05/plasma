import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import { LOCK_CONTEXT_SQL, type LockContext, parseLockContext } from '@shared/pg-lock-preview';
import { type MigrationCheck, checkMigration } from '@shared/pg-migration-check';
import { useCallback, useEffect, useMemo, useState } from 'react';

const CONTEXT_TIMEOUT_MS = 5000;

/** Live lock context (rows, size, sessions) for relation names, on the aux connection. */
export async function fetchLockContext(names: string[]): Promise<Map<string, LockContext>> {
  const res = await ipc.query.sideband(LOCK_CONTEXT_SQL, [names], {
    timeoutMs: CONTEXT_TIMEOUT_MS,
  });
  const rows = res.rows.map((r) =>
    Object.fromEntries(res.columns.map((c, i) => [c.name, r[i]])),
  ) as Record<string, unknown>[];
  return parseLockContext(rows);
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export interface MigrationCheckState {
  check: MigrationCheck;
  ctx: Map<string, LockContext> | undefined;
  loading: boolean;
  /** Live lookup failed (the static analysis still shows). */
  contextError: string | null;
  refresh: () => void;
}

/**
 * Lint + lock preview for `sql`. Static analysis is immediate; the live
 * context (aux connection, read-only, short timeout) follows when the set
 * of target tables changes, and never blocks the panel.
 */
export function useMigrationCheck(
  sql: string,
  opts: { inTransaction?: boolean; live?: boolean } = {},
): MigrationCheckState {
  const enabled = useSession((s) => s.settings.migrationLintEnabled) !== false;
  const minSeverity = useSession((s) => s.settings.migrationLintMinSeverity) ?? 'info';
  const muted = useSession((s) => s.settings.migrationLintMuted);
  const serverVersion = useSession((s) => s.serverVersion);
  const engine = useSession((s) => s.activeConfig?.engine ?? 'postgres');
  const connected = useSession((s) => s.connectionState) === 'connected';
  const text = useDebounced(sql, 250);
  const [ctx, setCtx] = useState<Map<string, LockContext> | undefined>();
  const [loading, setLoading] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  const mutedKey = (muted ?? []).join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: mutedKey stands for muted
  const base = useMemo(
    () => ({
      enabled,
      minSeverity,
      muted: muted ?? [],
      ...(opts.inTransaction ? { inTransaction: true } : {}),
    }),
    [enabled, minSeverity, mutedKey, opts.inTransaction],
  );

  const stat = useMemo(
    () => checkMigration(text, base, undefined, serverVersion),
    [text, base, serverVersion],
  );
  const namesKey = stat.names.join('\n');
  const wantLive =
    enabled && opts.live !== false && connected && engine === 'postgres' && stat.names.length > 0;

  // biome-ignore lint/correctness/useExhaustiveDependencies: namesKey stands for stat.names
  useEffect(() => {
    if (!wantLive) {
      setCtx(undefined);
      setLoading(false);
      setContextError(null);
      return;
    }
    let live = true;
    setLoading(true);
    fetchLockContext(stat.names)
      .then((m) => {
        if (!live) return;
        setCtx(m);
        setContextError(null);
      })
      .catch((err) => {
        if (!live) return;
        setCtx(undefined);
        setContextError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [wantLive, namesKey, tick]);

  const check = useMemo(
    () => (ctx ? checkMigration(text, base, ctx, serverVersion) : stat),
    [ctx, text, base, serverVersion, stat],
  );
  return { check, ctx, loading, contextError, refresh };
}
