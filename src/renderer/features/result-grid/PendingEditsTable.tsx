import { cn } from '@/lib/cn';
import { type PendingEdit, useSession } from '@/stores/session';
import { editKind } from '@/stores/session-pending-edits';
import { X } from 'lucide-react';

/**
 * Diff of buffered grid changes — the toolbar's Preview popover. Every
 * row is one queued change (update / insert / delete); Commit runs them
 * all in a single transaction. Changes whose statement failed are marked.
 */
export function PendingEditsTable({ edits }: { edits: PendingEdit[] }) {
  const discard = useSession((s) => s.discardPendingEdit);
  const failed = useSession((s) => s.pendingEditsError?.editIds);
  const failedSet = new Set(failed ?? []);
  return (
    <div className="max-h-[320px] overflow-auto">
      <table className="w-full font-mono text-[12px]">
        <thead className="sticky top-0 bg-popover">
          <tr className="border-b border-[var(--wb-separator)] text-left font-sans text-[12px] text-[var(--wb-text-2)]">
            <th className="px-2 py-1.5 font-medium">Change</th>
            <th className="px-2 py-1.5 font-medium">Table</th>
            <th className="px-2 py-1.5 font-medium">Row</th>
            <th className="px-2 py-1.5 font-medium">Value</th>
            <th className="w-6" aria-label="Discard" />
          </tr>
        </thead>
        <tbody>
          {edits.map((e) => {
            const kind = editKind(e);
            return (
              <tr
                key={e.id}
                className={cn(
                  'border-b border-[var(--wb-separator)]',
                  failedSet.has(e.id) &&
                    'bg-[color-mix(in_srgb,var(--destructive)_12%,transparent)]',
                )}
              >
                <td
                  className={cn(
                    'px-2 py-1.5 font-sans',
                    kind === 'delete' && 'text-destructive',
                    kind === 'insert' && 'text-[var(--status-local)]',
                  )}
                >
                  {kind === 'update' ? e.column : kind === 'insert' ? 'Insert' : 'Delete'}
                  {e.maybeCommitted && (
                    <span
                      className="ml-1 text-[11px] text-[var(--wb-text-2)]"
                      title="Plasma stopped while this was being committed. Check the data before committing it again."
                    >
                      may already be saved
                    </span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-[var(--wb-text-2)]">
                  {e.schema}.{e.table}
                </td>
                <td className="px-2 py-1.5 text-[var(--wb-text-2)]">
                  {kind === 'insert'
                    ? 'new'
                    : Object.entries(e.pkValues)
                        .map(([k, v]) => `${k}=${format(v)}`)
                        .join(', ')}
                </td>
                <td className="px-2 py-1.5">
                  {kind === 'update' ? (
                    <>
                      <span className="text-[var(--wb-text-3)] line-through">
                        {format(e.oldValue)}
                      </span>{' '}
                      <span className="text-[var(--wb-text)]">{format(e.newValue)}</span>
                    </>
                  ) : kind === 'insert' ? (
                    <span className="text-[var(--wb-text)]">
                      {Object.entries(e.values ?? {})
                        .map(([k, v]) => `${k}=${format(v)}`)
                        .join(', ') || 'DEFAULT VALUES'}
                    </span>
                  ) : (
                    <span className="text-[var(--wb-text-3)]">—</span>
                  )}
                </td>
                <td className="px-1">
                  <button
                    type="button"
                    onClick={() => discard(e.id)}
                    aria-label="Discard this change"
                    title="Discard this change"
                    className="grid h-4 w-4 place-items-center rounded-[4px] text-[var(--wb-text-2)] hover:bg-[var(--wb-control-hover)] hover:text-[var(--wb-text)]"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function format(v: unknown): string {
  if (v === null) return 'NULL';
  if (v === undefined) return '—';
  if (v instanceof Date) return v.toISOString();
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}
