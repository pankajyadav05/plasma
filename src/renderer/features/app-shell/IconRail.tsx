import { cn } from '@/lib/cn';
import { type CanvasMode, useSession } from '@/stores/session';
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
  const dbLabel = activeConfig?.database || activeConfig?.name || 'Database';

  const top: RailItem[] = [
    {
      mode: 'database',
      icon: <Database />,
      label: dbLabel,
      title: `${activeConfig?.name ?? 'Database'} — tables and queries`,
    },
    ...(engine === 'postgres'
      ? [
          { mode: 'history' as const, icon: <Clock />, label: 'History', title: 'Query history' },
          {
            mode: 'monitor' as const,
            icon: <Activity />,
            label: 'Activity',
            title: 'Live activity (pg_stat_activity)',
          },
        ]
      : []),
  ];

  return (
    <nav
      className="chrome flex w-[76px] shrink-0 flex-col items-center gap-1 border-r hairline py-2"
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
        'flex w-[66px] flex-col items-center gap-1 rounded-[10px] px-1 pb-1.5 pt-2 transition-colors',
        '[&_svg]:h-[19px] [&_svg]:w-[19px]',
        active
          ? 'raised text-primary'
          : 'text-foreground/60 hover:bg-[var(--glass-fill-hover)] hover:text-foreground',
      )}
    >
      {item.icon}
      <span
        className={cn(
          'w-full truncate text-center text-[10px] leading-3',
          active ? 'font-semibold text-foreground' : 'font-medium',
        )}
      >
        {item.label}
      </span>
    </button>
  );
}
