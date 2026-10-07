import { IconButton } from '@/components/ui/workbench';
import { cn } from '@/lib/cn';
import {
  type CompareSource,
  type DiffResult,
  type DiffRow,
  leftCell,
  rightCell,
} from '@shared/result-compare';
import { X } from 'lucide-react';
import { CHANGED_CELL_TINT, KIND_GLYPH } from './DiffGrid';
import { cellText, isNullish } from './cell-text';

function V({ v }: { v: unknown }) {
  if (isNullish(v)) return <span className="text-[var(--grid-null)]">NULL</span>;
  const text = cellText(v);
  return text === '' ? <span className="text-[var(--grid-null)]">(empty)</span> : <>{text}</>;
}

/** The selected row, every column side by side: A, B, and which cells differ. */
export function RowDetail({
  diff,
  left,
  right,
  row,
  onClose,
}: {
  diff: DiffResult;
  left: CompareSource;
  right: CompareSource;
  row: DiffRow;
  onClose(): void;
}) {
  const kind = KIND_GLYPH[row.kind];
  const keyText = diff.keys
    .map(
      (k, c) =>
        `${k} = ${cellText(leftCell(diff, left, row, c) ?? rightCell(diff, right, row, c))}`,
    )
    .join(', ');
  return (
    <section
      aria-label="Row detail"
      data-testid="compare-detail"
      className="flex h-[210px] min-h-0 shrink-0 flex-col border-t border-[var(--wb-separator)] bg-[var(--wb-content)]"
    >
      <header className="flex h-8 shrink-0 items-center gap-2 px-3 text-[12px]">
        <span className="font-semibold" style={{ color: kind.color }}>
          {kind.glyph} {kind.label}
        </span>
        {keyText && <span className="truncate font-mono text-[var(--wb-text-2)]">{keyText}</span>}
        <span className="flex-1" />
        <IconButton label="Close detail" variant="plain" onClick={onClose}>
          <X />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-auto px-3 pb-2">
        {row.kind === 'duplicate' ? (
          <p className="text-[12px] text-[var(--wb-text-2)]" data-testid="compare-dup-note">
            This key appears {(row.lis?.length ?? 0).toLocaleString()} time
            {(row.lis?.length ?? 0) === 1 ? '' : 's'} in A and{' '}
            {(row.ris?.length ?? 0).toLocaleString()} in B, so the rows cannot be matched one to
            one. Plasma does not merge them. Pick a key that is unique, or add a column to the key.
          </p>
        ) : (
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="text-left text-[11px] text-[var(--wb-text-2)]">
                <th className="w-[26%] py-1 pr-3 font-medium">Column</th>
                <th className="w-[37%] py-1 pr-3 font-medium">A</th>
                <th className="w-[37%] py-1 font-medium">B</th>
              </tr>
            </thead>
            <tbody>
              {diff.columns.map((name, c) => {
                const changed = row.changed.includes(c);
                return (
                  <tr
                    key={name}
                    className={cn('border-t border-[var(--grid-line)]', changed && 'font-medium')}
                    data-changed={changed || undefined}
                    style={changed ? { backgroundColor: CHANGED_CELL_TINT } : undefined}
                  >
                    <td className="py-1 pr-3 align-top text-[var(--wb-text-2)]">{name}</td>
                    <td className="max-w-0 break-words py-1 pr-3 align-top font-mono text-[var(--grid-text)]">
                      {row.li < 0 ? (
                        <span className="text-[var(--wb-text-3)]">—</span>
                      ) : (
                        <V v={leftCell(diff, left, row, c)} />
                      )}
                    </td>
                    <td className="max-w-0 break-words py-1 align-top font-mono text-[var(--grid-text)]">
                      {row.ri < 0 ? (
                        <span className="text-[var(--wb-text-3)]">—</span>
                      ) : (
                        <V v={rightCell(diff, right, row, c)} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
