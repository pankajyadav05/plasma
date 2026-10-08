import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

const KIND = {
  note: { label: 'Note', bar: 'bg-ink', box: 'bg-paper-2' },
  warning: { label: 'Careful', bar: 'bg-signal', box: 'bg-[#f7e9e3]' },
  tip: { label: 'Tip', bar: 'bg-ink-3', box: 'bg-paper-2' },
} as const;

export function Callout({
  kind = 'note',
  title,
  children,
}: {
  kind?: keyof typeof KIND;
  title?: string;
  children: ReactNode;
}) {
  const k = KIND[kind];
  return (
    <aside
      role="note"
      aria-label={title ?? k.label}
      className={cn('relative my-6 overflow-hidden rounded-[12px] border border-rule py-4 pl-6 pr-5', k.box)}
    >
      <span aria-hidden="true" className={cn('absolute inset-y-0 left-0 w-[3px]', k.bar)} />
      <p className="label text-ink">{title ?? k.label}</p>
      <div className="mt-2 text-[15.5px] leading-[1.65] text-ink-2 [&>p]:my-2 [&>p:first-child]:mt-0 [&>p:last-child]:mb-0">
        {children}
      </div>
    </aside>
  );
}
