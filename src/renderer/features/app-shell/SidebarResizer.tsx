import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import { useCallback } from 'react';

type Side = 'left' | 'right';

const LIMITS: Record<Side, { min: number; max: number }> = {
  left: { min: 200, max: 520 },
  right: { min: 240, max: 720 },
};

/**
 * Draggable vertical rule between a sidebar and the main area — the left
 * sidebar (Items / Queries / History) or the right one (Details /
 * Assistant).
 *
 * Click-and-drag to resize. Width updates optimistically on pointermove;
 * persistence to settings happens once on pointerup so we don't spam IPC
 * during the drag. The right sidebar grows as the pointer moves left.
 *
 * Visual: 6px-wide invisible hit area centred over the sidebar's 1px
 * separator. On hover/active a 1px accent line is drawn over it.
 */
export function SidebarResizer({ side = 'left' }: { side?: Side }) {
  const isLeft = side === 'left';
  const width = useSession((s) =>
    isLeft ? s.settings.sidebarWidth : s.settings.rightSidebarWidth,
  );
  const collapsed = useSession((s) =>
    isLeft ? s.settings.sidebarCollapsed : s.rightPanelMode === null,
  );
  const setWidth = useSession((s) => (isLeft ? s.setSidebarWidth : s.setRightSidebarWidth));
  const settingKey = isLeft ? 'sidebarWidth' : 'rightSidebarWidth';
  const direction = isLeft ? 1 : -1;
  const { min, max } = LIMITS[side];

  const persist = useCallback(() => {
    // Read fresh from the store so we write the clamped value (not
    // whatever the last pointermove produced).
    const s = useSession.getState().settings;
    const finalWidth = isLeft ? s.sidebarWidth : s.rightSidebarWidth;
    ipc.settings.set({ [settingKey]: finalWidth }).catch((err) => {
      // biome-ignore lint/suspicious/noConsole: diagnostic
      console.error(`[plasma] persist ${settingKey} failed`, err);
    });
  }, [isLeft, settingKey]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (collapsed) return;
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = width;
      e.currentTarget.setPointerCapture(e.pointerId);

      const onMove = (ev: PointerEvent) => {
        setWidth(startWidth + direction * (ev.clientX - startX));
      };

      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        persist();
      };

      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [collapsed, width, setWidth, direction, persist],
  );

  if (collapsed) return null;

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={isLeft ? 'Resize sidebar' : 'Resize right sidebar'}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onKeyDown={(e) => {
        // Keyboard resize in 8px steps; arrows move the separator itself.
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          const step = e.key === 'ArrowRight' ? 8 : -8;
          setWidth(width + direction * step);
          persist();
        }
      }}
      className="group/resizer relative z-20 -mx-[3px] flex h-full w-[6px] shrink-0 cursor-col-resize items-stretch justify-center outline-none"
    >
      {/* The 1px pane separator is the sidebar's own border; this line only
          appears on hover / drag, drawn on top of it. */}
      <div className="h-full w-px bg-transparent transition-colors duration-instant group-hover/resizer:bg-[var(--wb-accent)] group-focus-visible/resizer:bg-[var(--wb-accent)] group-active/resizer:bg-[var(--wb-accent)]" />
    </div>
  );
}
