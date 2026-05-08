import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import { useRef } from 'react';

const MIN_PX = 120;
const MAX_PX = 1200;

/**
 * Horizontal handle between the inline SQL editor and the result grid.
 * Drag updates `settings.editorHeightPx` optimistically; persistence to
 * SQLite fires once on pointerup so we don't hammer disk during a drag.
 *
 * Mirrors the SidebarResizer pattern (pointer-capture + global cursor)
 * so the cursor doesn't reset to default while dragging over Monaco.
 */
export function EditorResizer() {
  const editorHeightPx = useSession((s) => s.settings.editorHeightPx);
  const dragStartY = useRef(0);
  const startHeight = useRef(0);

  const setLocalHeight = (height: number) => {
    useSession.setState((state) => ({
      settings: { ...state.settings, editorHeightPx: height },
    }));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragStartY.current = e.clientY;
    startHeight.current = editorHeightPx;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!(e.target as HTMLElement).hasPointerCapture(e.pointerId)) return;
    const delta = e.clientY - dragStartY.current;
    const next = Math.max(MIN_PX, Math.min(MAX_PX, startHeight.current + delta));
    setLocalHeight(Math.round(next));
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).hasPointerCapture(e.pointerId)) {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    }
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    // Persist final value once the drag ends.
    const final = useSession.getState().settings.editorHeightPx;
    void ipc.settings.set({ editorHeightPx: final }).catch(() => {
      // Persistence is best-effort; the in-memory state already updated.
    });
  };

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize editor"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className="group relative h-1.5 shrink-0 cursor-row-resize border-y border-border bg-muted/60 transition-colors hover:bg-primary/40"
      style={{ touchAction: 'none' }}
    />
  );
}
