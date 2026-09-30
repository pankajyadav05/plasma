import { type DataColumn, DataTable } from '@/components/ui/data-table';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  EmptyState,
  SectionHeading,
  StatTile,
  ViewFooter,
  ViewTitle,
  ViewToolbar,
} from '@/components/ui/view-parts';
import { IconButton, MenuItem, Pill, Segmented } from '@/components/ui/workbench';
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import type { OsAlias, OsIlmPolicy, OsIndex } from '@shared/protocol';
import { Loader2, Plus, RefreshCw, SquareTerminal, Terminal, Timer } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { NodesView, ShardsView, SnapshotsView, TasksView, TemplatesView } from './OsClusterViews';
import { capitalise, fmtBytes, healthTone } from './os-format';
import { OsBadge as Badge, errMessage as errText } from './os-parts';
import { useOsStore } from './os-store';
import { useOsWriteAccess } from './os-write';

type HomeSection = 'overview' | 'nodes' | 'shards' | 'tasks' | 'snapshots' | 'templates';

const REFRESH_CHOICES = [0, 5_000, 15_000, 30_000, 60_000] as const;

const INDEX_COLUMNS: DataColumn<OsIndex>[] = [
  { key: 'index', label: 'Index', width: 220, render: (r) => r.index, titleOf: (r) => r.index },
  {
    key: 'health',
    label: 'Health',
    width: 76,
    sans: true,
    render: (r) => <Badge tone={healthTone(r.health)}>{r.health}</Badge>,
  },
  { key: 'status', label: 'Status', width: 64, render: (r) => r.status },
  {
    key: 'docs',
    label: 'Docs',
    align: 'right',
    width: 90,
    render: (r) => r.docsCount.toLocaleString(),
  },
  {
    key: 'deleted',
    label: 'Deleted',
    align: 'right',
    width: 72,
    render: (r) => r.docsDeleted.toLocaleString(),
  },
  {
    key: 'size',
    label: 'Size',
    align: 'right',
    width: 84,
    render: (r) => fmtBytes(r.storeBytes),
  },
  {
    key: 'pri',
    label: 'Pri',
    title: 'Primary shards',
    align: 'right',
    width: 44,
    render: (r) => r.primaries,
  },
  {
    key: 'rep',
    label: 'Rep',
    title: 'Replicas',
    align: 'right',
    width: 44,
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
    render: (r) => (r.isWriteIndex ? <Badge>Write</Badge> : ''),
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
 * OpenSearch home — dense cluster overview (stat tiles, indices, aliases,
 * lifecycle policies) plus Nodes / Shards / Tasks / Snapshots /
 * Templates views (O15/O17). The overview can auto-refresh and shows
 * when it was loaded (S3).
 */
export function OsHomeView() {
  const overview = useSession((s) => s.osOverview);
  const loading = useSession((s) => s.osLoading);
  const refreshOverview = useSession((s) => s.refreshOsOverview);
  const openOsSql = useSession((s) => s.openOsSql);
  const openOsConsole = useSession((s) => s.openOsConsole);
  const openNewIndex = useSession((s) => s.openOsNewIndex);
  const refreshMs = useOsStore((s) => s.overviewRefreshMs);
  const setRefreshMs = useOsStore((s) => s.setOverviewRefreshMs);
  const loadedAt = useOsStore((s) => s.overviewLoadedAt);
  const access = useOsWriteAccess();
  const [section, setSection] = useState<HomeSection>('overview');
  const [refreshMenu, setRefreshMenu] = useState(false);

  // S3: stamp each overview load and optionally poll it.
  useEffect(() => {
    if (overview) useOsStore.getState().markOverviewLoaded();
  }, [overview]);
  useEffect(() => {
    if (!refreshMs) return;
    const t = setInterval(() => {
      if (!useSession.getState().osLoading) void useSession.getState().refreshOsOverview();
    }, refreshMs);
    return () => clearInterval(t);
  }, [refreshMs]);

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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--wb-content)]">
      <ViewToolbar className="min-w-0 overflow-hidden">
        <ViewTitle
          title={overview.clusterName}
          meta={`${capitalise(overview.distribution)} ${overview.version}`}
        />
        <Badge tone={healthTone(overview.health)}>{overview.health}</Badge>
        <div className="flex-1" />
        <Pill onClick={openOsConsole} title="Dev Tools console">
          <Terminal />
          Console
        </Pill>
        <Pill onClick={openOsSql}>
          <SquareTerminal />
          SQL
        </Pill>
        <Pill
          onClick={openNewIndex}
          disabled={!access.canWrite}
          title={access.reason ?? 'Create an index'}
        >
          <Plus />
          New index
        </Pill>
      </ViewToolbar>

      <div className="flex shrink-0 items-center overflow-x-auto px-4 pb-2 pt-3">
        <Segmented<HomeSection>
          ariaLabel="Cluster section"
          value={section}
          onChange={setSection}
          options={[
            { value: 'overview', label: 'Overview' },
            { value: 'nodes', label: 'Nodes' },
            { value: 'shards', label: 'Shards' },
            { value: 'tasks', label: 'Tasks' },
            { value: 'snapshots', label: 'Snapshots' },
            { value: 'templates', label: 'Templates' },
          ]}
        />
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col border-t border-[var(--wb-separator)]">
        {section === 'overview' && <OverviewBody />}
        {section === 'nodes' && <NodesView />}
        {section === 'shards' && <ShardsView />}
        {section === 'tasks' && <TasksView />}
        {section === 'snapshots' && <SnapshotsView />}
        {section === 'templates' && <TemplatesView />}
      </div>

      <ViewFooter className="whitespace-nowrap">
        <span className="min-w-0 truncate">
          {overview.indices.length} {overview.indices.length === 1 ? 'index' : 'indices'}
          {loadedAt ? ` · updated ${new Date(loadedAt).toLocaleTimeString()}` : ''}
        </span>
        <div className="flex-1" />
        <Popover open={refreshMenu} onOpenChange={setRefreshMenu}>
          <PopoverTrigger asChild>
            <IconButton
              variant="plain"
              label={refreshMs ? `Auto-refresh every ${refreshMs / 1000} s` : 'Auto-refresh off'}
              active={refreshMs > 0}
            >
              <Timer />
            </IconButton>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            side="top"
            sideOffset={6}
            className="w-[170px] p-1"
            role="menu"
          >
            {REFRESH_CHOICES.map((ms) => (
              <MenuItem
                key={ms}
                label={ms === 0 ? 'Off' : `Every ${ms / 1000} s`}
                checked={refreshMs === ms}
                onClick={() => {
                  setRefreshMs(ms);
                  setRefreshMenu(false);
                }}
              />
            ))}
          </PopoverContent>
        </Popover>
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

function OverviewBody() {
  const overview = useSession((s) => s.osOverview);
  const openIndex = useSession((s) => s.openOsIndex);
  const [showSystem, setShowSystem] = useState(false);

  const indices = useMemo(
    () =>
      overview
        ? [...overview.indices]
            .filter((i) => showSystem || !i.index.startsWith('.'))
            .sort((a, b) => b.docsCount - a.docsCount)
        : [],
    [overview, showSystem],
  );

  const totals = useMemo(() => {
    let docs = 0;
    let deleted = 0;
    let bytes = 0;
    let primaries = 0;
    let replicaShards = 0;
    let system = 0;
    for (const i of overview?.indices ?? []) {
      docs += i.docsCount;
      deleted += i.docsDeleted;
      bytes += i.storeBytes;
      primaries += i.primaries;
      replicaShards += i.primaries * i.replicas;
      if (i.index.startsWith('.')) system += 1;
    }
    return { docs, deleted, bytes, primaries, replicaShards, system };
  }, [overview]);

  if (!overview) return null;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-4">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-2 px-4 pt-3">
        <StatTile
          label="Cluster"
          value={overview.clusterName}
          hint={capitalise(overview.distribution)}
        />
        <StatTile label="Health" value={overview.health} />
        <StatTile label="Version" value={overview.version} />
        <StatTile label="Nodes" value={overview.nodes.toLocaleString()} />
        <StatTile
          label="Indices"
          value={overview.indices.length.toLocaleString()}
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
          <span className="flex items-center gap-3 text-[12px] text-[var(--wb-text-2)]">
            {totals.system > 0 && (
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={showSystem}
                  onChange={(e) => setShowSystem(e.target.checked)}
                />
                System indices
              </label>
            )}
            <span>
              {indices.length} {indices.length === 1 ? 'index' : 'indices'}
            </span>
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
