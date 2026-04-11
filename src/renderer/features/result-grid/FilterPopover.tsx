import { useState } from "react";
import { Filter as FilterIcon, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useActiveTab, useSession } from "@/stores/session";
import type { Filter, FilterOp } from "@/lib/table-query";

const OPERATORS: Array<{ value: FilterOp; label: string }> = [
  { value: "=", label: "=" },
  { value: "!=", label: "!=" },
  { value: ">", label: ">" },
  { value: "<", label: "<" },
  { value: ">=", label: ">=" },
  { value: "<=", label: "<=" },
  { value: "ILIKE", label: "contains" },
  { value: "LIKE", label: "LIKE" },
  { value: "IS NULL", label: "is null" },
  { value: "IS NOT NULL", label: "is not null" },
];

function freshId(): string {
  return `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function FilterPopover() {
  const tab = useActiveTab();
  const schema = useSession((s) => s.schema);
  const addFilter = useSession((s) => s.addFilter);
  const removeFilter = useSession((s) => s.removeFilter);
  const clearFilters = useSession((s) => s.clearFilters);

  const [column, setColumn] = useState("");
  const [op, setOp] = useState<FilterOp>("=");
  const [value, setValue] = useState("");

  if (!tab || tab.kind !== "table" || !tab.tableSchema || !tab.tableName) return null;

  const columns =
    schema?.columns
      .filter((c) => c.schema === tab.tableSchema && c.table === tab.tableName)
      .sort((a, b) => a.ordinal - b.ordinal) ?? [];

  const needsValue = op !== "IS NULL" && op !== "IS NOT NULL";
  const canAdd = column.length > 0 && (!needsValue || value.trim().length > 0);
  const filters = tab.filters;

  const handleAdd = () => {
    if (!canAdd) return;
    const filter: Filter = { id: freshId(), column, op, value };
    void addFilter(filter);
    setValue("");
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant={filters.length > 0 ? "outline" : "ghost"}
          size="xs"
          className={filters.length > 0 ? "border-accent text-accent" : ""}
        >
          <FilterIcon />
          Filter
          {filters.length > 0 && (
            <span className="rounded-sm bg-accent px-1 text-xs leading-none py-0.5 text-paper">{filters.length}</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom" className="w-96 p-0">
        <div className="border-b border-border-soft px-4 py-2.5">
          <h3 className="font-mono text-xs uppercase text-ink-muted" style={{ letterSpacing: "0.10em" }}>
            Filters
          </h3>
        </div>

        {/* Active filters — compact rows */}
        {filters.length > 0 && (
          <div className="max-h-[200px] overflow-y-auto border-b border-border-soft">
            {filters.map((f) => (
              <div key={f.id} className="flex items-center gap-2 px-4 py-1.5 font-mono text-xs">
                <span className="truncate font-medium text-ink">{f.column}</span>
                <span className="shrink-0 text-ink-muted">{f.op}</span>
                {f.op !== "IS NULL" && f.op !== "IS NOT NULL" && (
                  <span className="truncate text-type-str">{f.value}</span>
                )}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="ml-auto h-5 w-5 shrink-0"
                  onClick={() => void removeFilter(f.id)}
                  aria-label={`Remove filter ${f.column}`}
                >
                  <X />
                </Button>
              </div>
            ))}
            <div className="flex justify-end px-4 py-1.5">
              <Button variant="ghost" size="xs" onClick={() => void clearFilters()} className="text-ink-muted">
                <Trash2 />
                Clear all
              </Button>
            </div>
          </div>
        )}

        {/* Add filter form */}
        <div className="flex flex-col gap-2 px-4 py-3">
          <div className="flex items-center gap-2">
            <select
              value={column}
              onChange={(e) => setColumn(e.target.value)}
              className="h-8 flex-1 min-w-0 border border-border-soft bg-paper-canvas px-2 font-mono text-xs text-ink outline-none focus:border-accent"
            >
              <option value="">column…</option>
              {columns.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
            <select
              value={op}
              onChange={(e) => setOp(e.target.value as FilterOp)}
              className="h-8 w-[100px] shrink-0 border border-border-soft bg-paper-canvas px-2 font-mono text-xs text-ink outline-none focus:border-accent"
            >
              {OPERATORS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          {needsValue && (
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="value"
              className="h-8 text-xs"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAdd();
              }}
            />
          )}
          <Button variant="secondary" size="sm" onClick={handleAdd} disabled={!canAdd} className="self-end">
            <Plus />
            Add filter
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
