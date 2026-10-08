import type { ReactNode } from 'react';

export function DocTable({
  head,
  rows,
  caption,
}: {
  head: string[];
  rows: ReactNode[][];
  caption?: string;
}) {
  return (
    <div className="my-6 overflow-x-auto rounded-[12px] border border-rule bg-paper-2/60" tabIndex={0} role="region" aria-label={caption ?? 'Table'}>
      <table className="w-full min-w-[480px] border-collapse text-left text-[15px] leading-[1.55]">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="border-b border-ink">
            {head.map((h) => (
              <th key={h} scope="col" className="label whitespace-nowrap px-4 py-3 text-ink">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static content
            <tr key={i} className="border-b border-rule last:border-b-0 align-top">
              {r.map((c, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static content
                <td key={j} className={j === 0 ? 'px-4 py-3 font-medium text-ink' : 'px-4 py-3 text-ink-2'}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
