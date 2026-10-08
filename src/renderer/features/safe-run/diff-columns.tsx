import type { DataColumn } from '@/components/ui/data-table';
import { cellToText } from '@/features/result-grid/cell-edit';
import { cn } from '@/lib/cn';
import type { DiffRow, SafeRunDiff } from '@shared/safe-run-diff';

const MAX_CELL_CHARS = 400;

const TINT_CHANGED = 'bg-[color-mix(in_srgb,var(--status-warn)_24%,transparent)]';
const TINT_INSERTED = 'bg-[color-mix(in_srgb,var(--wb-accent)_20%,transparent)]';
const TINT_DELETED = 'bg-[color-mix(in_srgb,var(--wb-danger-fill)_20%,transparent)]';

function text(value: unknown, type: string | undefined): string | null {
  if (value === undefined) return null;
  const t = cellToText(value, type);
  if (t === null) return null;
  return t.length > MAX_CELL_CHARS ? `${t.slice(0, MAX_CELL_CHARS)}…` : t;
}

function Cell({ value, type }: { value: unknown; type: string | undefined }) {
  const t = text(value, type);
  if (t === null) return <span className="text-[var(--grid-null)]">NULL</span>;
  if (t === '') return <span className="text-[var(--grid-null)]">''</span>;
  return <>{t}</>;
}

/** A cell that fills the whole `<td>` so the tint reaches its edges. */
function Fill({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <span className={cn('-mx-2.5 block h-6 truncate px-2.5 leading-6', className)}>{children}</span>
  );
}

function opMark(status: DiffRow['status']): { mark: string; label: string; className: string } {
  switch (status) {
    case 'changed':
      return { mark: '~', label: 'changed', className: 'text-[var(--status-warn)]' };
    case 'inserted':
    case 'new':
      return { mark: '+', label: 'new row', className: 'text-[var(--wb-accent-text)]' };
    case 'deleted':
    case 'old':
      return { mark: '−', label: 'removed row', className: 'text-[var(--wb-danger-fill)]' };
    default:
      return { mark: '', label: 'unchanged', className: 'text-[var(--wb-text-3)]' };
  }
}

export function buildColumns(diff: SafeRunDiff): DataColumn<DiffRow>[] {
  const op: DataColumn<DiffRow> = {
    key: '__op',
    label: '',
    width: 28,
    sans: true,
    render: (row) => {
      const m = opMark(row.status);
      return (
        <span className={cn('font-semibold', m.className)} role="img" aria-label={m.label}>
          {m.mark}
        </span>
      );
    },
  };
  const cols = diff.columns.map<DataColumn<DiffRow>>((c, i) => ({
    key: `c${i}`,
    label: c.name,
    title: `${c.name} — ${c.dataTypeName ?? ''}`,
    render: (row) => {
      const type = c.dataTypeName;
      const before = row.before?.[i];
      const after = row.after?.[i];
      switch (row.status) {
        case 'changed':
          if (row.changed[i]) {
            return (
              <Fill className={TINT_CHANGED}>
                <span className="text-[var(--wb-text-3)] line-through">
                  <Cell value={before} type={type} />
                </span>
                <span className="px-1 text-[var(--wb-text-3)]" aria-hidden>
                  →
                </span>
                <span className="font-medium">
                  <Cell value={after} type={type} />
                </span>
              </Fill>
            );
          }
          return <Cell value={after} type={type} />;
        case 'unchanged':
          return (
            <span className="text-[var(--wb-text-2)]">
              <Cell value={after} type={type} />
            </span>
          );
        case 'inserted':
        case 'new':
          return (
            <Fill className={TINT_INSERTED}>
              <Cell value={after} type={type} />
            </Fill>
          );
        default:
          return (
            <Fill className={cn(TINT_DELETED, 'text-[var(--wb-text-2)] line-through')}>
              <Cell value={before ?? after} type={type} />
            </Fill>
          );
      }
    },
    titleOf: (row) => text(row.after?.[i] ?? row.before?.[i], c.dataTypeName) ?? 'NULL',
  }));
  return [op, ...cols];
}
