import type { ReactNode } from 'react';

/** Numbered steps. Each has a short title and a body. */
export function Steps({ items }: { items: { title: string; body: ReactNode }[] }) {
  return (
    <ol className="my-6 space-y-0 border-t border-ink">
      {items.map((s, i) => (
        <li key={s.title} className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-3 border-b border-rule py-5">
          <span className="mono pt-[3px] text-[12px] font-medium text-signal">{String(i + 1).padStart(2, '0')}</span>
          <div>
            <h4 className="text-[17px] font-bold leading-snug text-ink">{s.title}</h4>
            <div className="text-[16px] leading-[1.65] text-ink-2 [&>p]:my-2 [&>p:last-child]:mb-0">{s.body}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}
