import { ViewTitle, ViewToolbar } from '@/components/ui/view-parts';
import { IconButton } from '@/components/ui/workbench';
import { useSession } from '@/stores/session';
import { RefreshCw, X } from 'lucide-react';
import { useState } from 'react';
import { OsHealth } from './OsHealth';
import { PgHealth } from './PgHealth';
import { RedisHealth } from './RedisHealth';

const META = {
  postgres: 'Postgres: activity, queries, indexes, vacuum. Read-only checks on the aux connection.',
  redis: 'Redis: memory, big keys, latency, clients. Sampling uses SCAN.',
  opensearch: 'OpenSearch: cluster health, allocation, disks. Read-only requests.',
} as const;

/**
 * Health advisor (replaces the old Activity monitor). Each check shows a
 * status, the evidence and a recommended action. Fixes only ever appear
 * as Preview SQL (or advice) and never run on their own.
 */
export function HealthCanvas() {
  const setCanvasMode = useSession((s) => s.setCanvasMode);
  const engine = useSession((s) => s.activeConfig?.engine);
  const [refreshKey, setRefreshKey] = useState(0);
  const kind = engine === 'redis' ? 'redis' : engine === 'opensearch' ? 'opensearch' : 'postgres';

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--wb-content)]">
      <ViewToolbar>
        <ViewTitle title="Health" meta={META[kind]} />
        <div className="flex-1" />
        <IconButton
          variant="plain"
          label="Run all checks again"
          onClick={() => setRefreshKey((k) => k + 1)}
        >
          <RefreshCw />
        </IconButton>
        <IconButton
          variant="plain"
          label="Close health"
          title="Close (Esc)"
          onClick={() => setCanvasMode('database')}
        >
          <X />
        </IconButton>
      </ViewToolbar>
      {kind === 'redis' ? (
        <RedisHealth refreshKey={refreshKey} />
      ) : kind === 'opensearch' ? (
        <OsHealth refreshKey={refreshKey} />
      ) : (
        <PgHealth refreshKey={refreshKey} />
      )}
    </main>
  );
}
