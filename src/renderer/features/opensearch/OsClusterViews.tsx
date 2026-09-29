import { type DataColumn, DataTable } from '@/components/ui/data-table';
import { IconButton, Pill } from '@/components/ui/workbench';
import { SidebarSearch } from '@/features/sidebar/sidebar-parts';
import { ipc } from '@/lib/ipc';
import { useWorkbench } from '@/stores/workbench';
import { Loader2, RefreshCw, RotateCcw, Square } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { JsonBody, errMessage } from './os-parts';
import { confirmOsWrite, useOsWriteAccess } from './os-write';

/**
 * Cluster views for the OpenSearch overview (O15 / O17): nodes, shards
 * (with allocation explain), tasks (cancel), snapshots (create /
 * restore), templates and data streams. Each is a `_cat`/REST read in a
 * DataTable; operations go through the write gate (S1).
 */

type Row = Record<string, unknown>;

/** Max rows rendered in one cluster table (the grid isn't virtualised). */
const ROW_CAP = 2000;

function toText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
}

function useRest<T>(path: string | null, pick: (body: unknown) => T) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: pick is a stable module-level mapper per call site
  const load = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    setError(null);
    try {
      const res = await ipc.os.request({ method: 'GET', path });
      if (res.status >= 400) {
        const b = res.body as { error?: { reason?: string } | string };
        throw new Error(
          typeof b.error === 'string' ? b.error : (b.error?.reason ?? `HTTP ${res.status}`),
        );
      }
      setData(pick(res.body));
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, error, loading, reload: load };
}

const asRows = (b: unknown): Row[] => (Array.isArray(b) ? (b as Row[]) : []);

function columnsFor(rows: Row[], widths: Record<string, number> = {}): DataColumn<Row>[] {
  const keys: string[] = [];
  for (const r of rows.slice(0, 50))
    for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
  return keys.map((k, i) => ({
    key: k,
    label: k,
    width: i === keys.length - 1 ? undefined : (widths[k] ?? 120),
    render: (r) => toText(r[k]),
    titleOf: (r) => toText(r[k]) ?? undefined,
  }));
}

function Bar({
  children,
  loading,
  onRefresh,
  filter,
  setFilter,
}: {
  children?: React.ReactNode;
  loading: boolean;
  onRefresh: () => void;
  filter?: string;
  setFilter?: (v: string) => void;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--wb-separator)] px-2.5 text-[12px] text-[var(--wb-text-2)]">
      {setFilter && (
        <div className="w-56">
          <SidebarSearch
            value={filter ?? ''}
            onChange={setFilter}
            placeholder="Filter…"
            ariaLabel="Filter rows"
          />
        </div>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-2 whitespace-nowrap">{children}</div>
      <IconButton label="Refresh" onClick={onRefresh} disabled={loading}>
        {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
      </IconButton>
    </div>
  );
}

function filterRows(rows: Row[], q: string): Row[] {
  const f = q.trim().toLowerCase();
  if (!f) return rows;
  return rows.filter((r) => Object.values(r).some((v) => toText(v)?.toLowerCase().includes(f)));
}

function publish(tabKey: string, row: Row, index: number) {
  const keys = Object.keys(row);
  useWorkbench.getState().setInspectedRow({
    tabId: tabKey,
    rowNumber: index + 1,
    columnIndex: 0,
    columns: keys.map((k) => ({ name: k, dataTypeID: 0, dataTypeName: 'text' })),
    row: keys.map((k) => row[k]),
  });
}

/** Generic `_cat` table with filter + Details publishing. */
function CatTable({
  path,
  label,
  widths,
  actions,
}: {
  path: string;
  label: string;
  widths?: Record<string, number>;
  actions?: (row: Row | undefined, reload: () => void) => React.ReactNode;
}) {
  const { data, error, loading, reload } = useRest(path, asRows);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const rows = useMemo(() => filterRows(data ?? [], filter), [data, filter]);
  const shown = rows.slice(0, ROW_CAP);
  const columns = useMemo(() => columnsFor(data ?? [], widths), [data, widths]);
  useEffect(() => () => useWorkbench.getState().setInspectedRow(null), []);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <Bar loading={loading} onRefresh={() => void reload()} filter={filter} setFilter={setFilter}>
        <span className="tabular-nums">
          {rows.length.toLocaleString()} {label}
          {rows.length > ROW_CAP
            ? ` (first ${ROW_CAP.toLocaleString()} shown — filter to narrow)`
            : ''}
        </span>
        <div className="flex-1" />
        {actions?.(selected !== null ? shown[selected] : undefined, () => void reload())}
      </Bar>
      <DataTable
        ariaLabel={label}
        columns={columns}
        rows={shown}
        rowKey={(_r, i) => String(i)}
        selectedIndex={selected}
        onSelect={(r, i) => {
          setSelected(i);
          publish(`os-cluster:${label}`, r, i);
        }}
        empty={error ?? (data === null ? 'Loading…' : `No ${label}`)}
      />
    </div>
  );
}

export function NodesView() {
  return (
    <CatTable
      label="nodes"
      path="/_cat/nodes?format=json&h=name,ip,node.role,cluster_manager,heap.percent,ram.percent,cpu,load_1m,disk.used_percent,version&s=name"
      widths={{ name: 200, ip: 120, 'node.role': 90 }}
    />
  );
}

export function ShardsView() {
  const [explain, setExplain] = useState<unknown | null>(null);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <CatTable
        label="shards"
        path="/_cat/shards?format=json&h=index,shard,prirep,state,docs,store,node,unassigned.reason&s=index,shard"
        widths={{ index: 220, shard: 60, prirep: 60, state: 110, docs: 90, store: 90, node: 160 }}
        actions={(row) => (
          <Pill
            disabled={!row}
            title="Why is this shard where it is (or unassigned)?"
            onClick={async () => {
              if (!row) return;
              try {
                const res = await ipc.os.request({
                  method: 'POST',
                  path: '/_cluster/allocation/explain',
                  body: JSON.stringify({
                    index: row.index,
                    shard: Number(row.shard),
                    primary: row.prirep === 'p',
                  }),
                });
                setExplain(res.body);
              } catch (err) {
                setExplain({ error: errMessage(err) });
              }
            }}
          >
            Explain allocation
          </Pill>
        )}
      />
      {explain !== null && (
        <div className="flex max-h-[45%] min-h-[120px] flex-col border-t border-[var(--wb-separator)]">
          <div className="flex h-7 shrink-0 items-center px-2.5 text-[12px] text-[var(--wb-text-2)]">
            <span className="flex-1">Allocation explain</span>
            <button
              type="button"
              className="hover:text-[var(--wb-text)]"
              onClick={() => setExplain(null)}
            >
              Close
            </button>
          </div>
          <JsonBody value={explain} />
        </div>
      )}
    </div>
  );
}

interface TaskRow {
  id: string;
  action: string;
  node: string;
  running: string;
  cancellable: boolean;
  description: string;
}

function pickTasks(b: unknown): TaskRow[] {
  const nodes = (b as { nodes?: Record<string, { name?: string; tasks?: Record<string, Row> }> })
    .nodes;
  const out: TaskRow[] = [];
  for (const n of Object.values(nodes ?? {})) {
    for (const [id, t] of Object.entries(n.tasks ?? {})) {
      const ns = Number(t.running_time_in_nanos ?? 0);
      out.push({
        id,
        action: String(t.action ?? ''),
        node: n.name ?? '',
        running: ns >= 1e9 ? `${(ns / 1e9).toFixed(1)} s` : `${Math.round(ns / 1e6)} ms`,
        cancellable: t.cancellable === true,
        description: String(t.description ?? ''),
      });
    }
  }
  return out.sort((a, b) => a.action.localeCompare(b.action));
}

const TASK_COLUMNS: DataColumn<TaskRow>[] = [
  { key: 'id', label: 'Task', width: 220, render: (r) => r.id },
  { key: 'action', label: 'Action', width: 260, render: (r) => r.action, titleOf: (r) => r.action },
  { key: 'node', label: 'Node', width: 140, render: (r) => r.node },
  { key: 'running', label: 'Running', align: 'right', width: 90, render: (r) => r.running },
  { key: 'cancel', label: 'Cancellable', width: 90, render: (r) => (r.cancellable ? 'yes' : 'no') },
  {
    key: 'desc',
    label: 'Description',
    render: (r) => r.description,
    titleOf: (r) => r.description,
  },
];

export function TasksView() {
  const { data, error, loading, reload } = useRest('/_tasks?detailed=true', pickTasks);
  const access = useOsWriteAccess();
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (data ?? []).filter(
      (t) => !f || t.action.toLowerCase().includes(f) || t.description.toLowerCase().includes(f),
    );
  }, [data, filter]);
  const current = selected !== null ? rows[selected] : undefined;

  const cancelTask = async () => {
    if (!current) return;
    const ok = await confirmOsWrite({
      title: 'Cancel task?',
      description: `${current.action} (${current.id}) will be cancelled.`,
      confirmLabel: 'Cancel task',
      destructive: true,
    });
    if (!ok) return;
    try {
      await ipc.os.request({
        method: 'POST',
        path: `/_tasks/${encodeURIComponent(current.id)}/_cancel`,
      });
    } finally {
      void reload();
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <Bar loading={loading} onRefresh={() => void reload()} filter={filter} setFilter={setFilter}>
        <span className="tabular-nums">{rows.length.toLocaleString()} tasks</span>
        <div className="flex-1" />
        <Pill
          disabled={!access.canWrite || !current?.cancellable}
          title={access.reason ?? 'Cancel the selected task'}
          onClick={() => void cancelTask()}
        >
          <Square />
          Cancel task
        </Pill>
      </Bar>
      <DataTable
        ariaLabel="Tasks"
        columns={TASK_COLUMNS}
        rows={rows}
        rowKey={(r) => r.id}
        selectedIndex={selected}
        onSelect={(_, i) => setSelected(i)}
        empty={error ?? (data === null ? 'Loading…' : 'No running tasks')}
      />
    </div>
  );
}

export function SnapshotsView() {
  const repos = useRest('/_snapshot', (b) =>
    Object.entries((b ?? {}) as Record<string, { type?: string }>).map(([name, r]) => ({
      name,
      type: r.type ?? '',
    })),
  );
  const [repo, setRepo] = useState<string | null>(null);
  const access = useOsWriteAccess();
  useEffect(() => {
    if (!repo && repos.data && repos.data.length > 0) setRepo(repos.data[0]!.name);
  }, [repos.data, repo]);
  const snaps = useRest(
    repo ? `/_cat/snapshots/${encodeURIComponent(repo)}?format=json` : null,
    asRows,
  );
  const [selected, setSelected] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const rows = snaps.data ?? [];
  const current = selected !== null ? rows[selected] : undefined;
  const columns = useMemo(() => columnsFor(rows, { id: 220, status: 90 }), [rows]);

  const create = async () => {
    if (!repo) return;
    const name = `snapshot-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
    const ok = await confirmOsWrite({
      title: 'Create snapshot?',
      description: `A snapshot of all indices named ${name} will be written to ${repo}.`,
      confirmLabel: 'Create snapshot',
    });
    if (!ok) return;
    const res = await ipc.os.request({
      method: 'PUT',
      path: `/_snapshot/${encodeURIComponent(repo)}/${name}`,
      body: '{}',
    });
    setNotice(res.status >= 400 ? `Failed: ${JSON.stringify(res.body)}` : `Started ${name}`);
    void snaps.reload();
  };

  const restore = async () => {
    if (!repo || !current) return;
    const id = String(current.id ?? '');
    const ok = await confirmOsWrite({
      title: `Restore ${id}?`,
      description:
        'Indices are restored under a "restored-" prefix so existing indices are not overwritten.',
      confirmLabel: 'Restore',
      destructive: true,
      typeToConfirm: id,
    });
    if (!ok) return;
    const res = await ipc.os.request({
      method: 'POST',
      path: `/_snapshot/${encodeURIComponent(repo)}/${encodeURIComponent(id)}/_restore`,
      body: JSON.stringify({
        indices: '*,-.*',
        rename_pattern: '(.+)',
        rename_replacement: 'restored-$1',
        include_global_state: false,
      }),
    });
    setNotice(
      res.status >= 400 ? `Restore failed: ${JSON.stringify(res.body)}` : `Restoring ${id}…`,
    );
  };

  if (repos.data && repos.data.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-[13px] text-[var(--wb-text-2)]">
        {repos.error ??
          'No snapshot repositories registered. Register one with PUT /_snapshot/<name> in the console.'}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <Bar loading={repos.loading || snaps.loading} onRefresh={() => void snaps.reload()}>
        <span>Repository</span>
        <select
          value={repo ?? ''}
          onChange={(e) => {
            setRepo(e.target.value);
            setSelected(null);
          }}
          aria-label="Snapshot repository"
          className="h-6 rounded-[6px] bg-[var(--wb-field)] px-1.5 font-mono text-[12px] text-[var(--wb-text)] outline-none"
        >
          {(repos.data ?? []).map((r) => (
            <option key={r.name} value={r.name}>
              {r.name} ({r.type})
            </option>
          ))}
        </select>
        <span className="min-w-0 truncate">{notice}</span>
        <div className="flex-1" />
        <Pill
          disabled={!access.canWrite || !repo}
          title={access.reason ?? 'Create snapshot'}
          onClick={() => void create()}
        >
          Create snapshot
        </Pill>
        <Pill
          disabled={!access.canWrite || !current}
          title={access.reason ?? 'Restore the selected snapshot'}
          onClick={() => void restore()}
        >
          <RotateCcw />
          Restore…
        </Pill>
      </Bar>
      <DataTable
        ariaLabel="Snapshots"
        columns={columns}
        rows={rows}
        rowKey={(_r, i) => String(i)}
        selectedIndex={selected}
        onSelect={(_, i) => setSelected(i)}
        empty={
          snaps.error ?? (snaps.data === null ? 'Loading…' : 'No snapshots in this repository')
        }
      />
    </div>
  );
}

interface NamedDoc {
  kind: string;
  name: string;
  patterns: string;
  doc: unknown;
}

const DOC_COLUMNS: DataColumn<NamedDoc>[] = [
  { key: 'kind', label: 'Kind', width: 150, sans: true, render: (r) => r.kind },
  { key: 'name', label: 'Name', width: 260, render: (r) => r.name, titleOf: (r) => r.name },
  {
    key: 'patterns',
    label: 'Patterns / indices',
    render: (r) => r.patterns,
    titleOf: (r) => r.patterns,
  },
];

/** Index templates, component templates, legacy templates and data streams (O15). */
export function TemplatesView() {
  const [rows, setRows] = useState<NamedDoc[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const get = async (path: string) => {
      try {
        const r = await ipc.os.request({ method: 'GET', path });
        return r.status < 400 ? r.body : null;
      } catch {
        return null;
      }
    };
    try {
      const [idx, comp, legacy, ds] = await Promise.all([
        get('/_index_template'),
        get('/_component_template'),
        get('/_template'),
        get('/_data_stream'),
      ]);
      const out: NamedDoc[] = [];
      for (const t of (
        idx as {
          index_templates?: Array<{ name: string; index_template: { index_patterns?: string[] } }>;
        } | null
      )?.index_templates ?? []) {
        out.push({
          kind: 'Index template',
          name: t.name,
          patterns: (t.index_template.index_patterns ?? []).join(', '),
          doc: t.index_template,
        });
      }
      for (const t of (
        comp as {
          component_templates?: Array<{ name: string; component_template: unknown }>;
        } | null
      )?.component_templates ?? []) {
        out.push({
          kind: 'Component template',
          name: t.name,
          patterns: '',
          doc: t.component_template,
        });
      }
      for (const [name, t] of Object.entries(
        (legacy ?? {}) as Record<string, { index_patterns?: string[] }>,
      )) {
        out.push({
          kind: 'Legacy template',
          name,
          patterns: (t.index_patterns ?? []).join(', '),
          doc: t,
        });
      }
      for (const d of (
        ds as {
          data_streams?: Array<{ name: string; indices?: Array<{ index_name: string }> }>;
        } | null
      )?.data_streams ?? []) {
        out.push({
          kind: 'Data stream',
          name: d.name,
          patterns: (d.indices ?? []).map((i) => i.index_name).join(', '),
          doc: d,
        });
      }
      setRows(out);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const current = selected !== null ? rows?.[selected] : undefined;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <Bar loading={loading} onRefresh={() => void load()}>
        <span className="tabular-nums">
          {(rows ?? []).length.toLocaleString()} templates and data streams
        </span>
      </Bar>
      <DataTable
        ariaLabel="Templates and data streams"
        columns={DOC_COLUMNS}
        rows={rows ?? []}
        rowKey={(r) => `${r.kind}:${r.name}`}
        selectedIndex={selected}
        onSelect={(_, i) => setSelected((c) => (c === i ? null : i))}
        empty={error ?? (rows === null ? 'Loading…' : 'No templates or data streams')}
      />
      {current && (
        <div className="flex max-h-[45%] min-h-[120px] flex-col border-t border-[var(--wb-separator)]">
          <JsonBody value={current.doc} />
        </div>
      )}
    </div>
  );
}
