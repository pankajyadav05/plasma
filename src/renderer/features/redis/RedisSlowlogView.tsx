import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { type DataColumn, DataTable } from '@/components/ui/data-table';
import { EmptyState, ViewFooter, ViewTitle, ViewToolbar } from '@/components/ui/view-parts';
import { IconButton, Pill } from '@/components/ui/workbench';
import { cleanIpcError } from '@/lib/errors';
import { ipc } from '@/lib/ipc';
import { useActiveTab } from '@/stores/session';
import { useWorkbench } from '@/stores/workbench';
import type { RedisSlowlogEntry } from '@shared/protocol';
import { Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRedisWriteGate } from './use-redis-write';

const SLOWLOG_LIMIT = 128;

/**
 * SLOWLOG GET viewer — grid of recent slow commands. Sorted by Redis
 * (newest first); we just render. Selecting a row publishes the full
 * argv (and client) to the right sidebar's Details pane.
 */
export function RedisSlowlogView() {
  // S1: SLOWLOG RESET is a write — only with edit mode on a writable connection.
  const { canWrite } = useRedisWriteGate();
  const tabId = useActiveTab()?.id ?? null;
  const [entries, setEntries] = useState<RedisSlowlogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const e = await ipc.redis.slowlog(SLOWLOG_LIMIT);
      setEntries(e);
      setLoadedAt(new Date());
    } catch (err) {
      setError(cleanIpcError(err instanceof Error ? err.message : String(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // New data → drop the selection and whatever Details was showing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on every reload
  useEffect(() => {
    setSelected(null);
    useWorkbench.getState().setInspectedRow(null);
  }, [entries]);

  // Clear the Details pane when leaving the view.
  useEffect(() => () => useWorkbench.getState().setInspectedRow(null), []);

  const reset = async () => {
    setError(null);
    try {
      await ipc.redis.command(['SLOWLOG', 'RESET']);
      await load();
    } catch (err) {
      setError(cleanIpcError(err instanceof Error ? err.message : String(err)));
    }
  };

  const onSelect = (e: RedisSlowlogEntry, index: number) => {
    setSelected(index);
    if (!tabId) return;
    useWorkbench.getState().setInspectedRow({
      tabId,
      rowNumber: index + 1,
      columnIndex: 3,
      columns: [
        { name: 'id', dataTypeID: 0, dataTypeName: 'integer' },
        { name: 'time', dataTypeID: 0, dataTypeName: 'timestamp' },
        { name: 'duration_us', dataTypeID: 0, dataTypeName: 'microseconds' },
        { name: 'command', dataTypeID: 0, dataTypeName: 'argv' },
        { name: 'argv', dataTypeID: 0, dataTypeName: `${e.argv.length} args` },
        { name: 'client', dataTypeID: 0, dataTypeName: 'addr' },
        { name: 'client_name', dataTypeID: 0, dataTypeName: 'name' },
      ],
      row: [
        e.id,
        fmtTimestamp(e.timestamp),
        e.durationUs,
        e.argv.join(' '),
        e.argv,
        e.client,
        e.clientName,
      ],
    });
  };

  const columns = useMemo<DataColumn<RedisSlowlogEntry>[]>(
    () => [
      { key: 'id', label: 'id', align: 'right', width: 72, render: (e) => e.id },
      {
        key: 'time',
        label: 'time',
        width: 170,
        render: (e) => fmtTimestamp(e.timestamp),
      },
      {
        key: 'duration',
        label: 'duration µs',
        title: 'Execution time in microseconds',
        align: 'right',
        width: 120,
        render: (e) => e.durationUs.toLocaleString(),
        titleOf: (e) => fmtDuration(e.durationUs),
      },
      {
        key: 'client',
        label: 'client',
        width: 170,
        render: (e) => e.clientName || e.client || null,
      },
      {
        key: 'command',
        label: 'command',
        render: (e) =>
          e.argv.length === 0
            ? '(empty)'
            : e.argv.slice(0, 8).join(' ') + (e.argv.length > 8 ? ' …' : ''),
        titleOf: (e) => e.argv.join(' '),
      },
    ],
    [],
  );

  const slowest = entries.reduce((m, e) => Math.max(m, e.durationUs), 0);

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--wb-content)]">
      <ViewToolbar>
        <ViewTitle
          title="Slowlog"
          meta={`${entries.length.toLocaleString()} ${entries.length === 1 ? 'entry' : 'entries'}`}
        />
        <div className="flex-1" />
        <IconButton label="Refresh slowlog" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        </IconButton>
        {canWrite && (
          <Pill
            onClick={() => setConfirmReset(true)}
            disabled={loading || entries.length === 0}
            className="text-destructive"
          >
            Reset…
          </Pill>
        )}
      </ViewToolbar>

      {error && (
        <div
          role="alert"
          className="shrink-0 border-b border-[var(--wb-separator)] px-3 py-1.5 text-[13px] text-destructive"
        >
          {error}
        </div>
      )}

      {entries.length === 0 ? (
        loading ? (
          <EmptyState title="Loading slowlog…" />
        ) : (
          !error && (
            <EmptyState
              title="No slow commands logged"
              hint="Commands slower than slowlog-log-slower-than (CONFIG) show up here. The log is cleared on restart."
            />
          )
        )
      ) : (
        <DataTable
          ariaLabel="Slowlog entries"
          columns={columns}
          rows={entries}
          rowKey={(e) => String(e.id)}
          selectedIndex={selected}
          onSelect={onSelect}
        />
      )}

      <ViewFooter>
        <span className="tabular-nums">
          {entries.length.toLocaleString()} {entries.length === 1 ? 'entry' : 'entries'}
        </span>
        {entries.length > 0 && (
          <span className="tabular-nums">· slowest {fmtDuration(slowest)}</span>
        )}
        <div className="flex-1" />
        <span className="text-[12px] text-[var(--wb-text-3)]">
          SLOWLOG GET {SLOWLOG_LIMIT}
          {loadedAt && ` · ${loadedAt.toLocaleTimeString()}`}
        </span>
      </ViewFooter>

      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title="Reset slowlog?"
        description="SLOWLOG RESET discards every logged entry on the server. This cannot be undone."
        confirmLabel="Reset"
        variant="destructive"
        onConfirm={() => void reset()}
      />
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
