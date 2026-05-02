import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/cn';
import { ipc } from '@/lib/ipc';
import { defaultOperatorFor, operatorsFor } from '@/lib/pg-types';
import { buildDistinctValuesSql, type Filter, type FilterOp } from '@/lib/table-query';
import { useActiveTab, useSession } from '@/stores/session';
import { Command } from 'cmdk';
import { Check, ChevronsUpDown, Loader2, Plus, Search, Sparkles, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

interface ColumnOption {
  name: string;
  dataType: string;
}

/**
 * Supabase-style filter row above the toolbar. The single trigger on
 * the left opens an add-filter popover; applied filter chips are
 * clickable to edit them in-place. Add-more sits at the end of the
 * chip list.
 */
export function FilterRow() {
  const tab = useActiveTab();
  const schema = useSession((s) => s.schema);
  const removeFilter = useSession((s) => s.removeFilter);
  const claudeApiKey = useSession((s) => s.settings.claudeApiKey);

  const columnNames = useMemo(() => {
    if (!tab || tab.kind !== 'table' || !tab.tableSchema || !tab.tableName) return [];
    return (
      schema?.columns
        .filter((c) => c.schema === tab.tableSchema && c.table === tab.tableName)
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((c) => c.name) ?? []
    );
  }, [tab, schema]);

  if (!tab || tab.kind !== 'table') return null;

  const teaser =
    columnNames.length > 0
      ? `Filter by ${columnNames.slice(0, 3).join(', ')}${columnNames.length > 3 ? '…' : ''}`
      : 'Add a filter';

  const hasFilters = tab.filters.length > 0;

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
      {/* Search-style trigger only shows when no filters are applied —
          once chips exist, "Add more filters" handles new additions. */}
      {!hasFilters && <FilterTrigger teaser={teaser} hasAi={Boolean(claudeApiKey)} />}

      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {tab.filters.map((f) => (
          <EditableFilterChip key={f.id} filter={f} onRemove={() => void removeFilter(f.id)} />
        ))}
        {hasFilters && <AddMoreFilters hasAny />}
      </div>
    </div>
  );
}

/** Single trigger that opens the add-filter form. */
function FilterTrigger({ teaser, hasAi }: { teaser: string; hasAi: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="group flex h-7 w-[280px] shrink-0 cursor-pointer items-center gap-2 rounded-md border border-transparent px-2 text-muted-foreground transition-colors duration-150 hover:border-border hover:bg-accent/40"
        >
          {hasAi ? (
            <Sparkles className="h-3.5 w-3.5 text-primary" />
          ) : (
            <Search className="h-3.5 w-3.5" />
          )}
          <span className="flex-1 truncate text-left font-display text-xs italic">{teaser}</span>
          <kbd className="rounded-sm border border-border bg-muted px-1 font-mono text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
            F
          </kbd>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} className="w-[420px] p-0">
        <FilterForm onDone={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

/** Clickable chip — opens the same form pre-filled, persists via updateFilter. */
function EditableFilterChip({ filter, onRemove }: { filter: Filter; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  const showVal = filter.op !== 'IS NULL' && filter.op !== 'IS NOT NULL';
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <span className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-muted text-[11px]">
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex h-full cursor-pointer items-center gap-1 rounded-l-md px-2 transition-colors duration-150 hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            title="Edit filter"
          >
            <span className="font-mono font-medium text-foreground">{filter.column}</span>
            <span className="text-muted-foreground">{filter.op}</span>
            {showVal && (
              <span className="max-w-[160px] truncate font-mono text-type-str">
                {filter.value || "''"}
              </span>
            )}
          </button>
        </PopoverTrigger>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove filter on ${filter.column}`}
          className="grid h-4 w-4 shrink-0 cursor-pointer place-items-center rounded-sm text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground focus-visible:opacity-100"
        >
          <X className="h-3 w-3" />
        </button>
        <span className="w-1" />
      </span>
      <PopoverContent align="start" sideOffset={4} className="w-[420px] p-0">
        <FilterForm existing={filter} onDone={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

/** "Add more filters…" button — opens the add-filter popover. */
function AddMoreFilters({ hasAny }: { hasAny: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex h-7 cursor-pointer items-center gap-1 rounded-md px-2 text-[11px] transition-colors duration-150',
            hasAny
              ? 'text-muted-foreground hover:bg-accent hover:text-foreground'
              : 'border border-dashed border-border text-muted-foreground hover:border-foreground hover:text-foreground',
          )}
        >
          <Plus className="h-3 w-3" />
          <span className="font-display italic">{hasAny ? 'Add more filters' : 'Add filter'}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} className="w-[420px] p-0">
        <FilterForm onDone={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

function freshId(): string {
  return `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Shared form for both adding new filters and editing existing ones.
 * When `existing` is passed the form pre-fills its fields and saves via
 * `updateFilter(id, patch)`; otherwise it creates a new filter via
 * `addFilter(filter)`.
 */
function FilterForm({ existing, onDone }: { existing?: Filter; onDone: () => void }) {
  const tab = useActiveTab();
  const schema = useSession((s) => s.schema);
  const addFilter = useSession((s) => s.addFilter);
  const updateFilter = useSession((s) => s.updateFilter);

  const [column, setColumn] = useState(existing?.column ?? '');
  const [op, setOp] = useState<FilterOp>(existing?.op ?? '=');
  const [value, setValue] = useState(existing?.value ?? '');

  // If the popover is reopened with a different filter, sync state.
  useEffect(() => {
    if (existing) {
      setColumn(existing.column);
      setOp(existing.op);
      setValue(existing.value);
    }
  }, [existing]);

  const columns = useMemo(() => {
    if (!tab || tab.kind !== 'table' || !tab.tableSchema || !tab.tableName) return [];
    return (
      schema?.columns
        .filter((c) => c.schema === tab.tableSchema && c.table === tab.tableName)
        .sort((a, b) => a.ordinal - b.ordinal) ?? []
    );
  }, [tab, schema]);

  const selectedColumnMeta = columns.find((c) => c.name === column);
  const operatorGroups = useMemo(
    () => operatorsFor(selectedColumnMeta?.dataType),
    [selectedColumnMeta?.dataType],
  );

  const handleColumn = (next: string) => {
    setColumn(next);
    if (!existing) {
      const meta = columns.find((c) => c.name === next);
      setOp(defaultOperatorFor(meta?.dataType));
    }
  };

  const needsValue = op !== 'IS NULL' && op !== 'IS NOT NULL';
  const canSave = column.length > 0 && (!needsValue || value.trim().length > 0);

  const handleSave = () => {
    if (!canSave) return;
    if (existing) {
      void updateFilter(existing.id, { column, op, value });
    } else {
      const f: Filter = { id: freshId(), column, op, value };
      void addFilter(f);
    }
    if (!existing) setValue('');
    onDone();
  };

  return (
    <div className="flex flex-col gap-2 p-4">
      <div className="flex items-center gap-2">
        <ColumnCombobox columns={columns} value={column} onChange={handleColumn} />
        <Select value={op} onValueChange={(v) => setOp(v as FilterOp)}>
          <SelectTrigger className="h-8 w-[160px] shrink-0 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {operatorGroups.map((group) => (
              <SelectGroup key={group.heading}>
                <SelectLabel className="font-display text-[10px] font-normal italic text-muted-foreground">
                  {group.heading}
                </SelectLabel>
                {group.operators.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </div>
      {needsValue && tab && tab.kind === 'table' && tab.tableSchema && tab.tableName && column ? (
        <ValueAutocomplete
          schema={tab.tableSchema}
          table={tab.tableName}
          column={column}
          value={value}
          onChange={setValue}
          onEnter={handleSave}
        />
      ) : (
        needsValue && (
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="value"
            className="h-8 text-xs"
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSave();
            }}
          />
        )
      )}
      <Button
        variant={existing ? 'primary' : 'secondary'}
        size="sm"
        onClick={handleSave}
        disabled={!canSave}
        className="self-end"
      >
        {existing ? (
          'Save'
        ) : (
          <>
            <Plus />
            Add filter
          </>
        )}
      </Button>
    </div>
  );
}

/**
 * Searchable column picker — cmdk-based combobox. Lists every column on
 * the active table with name + dataType, filtered by free-text input.
 * Used in place of a plain Select so wide tables (50+ cols) stay
 * keyboard-friendly.
 */
function ColumnCombobox({
  columns,
  value,
  onChange,
}: {
  columns: ColumnOption[];
  value: string;
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = columns.find((c) => c.name === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          className={cn(
            'flex h-8 flex-1 cursor-pointer items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-xs shadow-sm transition-colors duration-150',
            'hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          )}
        >
          {selected ? (
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="truncate font-mono">{selected.name}</span>
              <span className="shrink-0 text-muted-foreground">{selected.dataType}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">column…</span>
          )}
          <ChevronsUpDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} className="w-[320px] p-0">
        <Command className="flex flex-col">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <Command.Input
              placeholder="Search columns…"
              className="h-6 flex-1 border-0 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
          <Command.List className="max-h-[280px] overflow-y-auto p-1">
            <Command.Empty className="px-3 py-3 font-display text-xs italic text-muted-foreground">
              no matching column
            </Command.Empty>
            {columns.map((c) => {
              const active = c.name === value;
              return (
                <Command.Item
                  key={c.name}
                  value={`${c.name} ${c.dataType}`}
                  onSelect={() => {
                    onChange(c.name);
                    setOpen(false);
                  }}
                  className={cn(
                    'flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs transition-colors',
                    'data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground',
                    active && 'text-primary',
                  )}
                >
                  {active ? (
                    <Check className="h-3 w-3 text-primary" />
                  ) : (
                    <span className="h-3 w-3" aria-hidden />
                  )}
                  <span className="flex min-w-0 flex-1 items-baseline gap-2">
                    <span className="truncate font-mono">{c.name}</span>
                    <span className="shrink-0 text-muted-foreground">{c.dataType}</span>
                  </span>
                </Command.Item>
              );
            })}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Free-text value input with a suggestion popover beneath. As the user
 * types, we debounce-fetch DISTINCT values from the underlying column
 * (capped at 20). Click or Arrow+Enter on a suggestion fills the field.
 *
 * Suggestions are best-effort — RLS, permissions, and column-not-text
 * coercion failures all fall back to a silent empty list, leaving the
 * input as a plain text field.
 */
function ValueAutocomplete({
  schema,
  table,
  column,
  value,
  onChange,
  onEnter,
}: {
  schema: string;
  table: string;
  column: string;
  value: string;
  onChange: (next: string) => void;
  onEnter: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounce the prefix query — keystrokes shouldn't fire IPC per char.
  // Re-runs on column change too so swapping the column resets results.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    const handle = setTimeout(async () => {
      try {
        const { sql, params } = buildDistinctValuesSql(schema, table, column, value);
        const res = await ipc.query.run(sql, params, { internal: true });
        if (cancelled) return;
        setSuggestions(
          res.rows
            .map((r) => (r[0] === null || r[0] === undefined ? '' : String(r[0])))
            .filter((s) => s.length > 0),
        );
      } catch {
        if (!cancelled) setSuggestions([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [schema, table, column, value, open]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Input
          ref={inputRef}
          value={value}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            onChange(e.target.value);
            if (!open) setOpen(true);
          }}
          placeholder="value"
          className="h-8 text-xs"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !open) onEnter();
            else if (e.key === 'Escape' && open) {
              setOpen(false);
              e.stopPropagation();
            }
          }}
        />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        // Keep focus in the input — let the user keep typing while the
        // suggestion list is visible. Without this, opening the popover
        // would yank focus away on first render.
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        className="w-[var(--radix-popover-trigger-width)] p-0"
      >
        {loading && suggestions.length === 0 ? (
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span className="font-display italic">looking up values…</span>
          </div>
        ) : suggestions.length === 0 ? (
          <div className="px-3 py-2 font-display text-xs italic text-muted-foreground">
            no suggestions
          </div>
        ) : (
          <div className="max-h-[240px] overflow-y-auto py-1">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                onMouseDown={(e) => {
                  // Use mousedown so the click registers before the input
                  // loses focus and the popover starts closing.
                  e.preventDefault();
                  onChange(s);
                  setOpen(false);
                  inputRef.current?.focus();
                }}
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left font-mono text-xs text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <span className="truncate">{s}</span>
              </button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
