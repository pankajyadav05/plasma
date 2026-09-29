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
import { IconButton, Pill } from '@/components/ui/workbench';
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import type { OsAlias, OsIlmPolicy, OsIndex } from '@shared/protocol';
import { Loader2, Plus, RefreshCw, SquareTerminal } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function healthTone(health: string): 'neutral' | 'warn' | 'danger' {
  const h = health.toLowerCase();
  if (h === 'red') return 'danger';
  if (h === 'yellow') return 'warn';
  return 'neutral';
}

function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^Error invoking remote method '[^']+':\s*/i, '').replace(/^Error:\s*/i, '');
}

const INDEX_COLUMNS: DataColumn<OsIndex>[] = [
  { key: 'index', label: 'Index', width: 260, render: (r) => r.index, titleOf: (r) => r.index },
  {
    key: 'health',
    label: 'Health',
    width: 80,
    sans: true,
    render: (r) => <Badge tone={healthTone(r.health)}>{r.health}</Badge>,
  },
  { key: 'status', label: 'Status', width: 70, render: (r) => r.status },
  {
    key: 'docs',
    label: 'Docs',
    align: 'right',
    width: 100,
    render: (r) => r.docsCount.toLocaleString(),
  },
  {
    key: 'deleted',
    label: 'Deleted',
    align: 'right',
    width: 80,
    render: (r) => r.docsDeleted.toLocaleString(),
  },
  {
    key: 'size',
    label: 'Size',
    align: 'right',
    width: 90,
    render: (r) => fmtBytes(r.storeBytes),
  },
  {
    key: 'pri',
    label: 'Pri',
    title: 'Primary shards',
    align: 'right',
    width: 50,
    render: (r) => r.primaries,
  },
  {
    key: 'rep',
    label: 'Rep',
    title: 'Replicas',
    align: 'right',
    width: 50,
    render: (r) => r.replicas,
  },
  { key: 'uuid', label: 'UUID', render: (r) => r.uuid, titleOf: (r) => r.uuid ?? undefined },
];

const ALIAS_COLUMNS: DataColumn<OsAlias>[] = [
  { key: 'alias', label: 'Alias', width: 220, render: (r) => r.alias, titleOf: (r) => r.alias },
  { key: 'index', label: 'Index', width: 220, render: (r) => r.index, titleOf: (r) => r.index },
  {
    key: 'write',
    label: 'Write',
    width: 70,
    sans: true,
    render: (r) => (r.isWriteIndex ? <Badge>write</Badge> : ''),
  },
  {
    key: 'filter',
    label: 'Filter',
    render: (r) => r.filter,
    titleOf: (r) => r.filter ?? undefined,
  },
];

const ILM_COLUMNS: DataColumn<OsIlmPolicy>[] = [
  { key: 'name', label: 'Policy', width: 260, render: (r) => r.name, titleOf: (r) => r.name },
  {
    key: 'updated',
    label: 'Last updated',
    render: (r) => (r.lastUpdated ? new Date(r.lastUpdated).toLocaleString() : null),
  },
];

/**
 * OpenSearch home — dense cluster overview: stat tiles, then the index
 * list, aliases and lifecycle policies as data grids. Clicking an index
 * row opens its mapping/stats view.
 */
export function OsHomeView() {
  const overview = useSession((s) => s.osOverview);
  const loading = useSession((s) => s.osLoading);
  const refreshOverview = useSession((s) => s.refreshOsOverview);
  const openIndex = useSession((s) => s.openOsIndex);
  const openOsSql = useSession((s) => s.openOsSql);
  const openNewIndex = useSession((s) => s.openOsNewIndex);

  const indices = useMemo(
    () => (overview ? [...overview.indices].sort((a, b) => b.docsCount - a.docsCount) : []),
    [overview],
  );

  const totals = useMemo(() => {
    let docs = 0;
    let deleted = 0;
    let bytes = 0;
    let primaries = 0;
    let replicaShards = 0;
    let system = 0;
    for (const i of indices) {
      docs += i.docsCount;
      deleted += i.docsDeleted;
      bytes += i.storeBytes;
      primaries += i.primaries;
      replicaShards += i.primaries * i.replicas;
      if (i.index.startsWith('.')) system += 1;
    }
    return { docs, deleted, bytes, primaries, replicaShards, system };
  }, [indices]);

  if (!overview) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--wb-content)]">
        <EmptyState
          title={loading ? 'Connecting to cluster…' : 'No cluster overview'}
          action={
            !loading && (
              <Pill onClick={() => void refreshOverview()}>
                <RefreshCw />
                Refresh
              </Pill>
            )
          }
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--wb-content)]">
      <ViewToolbar>
        <ViewTitle
          title={overview.clusterName}
          meta={`${overview.distribution} ${overview.version}`}
        />
        <Badge tone={healthTone(overview.health)}>{overview.health}</Badge>
        <div className="flex-1" />
        <Pill onClick={openOsSql}>
          <SquareTerminal />
          SQL
        </Pill>
        <Pill onClick={openNewIndex}>
          <Plus />
          New index
        </Pill>
      </ViewToolbar>

      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-2 px-4 pt-3">
          <StatTile label="Cluster" value={overview.clusterName} hint={overview.distribution} />
          <StatTile label="Health" value={overview.health} />
          <StatTile label="Version" value={overview.version} />
          <StatTile label="Nodes" value={overview.nodes.toLocaleString()} />
          <StatTile
            label="Indices"
            value={indices.length.toLocaleString()}
            hint={totals.system > 0 ? `${totals.system} system` : undefined}
          />
          <StatTile
            label="Documents"
            value={totals.docs.toLocaleString()}
            hint={totals.deleted > 0 ? `${totals.deleted.toLocaleString()} deleted` : undefined}
          />
          <StatTile label="Store size" value={fmtBytes(totals.bytes)} />
          <StatTile
            label="Shards"
            value={(totals.primaries + totals.replicaShards).toLocaleString()}
            hint={`${totals.primaries} primary · ${totals.replicaShards} replica`}
          />
        </div>

        <SectionHeading
          action={
            <span className="text-[12px] text-[var(--wb-text-2)]">
              {indices.length} {indices.length === 1 ? 'index' : 'indices'}
            </span>
          }
        >
          Indices
        </SectionHeading>
        <DataTable
          ariaLabel="Indices"
          columns={INDEX_COLUMNS}
          rows={indices}
          rowKey={(r) => r.index}
          onSelect={(r) => openIndex(r.index)}
          stripeFill={false}
          empty="No indices"
          className="flex-none border-y border-[var(--wb-separator)]"
        />

        <AliasesSection />
        <IlmSection />
      </div>

      <ViewFooter>
        <span>
          {indices.length} {indices.length === 1 ? 'index' : 'indices'} ·{' '}
          {totals.docs.toLocaleString()} docs · {fmtBytes(totals.bytes)}
        </span>
        <div className="flex-1" />
        <IconButton
          label="Refresh cluster overview"
          onClick={() => void refreshOverview()}
          disabled={loading}
        >
          {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        </IconButton>
      </ViewFooter>
    </div>
  );
}

function AliasesSection() {
  const [aliases, setAliases] = useState<OsAlias[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await ipc.os.aliases();
        if (!cancelled) setAliases(list);
      } catch (err) {
        if (!cancelled) setError(errText(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <SectionHeading
        action={
          aliases && <span className="text-[12px] text-[var(--wb-text-2)]">{aliases.length}</span>
        }
      >
        Aliases
      </SectionHeading>
      <DataTable
        ariaLabel="Aliases"
        columns={ALIAS_COLUMNS}
        rows={aliases ?? []}
        rowKey={(r) => `${r.alias}-${r.index}`}
        stripeFill={false}
        empty={error ?? (aliases === null ? 'Loading…' : 'No aliases declared')}
        className="flex-none border-y border-[var(--wb-separator)]"
      />
    </>
  );
}

function IlmSection() {
  const [policies, setPolicies] = useState<OsIlmPolicy[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await ipc.os.ilm();
        if (!cancelled) setPolicies(list);
      } catch (err) {
        if (!cancelled) setError(errText(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const current = selected !== null ? policies?.[selected] : undefined;

  return (
    <>
      <SectionHeading
        action={
          policies && <span className="text-[12px] text-[var(--wb-text-2)]">{policies.length}</span>
        }
      >
        Lifecycle policies
      </SectionHeading>
      <DataTable
        ariaLabel="Lifecycle policies"
        columns={ILM_COLUMNS}
        rows={policies ?? []}
        rowKey={(r) => r.name}
        selectedIndex={selected}
        onSelect={(_, i) => setSelected((cur) => (cur === i ? null : i))}
        stripeFill={false}
        empty={error ?? (policies === null ? 'Loading…' : 'No ISM / ILM policies installed')}
        className="flex-none border-y border-[var(--wb-separator)]"
      />
      {current && (
        <pre className="max-h-[360px] overflow-auto border-b border-[var(--wb-separator)] bg-[var(--wb-sidebar)] px-4 py-3 font-mono text-[12px] leading-5 text-[var(--wb-text)]">
          {JSON.stringify(current.policy, null, 2)}
        </pre>
      )}
    </>
  );
}
