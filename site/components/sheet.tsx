'use client';

import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * The page's ruled spec sheet, the vocabulary of the hero engine row: a heavy
 * top rule, hairlines only between cells, drafting crosses at the corners and
 * a signal "wire" that runs the top rule once when the sheet scrolls into
 * view, switching each cell's mark on as it passes.
 */
export function Cross({ className }: { className: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 11 11" className={cn('sheet-cross absolute h-[11px] w-[11px]', className)}>
      <path d="M5.5 0v11M0 5.5h11" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

export function Crosses() {
  return (
    <>
      <Cross className="-left-[5px] -top-[6px]" />
      <Cross className="-right-[5px] -top-[6px]" />
      <Cross className="-bottom-[6px] -left-[5px]" />
      <Cross className="-bottom-[6px] -right-[5px]" />
    </>
  );
}

export function Sheet({
  children,
  className,
  tone = 'paper',
}: {
  children: ReactNode;
  className?: string;
  tone?: 'paper' | 'ink';
}) {
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.classList.add('js');
    if (typeof IntersectionObserver === 'undefined') {
      el.classList.add('in');
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          el.classList.add('in');
          io.disconnect();
        }
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.1 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref as React.RefObject<HTMLDivElement>} className={cn('sheet relative', tone === 'ink' && 'sheet-ink', className)}>
      <Crosses />
      <span aria-hidden="true" className="sheet-wire" />
      {children}
    </div>
  );
}

/** Cells in a ruled grid: hairlines between cells only, never on the outer edge. */
export function SheetGrid({
  children,
  className,
  label,
  as: Tag = 'div',
}: {
  children: ReactNode;
  className?: string;
  /** Accessible name when the grid is a list. */
  label?: string;
  as?: 'div' | 'ul';
}) {
  const Comp = Tag as 'div';
  return (
    <div className="overflow-hidden">
      <Comp aria-label={label} className={cn('sheet-grid -ml-px -mt-px grid', className)}>
        {children}
      </Comp>
    </div>
  );
}

/** One cell: a mono kind label with a mark that switches on, then free content. */
export function SheetCell({
  kind,
  index = 0,
  children,
  className,
  as: Tag = 'div',
}: {
  kind?: string;
  index?: number;
  children: ReactNode;
  className?: string;
  as?: 'div' | 'li';
}) {
  const Comp = Tag as 'div';
  return (
    <Comp className={cn('sheet-cell relative', className)} style={{ '--i': index } as CSSProperties}>
      <span aria-hidden="true" className="sheet-bar" />
      {kind && (
        <span className="sheet-kind mono flex items-center gap-2 text-[10.5px] font-medium uppercase leading-none tracking-[0.08em]">
          <span aria-hidden="true" className="sheet-tick" />
          <span className="truncate">{kind}</span>
        </span>
      )}
      {children}
    </Comp>
  );
}
