import { useCallback } from 'react';
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';

/**
 * Draggable vertical rule between the sidebar and the main area.
 *
 * Click-and-drag to resize the sidebar. Width updates optimistically
 * on pointermove; persistence to settings happens once on pointerup so
 * we don't spam IPC during the drag.
 *
 * Visual: 4px-wide invisible hit area centered over a 1px line. On
 * hover/active, the line thickens and turns accent.
 */
export function SidebarResizer() {
  const sidebarWidth = useSession((s) => s.settings.sidebarWidth);
  const setSidebarWidth = useSession((s) => s.setSidebarWidth);
  const collapsed = useSession((s) => s.settings.sidebarCollapsed);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (collapsed) return;
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = sidebarWidth;
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);

      const onMove = (ev: PointerEvent) => {
        const next = startWidth + (ev.clientX - startX);
        setSidebarWidth(next);
      };

      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        // Persist the final width once. Read fresh from the store so we
        // write the clamped value (not whatever the last pointermove was).
        const finalWidth = useSession.getState().settings.sidebarWidth;
        ipc.settings.set({ sidebarWidth: finalWidth }).catch((err) => {
          // biome-ignore lint/suspicious/noConsole: diagnostic
          console.error('[plasma] persist sidebarWidth failed', err);
        });
      };

      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [collapsed, sidebarWidth, setSidebarWidth],
  );

  if (collapsed) return null;

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={sidebarWidth}
      aria-valuemin={200}
      aria-valuemax={520}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onKeyDown={(e) => {
        // Keyboard resize in 8px increments
        if (e.key === 'ArrowLeft') {
          setSidebarWidth(sidebarWidth - 8);
          void ipc.settings.set({
            sidebarWidth: useSession.getState().settings.sidebarWidth,
          });
        } else if (e.key === 'ArrowRight') {
          setSidebarWidth(sidebarWidth + 8);
          void ipc.settings.set({
            sidebarWidth: useSession.getState().settings.sidebarWidth,
          });
        }
      }}
      className="group/resizer relative z-20 -ml-[3px] flex h-full w-[6px] shrink-0 cursor-col-resize items-stretch justify-center"
    >
      <div className="h-full w-px bg-rule transition-all duration-instant group-hover/resizer:w-0.5 group-hover/resizer:bg-accent group-active/resizer:bg-accent" />
    </div>
  );
}
