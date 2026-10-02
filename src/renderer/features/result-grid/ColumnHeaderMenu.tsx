import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { MenuItem } from '@/components/ui/workbench';
import { defaultOperatorFor } from '@/lib/pg-types';
import type { Filter, FilterOp } from '@/lib/table-query';
import { useSession } from '@/stores/session';
import type { ColumnMeta } from '@shared/protocol';
import {
  ArrowDownAZ,
  ArrowUpAZ,
  ChevronDown,
  Copy,
  EyeOff,
  Filter as FilterIcon,
  MoveHorizontal,
  Pin,
  PinOff,
  X,
} from 'lucide-react';
import { useState } from 'react';

interface Props {
  column: ColumnMeta;
  /** Current sort direction for this column, or null. */
  sortDir: 'asc' | 'desc' | null;
  /** Whether this column is currently sticky (pinned). */
  pinned: boolean;
  /** Whether the active tab is a table tab — only then can we filter/hide server-side. */
  tableMode: boolean;
  onSortAsc: () => void;
  onSortDesc: () => void;
  onClearSort: () => void;
  onTogglePin: () => void;
  onHide: () => void;
  /** Fit the column width to its header and content. */
  onAutoFit?: () => void;
  /** Pin every column from the left edge up to this one. */
  onFreezeUpTo?: () => void;
  /** Unpin all columns (offered while any column is pinned). */
  onUnfreezeAll?: () => void;
}

function freshId(): string {
  return `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function ColumnHeaderMenu({
  column,
  sortDir,
  pinned,
  tableMode,
  onSortAsc,
  onSortDesc,
  onClearSort,
  onTogglePin,
  onHide,
  onAutoFit,
  onFreezeUpTo,
  onUnfreezeAll,
}: Props) {
  const [open, setOpen] = useState(false);
  const addFilter = useSession((s) => s.addFilter);

  const close = () => setOpen(false);

  const copyName = async () => {
    try {
      await navigator.clipboard.writeText(column.name);
    } catch {
      /* clipboard unavailable */
    }
    close();
  };

  const filterByThisColumn = () => {
    if (!tableMode) return;
    const op: FilterOp = defaultOperatorFor(column.dataTypeName);
    const f: Filter = { id: freshId(), column: column.name, op, value: '' };
    void addFilter(f);
    close();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(true);
          }}
          aria-label={`Options for ${column.name}`}
          className="grid h-5 w-5 shrink-0 place-items-center rounded-[4px] text-[var(--wb-text-2)] opacity-0 transition-opacity hover:bg-[var(--wb-control-hover)] hover:text-[var(--wb-text)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_color-mix(in_srgb,var(--wb-accent)_55%,transparent)] group-hover/header:opacity-100 data-[state=open]:opacity-100"
        >
          <ChevronDown className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={2}
        className="w-[220px] p-1"
        role="menu"
        aria-label={`${column.name} options`}
        onClick={(e) => e.stopPropagation()}
      >
        <MenuItem
          icon={<ArrowUpAZ className="h-3.5 w-3.5" />}
          label="Sort ascending"
          checked={sortDir === 'asc'}
          onClick={() => {
            onSortAsc();
            close();
          }}
        />
        <MenuItem
          icon={<ArrowDownAZ className="h-3.5 w-3.5" />}
          label="Sort descending"
          checked={sortDir === 'desc'}
          onClick={() => {
            onSortDesc();
            close();
          }}
        />
        {sortDir && (
          <MenuItem
            icon={<X className="h-3.5 w-3.5" />}
            label="Clear sort"
            onClick={() => {
              onClearSort();
              close();
            }}
          />
        )}
        <Separator />
        {tableMode && (
          <MenuItem
            icon={<FilterIcon className="h-3.5 w-3.5" />}
            label="Filter by this column…"
            onClick={filterByThisColumn}
          />
        )}
        <MenuItem
          icon={pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
          label={pinned ? 'Unpin column' : 'Pin column'}
          onClick={() => {
            onTogglePin();
            close();
          }}
        />
        {onFreezeUpTo && (
          <MenuItem
            icon={<Pin className="h-3.5 w-3.5" />}
            label="Freeze columns up to here"
            onClick={() => {
              onFreezeUpTo();
              close();
            }}
          />
        )}
        {onUnfreezeAll && (
          <MenuItem
            icon={<PinOff className="h-3.5 w-3.5" />}
            label="Unfreeze all columns"
            onClick={() => {
              onUnfreezeAll();
              close();
            }}
          />
        )}
        {onAutoFit && (
          <MenuItem
            icon={<MoveHorizontal className="h-3.5 w-3.5" />}
            label="Auto-fit width"
            hint="Double-click edge"
            onClick={() => {
              onAutoFit();
              close();
            }}
          />
        )}
        <MenuItem
          icon={<EyeOff className="h-3.5 w-3.5" />}
          label="Hide column"
          onClick={() => {
            onHide();
            close();
          }}
        />
        <Separator />
        <MenuItem
          icon={<Copy className="h-3.5 w-3.5" />}
          label="Copy column name"
          onClick={copyName}
        />
      </PopoverContent>
    </Popover>
  );
}

function Separator() {
  return <div className="my-1 h-px bg-[var(--wb-separator)]" aria-hidden />;
}
