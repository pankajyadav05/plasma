import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * Bracket-cornered frame for instrument-panel sections. Adds a tag label
 * ("INDEX 02 — SPECS") + an optional right-side meta string so each block
 * reads as a measurement card.
 */
export function InstrumentFrame({
  index,
  title,
  meta,
  accent = 'plasma',
  className,
  children,
}: {
  index: string;
  title: string;
  meta?: string;
  accent?: 'plasma' | 'ox' | 'volt' | 'line';
  className?: string;
  children: ReactNode;
}) {
  const bracketClass =
    accent === 'plasma'
      ? 'bracket-plasma'
      : accent === 'ox'
        ? 'bracket-ox'
        : '';
  const dotColor =
    accent === 'plasma'
      ? 'bg-plasma shadow-[0_0_10px_var(--plasma)]'
      : accent === 'ox'
        ? 'bg-ox shadow-[0_0_10px_var(--ox)]'
        : accent === 'volt'
          ? 'bg-volt shadow-[0_0_10px_var(--volt)]'
          : 'bg-fg';

  return (
    <div className={cn('relative', className)}>
      {/* Index tag — riding the top edge */}
      <div className="flex items-center justify-between mb-4 px-1">
        <div className="flex items-center gap-3 label">
          <span className={cn('block h-1.5 w-1.5 rounded-full', dotColor)} />
          <span className="label-strong">INDEX {index}</span>
          <span>·</span>
          <span>{title}</span>
        </div>
        {meta && <div className="label hidden md:block">{meta}</div>}
      </div>

      <div className={cn('bracket', bracketClass)}>
        <span className="bracket-bl" />
        <span className="bracket-br" />
        {children}
      </div>
    </div>
  );
}
