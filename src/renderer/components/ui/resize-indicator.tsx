import { cn } from '@/lib/cn';

/**
 * Shared look for every drag-to-resize handle: a grip pill that hints the
 * line is draggable, and an accent line that lights up on hover / focus /
 * drag. Render it inside a positioned handle carrying the `group/rz` class.
 *
 *   vertical   — a column/pane edge dragged left-right (col-resize)
 *   horizontal — a split dragged up-down (row-resize)
 */
export function ResizeIndicator({
  orientation,
  gripClassName,
}: {
  orientation: 'vertical' | 'horizontal';
  /** Idle visibility of the grip; defaults to a faint always-on hint. */
  gripClassName?: string;
}) {
  const vertical = orientation === 'vertical';
  return (
    <>
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute bg-transparent transition-[background-color,width,height] duration-instant group-hover/rz:bg-[var(--wb-accent)] group-focus-visible/rz:bg-[var(--wb-accent)] group-active/rz:bg-[var(--wb-accent)]',
          vertical
            ? 'inset-y-0 left-1/2 w-px -translate-x-1/2 group-hover/rz:w-[2px] group-active/rz:w-[2px]'
            : 'inset-x-0 top-1/2 h-px -translate-y-1/2 group-hover/rz:h-[2px] group-active/rz:h-[2px]',
        )}
      />
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--wb-text-2)] transition-[opacity,background-color] duration-instant group-hover/rz:bg-[var(--wb-accent)] group-hover/rz:opacity-100 group-focus-visible/rz:bg-[var(--wb-accent)] group-focus-visible/rz:opacity-100 group-active/rz:bg-[var(--wb-accent)] group-active/rz:opacity-100',
          vertical ? 'h-4 w-[3px]' : 'h-[3px] w-8',
          gripClassName ?? 'opacity-60',
        )}
      />
    </>
  );
}
