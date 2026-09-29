import type { PendingEdit } from '@/stores/session';

/**
 * Diff of buffered grid edits — the toolbar's Preview popover. Each row
 * is one UPDATE that Commit will run (all in a single transaction).
 */
export function PendingEditsTable({ edits }: { edits: PendingEdit[] }) {
  return (
    <div className="max-h-[320px] overflow-auto">
      <table className="w-full font-mono text-[11px]">
        <thead className="sticky top-0 bg-popover">
          <tr className="border-b border-[var(--hairline)] text-left text-[10px] uppercase tracking-wider text-muted-foreground">
            <th className="px-2 py-1.5 font-medium">table</th>
            <th className="px-2 py-1.5 font-medium">pk</th>
            <th className="px-2 py-1.5 font-medium">column</th>
            <th className="px-2 py-1.5 font-medium">old → new</th>
          </tr>
        </thead>
        <tbody>
          {edits.map((e) => (
            <tr key={e.id} className="border-b border-[var(--hairline)]">
              <td className="px-2 py-1.5">
                {e.schema}.{e.table}
              </td>
              <td className="px-2 py-1.5 text-muted-foreground">
                {Object.entries(e.pkValues)
                  .map(([k, v]) => `${k}=${String(v)}`)
                  .join(', ')}
              </td>
              <td className="px-2 py-1.5">{e.column}</td>
              <td className="px-2 py-1.5">
                <span className="text-muted-foreground line-through">{format(e.oldValue)}</span>{' '}
                <span className="text-primary">{format(e.newValue)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function format(v: unknown): string {
  if (v === null) return 'NULL';
  if (v === undefined) return '—';
  if (typeof v === 'string') return v.length > 30 ? `${v.slice(0, 30)}…` : v;
  return String(v);
}
