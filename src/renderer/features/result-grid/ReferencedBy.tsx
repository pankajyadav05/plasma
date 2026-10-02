import { cn } from '@/lib/cn';
import { useSession } from '@/stores/session';
import type { ColumnMeta } from '@shared/protocol';
import { GitBranch } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  describeIncoming,
  formatIncomingCount,
  incomingFks,
  incomingRequestsForRow,
  openArgs,
} from './fk-nav';
import { useIncomingCounts } from './fk-nav-client';

const COLLAPSED_LIMIT = 10;

/**
 * "Referenced by" for one row: every foreign key that points at this table,
 * with how many rows reference THIS row ("order_items.order_id → 12 rows").
 * Clicking opens the referencing table filtered to those rows.
 *
 * `columns` / `row` are the row as shown; the lookup uses the values of the
 * referenced columns, which pending edits to a key column don't change in
 * the database until committed.
 */
export function ReferencedBy({
  schemaName,
  tableName,
  columns,
  row,
}: {
  schemaName: string;
  tableName: string;
  columns: readonly ColumnMeta[];
  row: readonly unknown[];
}) {
  const foreignKeys = useSession((s) => s.schema?.foreignKeys);
  const openForeignRow = useSession((s) => s.openForeignRow);
  const [showAll, setShowAll] = useState(false);
  const requests = useMemo(
    () => incomingRequestsForRow(incomingFks(foreignKeys, schemaName, tableName), columns, row),
    [foreignKeys, schemaName, tableName, columns, row],
  );
  const counts = useIncomingCounts(requests);
  if (requests.length === 0) return null;
  const shown = showAll ? requests : requests.slice(0, COLLAPSED_LIMIT);
  return (
    <section
      className="mx-1.5 mt-1 border-t border-[var(--wb-separator)] px-2 pb-2 pt-2"
      aria-label="Referenced by"
    >
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-[var(--wb-text-2)]">
        <GitBranch className="h-3 w-3" />
        Referenced by
      </div>
      <ul className="flex flex-col gap-px">
        {shown.map(({ group, lookup }) => {
          const c = counts.get(group.key);
          const loaded = counts.has(group.key);
          const empty = loaded && c?.count === 0;
          return (
            <li key={group.key}>
              <button
                type="button"
                onClick={() => {
                  const a = openArgs(group.schema, group.table, lookup);
                  openForeignRow(a.schema, a.table, a.column, a.value, a.also);
                }}
                title={`Open ${group.schema}.${group.table} where ${lookup.match.map((m) => `${m.column} = ${m.value}`).join(' and ')}`}
                className={cn(
                  'flex w-full items-baseline gap-1.5 rounded-[5px] px-1.5 py-1 text-left text-[12px] transition-colors hover:bg-[var(--wb-control-hover)]',
                  empty && 'opacity-60',
                )}
              >
                <span className="min-w-0 truncate font-mono text-[var(--wb-text)]">
                  {describeIncoming(group)}
                </span>
                <span className="text-[var(--wb-text-3)]">→</span>
                <span className="shrink-0 tabular-nums text-[var(--wb-text-2)]">
                  {loaded ? (c ? formatIncomingCount(c) : 'n/a') : '…'}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {requests.length > COLLAPSED_LIMIT && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-1 px-1.5 text-[11px] text-[var(--wb-text-2)] hover:text-[var(--wb-text)]"
        >
          {showAll ? 'Show fewer' : `Show all ${requests.length}`}
        </button>
      )}
    </section>
  );
}
