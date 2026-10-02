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

/** Mono caption under a plate: "FIG 01.3  The thing". */
export function Caption({ fig, children, className }: { fig: string; children: ReactNode; className?: string }) {
  return (
    <p className={cn('label mt-5 flex items-baseline gap-3', className)}>
      <span className="text-ink">{fig}</span>
      <span className="h-px w-6 bg-rule translate-y-[-3px]" aria-hidden="true" />
      <span className="normal-case tracking-normal text-[12.5px]">{children}</span>
    </p>
  );
}

/** Section header: hairline rule with the plate number and name. */
export function SectionHead({ plate, name }: { plate: string; name: string }) {
  return (
    <div className="flex items-center gap-4 border-t border-ink pt-3" aria-hidden="true">
      <span className="label text-ink">{plate}</span>
      <span className="h-px flex-1 bg-rule" />
      <span className="label">{name}</span>
    </div>
  );
}
