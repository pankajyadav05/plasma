import { Clock, Cog, Database } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useSession, type CanvasMode } from '@/stores/session';

interface RailItem {
  mode: CanvasMode;
  icon: React.ReactNode;
  label: string;
}

const TOP_ITEMS: RailItem[] = [
  { mode: 'database', icon: <Database className="h-[18px] w-[18px]" />, label: 'Database' },
  { mode: 'history', icon: <Clock className="h-[18px] w-[18px]" />, label: 'History' },
];

const BOTTOM_ITEMS: RailItem[] = [
  { mode: 'settings', icon: <Cog className="h-[18px] w-[18px]" />, label: 'Settings' },
];

/**
 * Left-most navigation rail (48px). Switches what the main canvas
 * renders — Database (entity browser), SQL Editor, History, Settings.
 * The sidebar stays visible across modes.
 */
export function IconRail() {
  const canvasMode = useSession((s) => s.canvasMode);
  const setCanvasMode = useSession((s) => s.setCanvasMode);

  return (
    <nav
      className="flex w-12 shrink-0 flex-col items-center border-r border-border bg-sidebar py-2"
      aria-label="Navigation"
    >
      <Group items={TOP_ITEMS} active={canvasMode} onPick={setCanvasMode} />
      <div className="flex-1" />
      <Group items={BOTTOM_ITEMS} active={canvasMode} onPick={setCanvasMode} />
    </nav>
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
