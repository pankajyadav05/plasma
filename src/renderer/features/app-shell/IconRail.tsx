import { cn } from '@/lib/cn';
import { databaseLabel } from '@/lib/engine-meta';
import { type CanvasMode, useSession } from '@/stores/session';
import { engineCaps } from '@shared/sql-dialect';
import { Activity, Clock, Cog, Database } from 'lucide-react';

interface RailItem {
  mode: CanvasMode;
  icon: React.ReactNode;
  label: string;
  title: string;
}

/**
 * Workspace rail (TablePlus's far-left column): a labelled tile per
 * workspace. The database tile is captioned with the database name;
 * History and Activity are Postgres-only workspaces (history records SQL,
 * the monitor polls pg_stat_activity), so Redis / OpenSearch show only
 * the database tile. Settings sits at the bottom.
 */
export function IconRail() {
  const canvasMode = useSession((s) => s.canvasMode);
  const setCanvasMode = useSession((s) => s.setCanvasMode);
  const activeConfig = useSession((s) => s.activeConfig);
  const engine = activeConfig?.engine ?? 'postgres';
  const caps = engineCaps(engine);
  const redisDb = useSession((s) => s.redisDb);
  const dbLabel =
    (engine === 'redis' ? String(redisDb ?? 0) : activeConfig && databaseLabel(activeConfig)) ||
    activeConfig?.name ||
    'Database';

  const top: RailItem[] = [
    {
      mode: 'database',
      icon: <Database className="text-[var(--icon-db)]" />,
      label: dbLabel,
      title: `${activeConfig?.name ?? 'Database'} — tables and queries`,
    },
    ...(caps.history
      ? [{ mode: 'history' as const, icon: <Clock />, label: 'History', title: 'Query history' }]
      : []),
    ...(caps.activity || engine === 'redis' || engine === 'opensearch'
      ? [
          {
            mode: 'monitor' as const,
            icon: <Activity />,
            label: 'Health',
            title: 'Health advisor — activity, indexes, vacuum, memory, cluster',
          },
        ]
      : []),
  ];

  return (
    <nav
      className="flex w-[79px] shrink-0 flex-col items-center gap-1 bg-[var(--wb-window)] py-2"
      aria-label="Workspaces"
    >
      {top.map((it) => (
        <Tile key={it.mode} item={it} active={canvasMode === it.mode} onPick={setCanvasMode} />
      ))}
      <div className="flex-1" />
      <Tile
        item={{ mode: 'settings', icon: <Cog />, label: 'Settings', title: 'Settings' }}
        active={canvasMode === 'settings'}
        onPick={setCanvasMode}
      />
    </nav>
  );
}

function Tile({
  item,
  active,
  onPick,
}: {
  item: RailItem;
  active: boolean;
  onPick: (m: CanvasMode) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onPick(item.mode)}
      aria-label={item.title}
      aria-current={active || undefined}
      title={item.title}
      className={cn(
        'flex w-[71px] flex-col items-center gap-[5px] rounded-[8px] px-1 pb-2 pt-2.5 transition-colors',
        '[&_svg]:h-[22px] [&_svg]:w-[22px] [&_svg]:stroke-[1.6]',
        active
          ? 'bg-[color-mix(in_oklch,var(--wb-window)_88%,var(--wb-text))] text-[var(--wb-text)]'
          : 'text-[var(--wb-text-2)] hover:bg-[color-mix(in_oklch,var(--wb-window)_94%,var(--wb-text))] hover:text-[var(--wb-text)]',
      )}
    >
      {item.icon}
      <span
        className={cn(
          'w-full truncate text-center text-[11px] font-medium leading-[13px]',
          active ? 'text-[var(--wb-text)]' : 'text-[var(--wb-text-2)]',
        )}
      >
        {item.label}
      </span>
    </button>
  );
}
