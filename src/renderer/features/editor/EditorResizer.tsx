import { ResizeIndicator } from '@/components/ui/resize-indicator';
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import { useRef } from 'react';

export const EDITOR_MIN_PX = 120;
export const EDITOR_MAX_PX = 1200;
export const EDITOR_DEFAULT_PX = 280;
const KEY_STEP_PX = 16;

export function clampEditorHeight(px: number): number {
  return Math.round(Math.max(EDITOR_MIN_PX, Math.min(EDITOR_MAX_PX, px)));
}

/**
 * Elements inside a drag surface that keep their own pointer behaviour
 * (the action bar's pills and menus) — pressing them never starts a drag.
 */
export function isInteractiveTarget(el: Element | null): boolean {
  return Boolean(
    el?.closest('button, a, input, select, textarea, [role="menu"], [role="menuitem"]'),
  );
}

function setLocalHeight(height: number) {
  useSession.setState((state) => ({
    settings: { ...state.settings, editorHeightPx: height },
  }));
}

function persistHeight() {
  const final = useSession.getState().settings.editorHeightPx;
  void ipc.settings.set({ editorHeightPx: final }).catch(() => {
    // Persistence is best-effort; the in-memory state already updated.
  });
}

/**
 * Pointer handlers that drag the editor/results split. Drag updates
 * `settings.editorHeightPx` optimistically; persistence to SQLite fires
 * once on pointerup so we don't hammer disk during a drag.
 *
 * Mirrors the SidebarResizer pattern (pointer-capture + global cursor)
 * so the cursor doesn't reset to default while dragging over Monaco.
 * Shared by the separator and the editor action bar, which doubles as a
 * grab surface on its empty space.
 */
export function useEditorSplitDrag() {
  const dragStartY = useRef(0);
  const startHeight = useRef(0);

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || isInteractiveTarget(e.target as Element)) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStartY.current = e.clientY;
    startHeight.current = useSession.getState().settings.editorHeightPx;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  };

  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    setLocalHeight(clampEditorHeight(startHeight.current + e.clientY - dragStartY.current));
  };

  const onPointerUp = (e: React.PointerEvent<HTMLElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    persistHeight();
  };

  /** Double-click resets the split to the default editor height. */
  const onDoubleClick = (e: React.MouseEvent<HTMLElement>) => {
    if (isInteractiveTarget(e.target as Element)) return;
    setLocalHeight(EDITOR_DEFAULT_PX);
    persistHeight();
  };

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onDoubleClick };
}

/**
 * Horizontal handle between the inline SQL editor and the result grid.
 * Drag or use ↑/↓ (Shift for bigger steps) to resize; double-click resets.
 */
export function EditorResizer() {
  const editorHeightPx = useSession((s) => s.settings.editorHeightPx);
  const drag = useEditorSplitDrag();

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? KEY_STEP_PX * 4 : KEY_STEP_PX;
    const next =
      e.key === 'ArrowUp'
        ? editorHeightPx - step
        : e.key === 'ArrowDown'
          ? editorHeightPx + step
          : e.key === 'Home'
            ? EDITOR_MIN_PX
            : e.key === 'End'
              ? EDITOR_MAX_PX
              : null;
    if (next === null) return;
    e.preventDefault();
    setLocalHeight(clampEditorHeight(next));
    persistHeight();
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> can't hold the resize grip
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize editor"
      aria-valuemin={EDITOR_MIN_PX}
      aria-valuemax={EDITOR_MAX_PX}
      aria-valuenow={editorHeightPx}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      data-testid="editor-resizer"
      {...drag}
      onKeyDown={onKeyDown}
      className="group/rz relative z-20 h-px shrink-0 cursor-row-resize bg-[var(--wb-separator)] outline-none before:absolute before:inset-x-0 before:-top-[5px] before:-bottom-[5px] before:content-['']"
      style={{ touchAction: 'none' }}
    >
      <ResizeIndicator orientation="horizontal" />
    </div>
  );
}
