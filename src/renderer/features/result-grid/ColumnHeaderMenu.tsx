import { useState } from 'react';
import {
  ArrowDownAZ,
  ArrowUpAZ,
  ChevronDown,
  Copy,
  EyeOff,
  Filter as FilterIcon,
  Pin,
  PinOff,
  X,
} from 'lucide-react';
import type { ColumnMeta } from '@shared/protocol';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/cn';
import type { Filter, FilterOp } from '@/lib/table-query';
import { defaultOperatorFor } from '@/lib/pg-types';
import { useSession } from '@/stores/session';

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
          className="grid h-5 w-5 shrink-0 place-items-center rounded-sm text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/header:opacity-100 data-[state=open]:opacity-100"
        >
          <ChevronDown className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={2}
        className="w-[220px] p-1"
        onClick={(e) => e.stopPropagation()}
      >
        <MenuItem
          icon={<ArrowUpAZ className="h-3.5 w-3.5" />}
          label="Sort ascending"
          active={sortDir === 'asc'}
          onClick={() => {
            onSortAsc();
            close();
          }}
        />
        <MenuItem
          icon={<ArrowDownAZ className="h-3.5 w-3.5" />}
          label="Sort descending"
          active={sortDir === 'desc'}
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

function MenuItem({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors',
        active
          ? 'bg-accent text-accent-foreground'
          : 'text-foreground hover:bg-accent hover:text-accent-foreground',
      )}
    >
      <span className={cn('text-muted-foreground', active && 'text-primary')}>{icon}</span>
      <span className="flex-1">{label}</span>
    </button>
  );
}

function Separator() {
  return <div className="my-1 h-px bg-border" aria-hidden />;
}
