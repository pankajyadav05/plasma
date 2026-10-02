import { Button } from '@/components/ui/button';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { ArrowUpRight } from 'lucide-react';
import { cellToText } from './cell-edit';
import { type FkLookup, openArgs } from './fk-nav';
import { usePeekRow } from './fk-nav-client';

export interface PeekTarget {
  anchorRect: DOMRect;
  refSchema: string;
  refTable: string;
  lookup: FkLookup;
  /** ⌥-click / keyboard peeks stay open; hover peeks close when the pointer leaves. */
  pinned: boolean;
}

const MAX_FIELDS = 14;
const MAX_VALUE_CHARS = 120;

/**
 * Popover with the row an FK cell points at, plus "Open" to jump to it. The
 * row is fetched on demand (one LIMIT 1 lookup on the side connection).
 */
export function FkPeek({
  target,
  onClose,
  onOpen,
  onPointerEnter,
  onPointerLeave,
}: {
  target: PeekTarget | null;
  onClose: () => void;
  onOpen: (args: ReturnType<typeof openArgs>) => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}) {
  const result = usePeekRow(
    target?.refSchema ?? null,
    target?.refTable ?? null,
    target?.lookup ?? null,
  );
  const rect = target?.anchorRect;
  return (
    <Popover open={!!target} onOpenChange={(o) => !o && onClose()}>
      <PopoverAnchor asChild>
        <span
          aria-hidden
          style={{
            position: 'fixed',
            top: rect?.top ?? 0,
            left: rect?.left ?? 0,
            width: rect?.width ?? 0,
            height: rect?.height ?? 0,
            pointerEvents: 'none',
          }}
        />
      </PopoverAnchor>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={4}
        className="w-[340px] max-w-[92vw] p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onMouseEnter={onPointerEnter}
        onMouseLeave={onPointerLeave}
        aria-label="Referenced row"
      >
        {target && (
          <>
            <div className="flex items-center gap-2 border-b border-[var(--wb-separator)] px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[12px] font-semibold text-[var(--wb-text)]">
                  {target.refSchema}.{target.refTable}
                </div>
                <div className="truncate font-mono text-[11px] text-[var(--wb-text-2)]">
                  {target.lookup.match.map((m) => `${m.column} = ${m.value}`).join(' · ')}
                </div>
              </div>
              <Button
                size="xs"
                variant="secondary"
                onClick={() => {
                  onOpen(openArgs(target.refSchema, target.refTable, target.lookup));
                  onClose();
                }}
              >
                <ArrowUpRight />
                Open
              </Button>
            </div>
            <div className="max-h-[320px] overflow-auto px-3 py-2">
              {result === undefined ? (
                <div className="text-[12px] text-[var(--wb-text-2)]">Loading…</div>
              ) : result.status === 'missing' ? (
                <div className="text-[12px] text-[var(--wb-text-2)]">
                  No matching row (the reference may be dangling or hidden by row-level security).
                </div>
              ) : result.status === 'error' ? (
                <div className="text-[12px] text-destructive">{result.message}</div>
              ) : (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
                  {result.columns.slice(0, MAX_FIELDS).map((c, i) => {
                    const text = cellToText(result.row[i], c.dataTypeName);
                    return (
                      <div key={`${c.name}-${i}`} className="contents">
                        <dt className="truncate text-[var(--wb-text-2)]">{c.name}</dt>
                        <dd
                          className="min-w-0 truncate font-mono text-[var(--wb-text)]"
                          title={text ?? 'NULL'}
                        >
                          {text === null ? (
                            <span className="text-[var(--grid-null)]">NULL</span>
                          ) : text.length > MAX_VALUE_CHARS ? (
                            `${text.slice(0, MAX_VALUE_CHARS)}…`
                          ) : (
                            text
                          )}
                        </dd>
                      </div>
                    );
                  })}
                  {result.columns.length > MAX_FIELDS && (
                    <div className="col-span-2 text-[11px] text-[var(--wb-text-3)]">
                      + {result.columns.length - MAX_FIELDS} more columns — Open to see all
                    </div>
                  )}
                </dl>
              )}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
