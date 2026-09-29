import { type DataColumn, DataTable } from '@/components/ui/data-table';
import {
  EmptyState,
  SectionHeading,
  StatTile,
  ViewFooter,
  ViewTitle,
  ViewToolbar,
} from '@/components/ui/view-parts';
import { IconButton, Pill } from '@/components/ui/workbench';
import { useSession } from '@/stores/session';
import type { RedisOverview } from '@shared/protocol';
import { Activity, Clock, Loader2, RefreshCw, Terminal } from 'lucide-react';
import { useMemo } from 'react';

type KeyspaceRow = RedisOverview['keyspace'][number];

const KEYSPACE_COLUMNS: DataColumn<KeyspaceRow>[] = [
  { key: 'db', label: 'Database', width: 120, render: (r) => `db${r.db}` },
  {
    key: 'keys',
    label: 'Keys',
    align: 'right',
    width: 120,
    render: (r) => r.keys.toLocaleString(),
  },
  {
    key: 'expires',
    label: 'With TTL',
    align: 'right',
    width: 120,
    render: (r) => r.expires.toLocaleString(),
  },
  {
    key: 'ratio',
    label: 'TTL share',
    align: 'right',
    width: 110,
    render: (r) => (r.keys > 0 ? `${((r.expires / r.keys) * 100).toFixed(1)}%` : '—'),
  },
  { key: 'rest', label: '', render: () => '' },
];

/**
 * Overview for a connected Redis instance when no key/tool tab is open:
 * a dense row of stat tiles, the per-db keyspace table and neutral
 * quick-action pills (TablePlus-like, no marketing cards).
 */
export function RedisHomeView() {
  const overview = useSession((s) => s.redisOverview);
  const loading = useSession((s) => s.redisLoading);
  const refreshRedisOverview = useSession((s) => s.refreshRedisOverview);
  const openRedisCli = useSession((s) => s.openRedisCli);
  const openRedisAnalyze = useSession((s) => s.openRedisAnalyze);
  const openRedisSlowlog = useSession((s) => s.openRedisSlowlog);

  const totals = useMemo(() => {
    const keys = overview?.keyspace.reduce((a, k) => a + k.keys, 0) ?? 0;
    const expires = overview?.keyspace.reduce((a, k) => a + k.expires, 0) ?? 0;
    return { keys, expires };
  }, [overview]);

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--wb-content)] text-[var(--wb-text)]">
      <ViewToolbar>
        <ViewTitle
          title="Overview"
          meta={overview ? `Redis ${overview.redisVersion}` : 'connecting…'}
        />
        <div className="flex-1" />
        <Pill onClick={openRedisCli}>
          <Terminal />
          Open redis-cli
        </Pill>
        <Pill onClick={openRedisAnalyze}>
          <Activity />
          Memory analyzer
        </Pill>
        <Pill onClick={openRedisSlowlog}>
          <Clock />
          Slowlog
        </Pill>
        <IconButton
          label="Refresh overview"
          onClick={() => void refreshRedisOverview()}
          disabled={loading}
        >
          {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        </IconButton>
      </ViewToolbar>

      {!overview ? (
        <EmptyState
          title={loading ? 'Loading server info…' : 'No server info yet'}
          hint="INFO server / replication / keyspace is read when the connection opens."
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2 px-4 pt-4">
            <StatTile label="Version" value={overview.redisVersion} />
            <StatTile label="Mode" value={overview.mode} />
            <StatTile label="Role" value={overview.role} />
            {overview.usedMemoryHuman && (
              <StatTile
                label="Memory used"
                value={overview.usedMemoryHuman}
                hint={overview.maxMemoryHuman ? `of ${overview.maxMemoryHuman}` : 'no maxmemory limit'}
              />
            )}
            {overview.connectedClients !== undefined && (
              <StatTile label="Clients" value={overview.connectedClients.toLocaleString()} />
            )}
            {overview.uptimeSeconds !== undefined && (
              <StatTile label="Uptime" value={formatUptime(overview.uptimeSeconds)} />
            )}
            <StatTile
              label="Databases"
              value={overview.dbCount.toLocaleString()}
              hint={`${overview.keyspace.length} in use`}
            />
            <StatTile label="Keys" value={totals.keys.toLocaleString()} hint="all databases" />
            <StatTile
              label="Keys with TTL"
              value={totals.expires.toLocaleString()}
              hint={
                totals.keys > 0
                  ? `${((totals.expires / totals.keys) * 100).toFixed(1)}% of keys`
                  : undefined
              }
            />
          </div>

          <SectionHeading>Keyspace</SectionHeading>
          <div className="mx-4 mb-4 overflow-hidden rounded-[6px] border border-[var(--grid-line)]">
            <DataTable
              ariaLabel="Keyspace per database"
              columns={KEYSPACE_COLUMNS}
              rows={overview.keyspace}
              rowKey={(r) => `db${r.db}`}
              stripeFill={false}
              empty="No keys in any database"
            />
          </div>
        </div>
      )}

      <ViewFooter>
        <span className="truncate">
          {overview
            ? `${overview.keyspace.length} ${overview.keyspace.length === 1 ? 'database' : 'databases'} · ${totals.keys.toLocaleString()} keys`
            : '—'}
        </span>
        <div className="flex-1" />
        <span className="truncate text-[12px] text-[var(--wb-text-3)]">
          Browse and filter keys in the sidebar
        </span>
      </ViewFooter>
    </main>
  );
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
