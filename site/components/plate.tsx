import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** A framed plate with crop marks at the four corners. */
export function Plate({
  children,
  className,
  frameClassName,
  marks = true,
}: {
  children: ReactNode;
  className?: string;
  frameClassName?: string;
  marks?: boolean;
}) {
  return (
    <div className={cn('relative', className)}>
      {marks && (
        <>
          {(['tl', 'tr', 'bl', 'br'] as const).map((c) => (
            <span key={c} className={`crop crop-${c}`} aria-hidden="true">
              <i />
              <i />
            </span>
          ))}
        </>
      )}
      <div className={cn('plate', frameClassName)}>{children}</div>
    </div>
  );
}

/** Mono caption under a plate: a signal tick, then what the picture shows. */
export function Caption({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn('label mt-5 flex items-baseline gap-3', className)}>
      <span className="h-[7px] w-[7px] shrink-0 translate-y-[-1px] bg-signal" aria-hidden="true" />
      <span className="normal-case tracking-normal text-[12.5px]">{children}</span>
    </p>
  );
}

/** Section header: a hairline rule under a drafting cross, with the section name in words. */
export function SectionHead({ name, tone = 'paper' }: { name: string; tone?: 'paper' | 'ink' }) {
  const dark = tone === 'ink';
  return (
    <div
      className={cn('relative flex items-center gap-4 border-t pt-3', dark ? 'border-paper/70' : 'border-ink')}
      aria-hidden="true"
    >
      <svg viewBox="0 0 11 11" className="absolute -left-[5px] -top-[6px] h-[11px] w-[11px]">
        <path d="M5.5 0v11M0 5.5h11" stroke="currentColor" strokeWidth="1" className={dark ? 'text-paper' : 'text-ink'} />
      </svg>
      <span className={cn('label', dark ? 'text-paper' : 'text-ink')}>{name}</span>
      <span className={cn('h-px flex-1', dark ? 'bg-paper/20' : 'bg-rule')} />
    </div>
  );
}
