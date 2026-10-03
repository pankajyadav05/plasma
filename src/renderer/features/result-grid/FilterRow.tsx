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
import { AskFilter } from '@/features/ai/AskFilter';
import { cn } from '@/lib/cn';
import { ipc } from '@/lib/ipc';
import { defaultOperatorFor, operatorLabel, operatorsFor } from '@/lib/pg-types';
import {
  type Filter,
  type FilterOp,
  betweenBounds,
  buildDistinctValuesSql,
  filterSuggestions,
  splitFilterList,
} from '@/lib/table-query';
import { useActiveTab, useSession } from '@/stores/session';
import { dialectFor } from '@shared/sql-dialect';
import { Command } from 'cmdk';
import { Check, ChevronsUpDown, Code2, Loader2, Plus, Search, X } from 'lucide-react';
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
  const updateFilter = useSession((s) => s.updateFilter);

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
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--wb-separator)] bg-[var(--wb-content)] px-2 text-[13px]">
      {/* Search-style trigger only shows when no filters are applied —
          once chips exist, "Add more filters" handles new additions. */}
      {!hasFilters && <FilterTrigger teaser={teaser} />}

      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {tab.filters.map((f) => (
          <EditableFilterChip
            key={f.id}
            filter={f}
            onRemove={() => void removeFilter(f.id)}
            onToggle={() => void updateFilter(f.id, { enabled: f.enabled === false })}
          />
        ))}
        {hasFilters && <AddMoreFilters hasAny />}
      </div>
      <AskFilter />
      {hasFilters && <SqlPreview sql={tab.sql} />}
    </div>
  );
}

/** Single trigger that opens the add-filter form. */
function FilterTrigger({ teaser }: { teaser: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="group flex h-[26px] w-[280px] shrink-0 cursor-pointer items-center gap-2 rounded-[7px] bg-[var(--wb-field)] px-2 text-[var(--wb-text-3)] transition-colors duration-150 hover:text-[var(--wb-text-2)]"
        >
          <Search className="h-3.5 w-3.5" />
          <span className="flex-1 truncate text-left text-[13px]">{teaser}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} className="w-[420px] p-0">
        <FilterForm onDone={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

/** Clickable chip — opens the same form pre-filled, persists via updateFilter. */
function EditableFilterChip({
  filter,
  onRemove,
  onToggle,
}: {
  filter: Filter;
  onRemove: () => void;
  onToggle: () => void;
}) {
  const [open, setOpen] = useState(false);
  const showVal = filter.op !== 'IS NULL' && filter.op !== 'IS NOT NULL';
  const enabled = filter.enabled !== false;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <span
        className={cn(
          'inline-flex h-6 items-center gap-1 rounded-[6px] bg-[var(--wb-control)] text-[13px]',
          !enabled && 'opacity-55',
        )}
      >
        <button
          type="button"
          // biome-ignore lint/a11y/useSemanticElements: styled toggle, same pattern as the design-system checkbox
          role="checkbox"
          aria-checked={enabled}
          onClick={onToggle}
          aria-label={`${enabled ? 'Disable' : 'Enable'} filter on ${filter.column}`}
          title={enabled ? 'Disable this filter' : 'Enable this filter'}
          className="ml-1 grid h-3.5 w-3.5 shrink-0 cursor-pointer place-items-center rounded-[3px] ring-1 ring-inset ring-[var(--wb-text-3)] transition-colors hover:ring-[var(--wb-text-2)]"
        >
          {enabled && <Check className="h-2.5 w-2.5 text-[var(--wb-text)]" />}
        </button>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex h-full cursor-pointer items-center gap-1 px-1.5 transition-colors duration-150 hover:bg-[var(--wb-control-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--wb-accent)]"
            title="Edit filter"
          >
            <span className="font-mono font-medium text-[var(--wb-text)]">{filter.column}</span>
            <span className="text-[var(--wb-text-2)]">{operatorLabel(filter.op)}</span>
            {showVal && (
              <span className="max-w-[160px] truncate font-mono text-[var(--wb-text)]">
                {filter.value || "''"}
              </span>
            )}
          </button>
        </PopoverTrigger>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove filter on ${filter.column}`}
          className="grid h-4 w-4 shrink-0 cursor-pointer place-items-center rounded-[4px] text-[var(--wb-text-2)] transition-colors duration-150 hover:bg-[var(--wb-control-hover)] hover:text-[var(--wb-text)] focus-visible:opacity-100"
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
            'inline-flex h-6 cursor-pointer items-center gap-1 rounded-[6px] px-2 text-[13px] transition-colors duration-150',
            hasAny
              ? 'text-[var(--wb-text-2)] hover:bg-[var(--wb-control)] hover:text-[var(--wb-text)]'
              : 'bg-[var(--wb-control)] text-[var(--wb-text)] hover:bg-[var(--wb-control-hover)]',
          )}
        >
          <Plus className="h-3 w-3" />
          <span>{hasAny ? 'Add more filters' : 'Add filter'}</span>
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

  const columns = useMemo(() => {
    if (!tab || tab.kind !== 'table' || !tab.tableSchema || !tab.tableName) return [];
    return (
      schema?.columns
        .filter((c) => c.schema === tab.tableSchema && c.table === tab.tableName)
        .sort((a, b) => a.ordinal - b.ordinal) ?? []
    );
  }, [tab, schema]);

  // VF15: preselect the grid's selected column (else the first column) so
  // Enter always has something to apply, with that type's default operator.
  // biome-ignore lint/correctness/useExhaustiveDependencies: initial value only (not a live binding)
  const initialColumn = useMemo(() => {
    if (existing) return existing.column;
    const selCol = tab?.selectedCell?.col;
    const selName = selCol === undefined ? undefined : tab?.queryResult?.columns[selCol]?.name;
    if (selName && columns.some((c) => c.name === selName)) return selName;
    return columns[0]?.name ?? '';
  }, [existing, columns.length]);

  const [column, setColumn] = useState(initialColumn);
  const [op, setOp] = useState<FilterOp>(
    existing?.op ?? defaultOperatorFor(columns.find((c) => c.name === initialColumn)?.dataType),
  );
  const [value, setValue] = useState(existing?.value ?? '');
  const [touched, setTouched] = useState(false);

  // If the popover is reopened with a different filter, sync state.
  useEffect(() => {
    if (existing) {
      setColumn(existing.column);
      setOp(existing.op);
      setValue(existing.value);
    }
  }, [existing]);

  // Columns can arrive after the form opened (lazy introspection).
  useEffect(() => {
    if (!column && initialColumn) {
      setColumn(initialColumn);
      setOp(defaultOperatorFor(columns.find((c) => c.name === initialColumn)?.dataType));
    }
  }, [column, initialColumn, columns]);

  const selectedColumnMeta = columns.find((c) => c.name === column);
  const operatorGroups = useMemo(
    () => operatorsFor(selectedColumnMeta?.dataType),
    [selectedColumnMeta?.dataType],
  );

  const handleColumn = (next: string) => {
    setColumn(next);
    const meta = columns.find((c) => c.name === next);
    const allowed = operatorsFor(meta?.dataType).flatMap((g) => g.operators.map((o) => o.value));
    // Keep the operator when it still applies; else the type's default.
    if (!existing || !allowed.includes(op)) setOp(defaultOperatorFor(meta?.dataType));
  };

  const needsValue = op !== 'IS NULL' && op !== 'IS NOT NULL';
  const listOp = op === 'IN' || op === 'NOT IN';
  const validation = !column
    ? 'Pick a column'
    : needsValue && value.trim().length === 0
      ? 'Enter a value'
      : op === 'BETWEEN' && !betweenBounds(value)
        ? 'Enter two values: low, high'
        : listOp && splitFilterList(value).length === 0
          ? 'Enter one or more values, separated by commas'
          : null;
  const canSave = validation === null;

  const handleSave = () => {
    setTouched(true);
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

  const placeholder = listOp ? 'a, b, c' : op === 'BETWEEN' ? 'low, high' : 'value';

  return (
    <div className="flex flex-col gap-2 p-4">
      <div className="flex items-center gap-2">
        <ColumnCombobox columns={columns} value={column} onChange={handleColumn} />
        <Select value={op} onValueChange={(v) => setOp(v as FilterOp)}>
          <SelectTrigger className="h-8 w-[160px] shrink-0 text-[13px]" aria-label="Operator">
            {/* Explicit label: the trigger always shows the operator that will be applied. */}
            <SelectValue>{operatorLabel(op)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {operatorGroups.map((group) => (
              <SelectGroup key={group.heading}>
                <SelectLabel className="text-[12px] font-normal text-[var(--wb-text-2)]">
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
      {needsValue &&
      !listOp &&
      op !== 'BETWEEN' &&
      tab &&
      tab.kind === 'table' &&
      tab.tableSchema &&
      tab.tableName &&
      column ? (
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
            placeholder={placeholder}
            aria-label="Filter value"
            className="h-8 text-[13px]"
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSave();
            }}
          />
        )
      )}
      <div className="flex items-center gap-2">
        <span
          className="min-w-0 flex-1 text-[12px] text-destructive"
          role={touched && validation ? 'alert' : undefined}
        >
          {touched ? validation : null}
        </span>
        <Button variant="secondary" size="sm" onClick={handleSave}>
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
    </div>
  );
}

/** The compiled SELECT behind the current filters (F6 "SQL preview"). */
function SqlPreview({ sql }: { sql: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Show the query for these filters"
          title="Show the query for these filters"
          className="grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-[6px] text-[var(--wb-text-2)] transition-colors hover:bg-[var(--wb-control)] hover:text-[var(--wb-text)]"
        >
          <Code2 className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={4} className="w-[460px] max-w-[90vw] p-0">
        <div className="flex items-center justify-between border-b border-[var(--wb-separator)] px-3 py-1.5 text-[12px] text-[var(--wb-text-2)]">
          <span>Query sent for this view</span>
          <button
            type="button"
            className="cursor-pointer rounded-[4px] px-1.5 hover:bg-[var(--wb-control)] hover:text-[var(--wb-text)]"
            onClick={() => void navigator.clipboard.writeText(sql).catch(() => undefined)}
          >
            Copy
          </button>
        </div>
        <pre className="max-h-[260px] overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[12px] text-[var(--wb-text)]">
          {sql || '—'}
        </pre>
      </PopoverContent>
    </Popover>
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
            'flex h-8 flex-1 cursor-pointer items-center justify-between gap-2 rounded-md border border-input bg-[var(--wb-content)] px-3 text-[13px] shadow-sm transition-colors duration-150',
            'hover:bg-[var(--wb-control)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          )}
        >
          {selected ? (
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="truncate font-mono">{selected.name}</span>
              <span className="shrink-0 text-[var(--wb-text-2)]">{selected.dataType}</span>
            </span>
          ) : (
            <span className="text-[var(--wb-text-2)]">column…</span>
          )}
          <ChevronsUpDown className="h-3 w-3 shrink-0 text-[var(--wb-text-2)]" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} className="w-[320px] p-0">
        <Command className="flex flex-col">
          <div className="flex items-center gap-2 border-b border-[var(--wb-separator)] px-3 py-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-[var(--wb-text-2)]" />
            <Command.Input
              placeholder="Search columns…"
              className="h-6 flex-1 border-0 bg-transparent text-[13px] text-[var(--wb-text)] outline-none placeholder:text-[var(--wb-text-2)]"
            />
          </div>
          <Command.List className="max-h-[280px] overflow-y-auto p-1">
            <Command.Empty className="px-3 py-3 text-[13px] text-[var(--wb-text-2)]">
              No matching column
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
                    'flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-[13px] transition-colors',
                    'data-[selected=true]:bg-[var(--wb-selected)] data-[selected=true]:text-[var(--wb-text)]',
                    active && 'text-[var(--wb-text)]',
                  )}
                >
                  {active ? (
                    <Check className="h-3 w-3 text-[var(--wb-accent)]" />
                  ) : (
                    <span className="h-3 w-3" aria-hidden />
                  )}
                  <span className="flex min-w-0 flex-1 items-baseline gap-2">
                    <span className="truncate font-mono">{c.name}</span>
                    <span className="shrink-0 text-[var(--wb-text-2)]">{c.dataType}</span>
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
 * Free-text value input with an inline suggestion list beneath. As the
 * user types, we debounce-fetch DISTINCT values from the underlying
 * column (capped at 20). Click on a suggestion fills the field.
 *
 * Suggestions are best-effort — RLS, permissions, and column-not-text
 * coercion failures all fall back to a silent empty list, leaving the
 * input as a plain text field.
 *
 * We deliberately avoid Radix Popover here — the parent FilterForm is
 * already inside a Popover, and nesting one inside another causes the
 * trigger to swallow keystrokes and steal focus from the input. A
 * plain absolutely-positioned div sidesteps that.
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
  const [show, setShow] = useState(false);
  const [sample, setSample] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // A7/F12: load a bounded sample of distinct values once per column (on
  // the side connection, read-only, short timeout) and filter it locally
  // as the user types — keystrokes never query the database.
  useEffect(() => {
    if (!show) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const { sql, params } = buildDistinctValuesSql(
          schema,
          table,
          column,
          '',
          dialectFor(useSession.getState().activeConfig?.engine),
        );
        const res = await ipc.query.sideband(sql, params, { timeoutMs: 5_000 });
        if (cancelled) return;
        setSample(
          res.rows
            .map((r) => (r[0] === null || r[0] === undefined ? '' : String(r[0])))
            .filter((s) => s.length > 0),
        );
      } catch {
        if (!cancelled) setSample([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [schema, table, column, show]);
  const suggestions = useMemo(() => filterSuggestions(sample, value), [sample, value]);

  // The suggestion buttons live OUTSIDE the input, so a normal blur
  // event would close the list before the click registers. We delay
  // closing on blur and short-circuit it if the new focus target is the
  // suggestion list itself.
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelBlur = () => {
    if (blurTimer.current) {
      clearTimeout(blurTimer.current);
      blurTimer.current = null;
    }
  };

  return (
    <div className="relative">
      <Input
        ref={inputRef}
        value={value}
        autoComplete="off"
        spellCheck={false}
        onFocus={() => {
          cancelBlur();
          setShow(true);
        }}
        onBlur={() => {
          cancelBlur();
          blurTimer.current = setTimeout(() => setShow(false), 120);
        }}
        onChange={(e) => {
          onChange(e.target.value);
          if (!show) setShow(true);
        }}
        placeholder="value"
        className="h-8 text-[13px]"
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            // Enter: if the suggestion panel is closed OR matches the
            // typed value exactly, save. Otherwise close suggestions.
            if (show && suggestions.length > 0 && suggestions[0] !== value) {
              setShow(false);
            } else {
              onEnter();
            }
          } else if (e.key === 'Escape' && show) {
            setShow(false);
            e.stopPropagation();
          }
        }}
      />
      {show && (
        <div
          // mousedown on a child would otherwise blur the input first —
          // the wrapper preventDefault stops blur, preserving focus.
          onMouseDown={(e) => {
            e.preventDefault();
            cancelBlur();
          }}
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-[200px] overflow-y-auto rounded-md border border-[var(--wb-separator)] bg-popover text-popover-foreground shadow-md"
        >
          {loading && suggestions.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-2 text-[13px] text-[var(--wb-text-2)]">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>looking up values…</span>
            </div>
          ) : suggestions.length === 0 ? (
            <div className="px-3 py-2 text-[13px] text-[var(--wb-text-2)]">no suggestions</div>
          ) : (
            <div className="py-1">
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => {
                    onChange(s);
                    setShow(false);
                    inputRef.current?.focus();
                  }}
                  className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left font-mono text-[13px] text-[var(--wb-text)] transition-colors hover:bg-[var(--wb-control-hover)] hover:text-[var(--wb-text)]"
                >
                  <span className="truncate">{s}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
