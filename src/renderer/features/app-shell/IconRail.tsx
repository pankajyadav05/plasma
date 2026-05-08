import { cn } from '@/lib/cn';
import { kbd } from '@/lib/platform';
import { type CanvasMode, useSession } from '@/stores/session';
import { Activity, Clock, Cog, Database, Search } from 'lucide-react';

interface RailItem {
  mode: CanvasMode;
  icon: React.ReactNode;
  label: string;
}

const TOP_ITEMS: RailItem[] = [
  { mode: 'database', icon: <Database className="h-[18px] w-[18px]" />, label: 'Database' },
  { mode: 'history', icon: <Clock className="h-[18px] w-[18px]" />, label: 'History' },
  { mode: 'monitor', icon: <Activity className="h-[18px] w-[18px]" />, label: 'Live activity' },
];

const BOTTOM_ITEMS: RailItem[] = [
  { mode: 'settings', icon: <Cog className="h-[18px] w-[18px]" />, label: 'Settings' },
];

/**
 * Left-most navigation rail (48px). Switches what the main canvas
 * renders — Database (entity browser), SQL Editor, History, Settings.
 * The sidebar stays visible across modes.
 *
 * Engine awareness: History + Live activity are Postgres-only canvases
 * (history records SQL strings; the monitor polls pg_stat_activity).
 * For redis / opensearch we hide them so the rail doesn't surface
 * dead-end buttons.
 */
export function IconRail() {
  const canvasMode = useSession((s) => s.canvasMode);
  const setCanvasMode = useSession((s) => s.setCanvasMode);
  const togglePalette = useSession((s) => s.togglePalette);
  const engine = useSession((s) => s.activeConfig?.engine ?? 'postgres');

  const topItems =
    engine === 'postgres' ? TOP_ITEMS : TOP_ITEMS.filter((i) => i.mode === 'database');

  return (
    <nav
      className="flex w-12 shrink-0 flex-col items-center border-r border-border bg-sidebar py-2"
      aria-label="Navigation"
    >
      <Group items={topItems} active={canvasMode} onPick={setCanvasMode} />
      <div className="flex-1" />
      <ActionButton
        label={`Command palette (${kbd('K')})`}
        icon={<Search className="h-[18px] w-[18px]" />}
        onClick={togglePalette}
      />
      <Group items={BOTTOM_ITEMS} active={canvasMode} onPick={setCanvasMode} />
    </nav>
  );
}

function ActionButton({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="relative grid h-9 w-9 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {icon}
    </button>
  );
}

function Group({
  items,
  active,
  onPick,
}: {
  items: RailItem[];
  active: CanvasMode;
  onPick: (m: CanvasMode) => void;
}) {
  return (
    <ul className="flex flex-col gap-0.5">
      {items.map((it) => {
        const isActive = active === it.mode;
        return (
          <li key={it.mode}>
            <button
              type="button"
              onClick={() => onPick(it.mode)}
              aria-label={it.label}
              title={it.label}
              aria-current={isActive}
              className={cn(
                'relative grid h-9 w-9 cursor-pointer place-items-center rounded-md transition-colors',
                isActive
                  ? 'bg-accent text-primary'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              {it.icon}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
