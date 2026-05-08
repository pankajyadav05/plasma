import { Button } from '@/components/ui/button';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { cn } from '@/lib/cn';
import { useActiveTab, useSession } from '@/stores/session';
import { ChevronRight, Copy, GitBranch, Search } from 'lucide-react';
import { useMemo, useState } from 'react';

export interface CellDetail {
  columnName: string;
  dataTypeName: string;
  value: unknown;
  anchorRect: DOMRect;
}

/**
 * Full-value viewer for a single result-grid cell. Opens as a shadcn
 * Popover anchored to the clicked cell (or to the selected cell's rect
 * when invoked by Space). We use a virtual anchor — a zero-interaction
 * `position: fixed` span positioned to the cell's bounding rect — so
 * Radix's collision detection places the popover naturally next to the
 * cell instead of centering a dialog on the viewport.
 *
 * Now also surfaces:
 *   - Reverse FK navigation: for any cell whose column is the target of
 *     one or more FKs, show "Find rows referencing this" entries that
 *     open the child table filtered by the cell value.
 *   - JSON/JSONB tree: collapsible tree view for object values, with a
 *     filter input to search keys + leaf values.
 */
export function CellDetailDialog({
  detail,
  onOpenChange,
}: {
  detail: CellDetail | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);
  const tab = useActiveTab();
  const schema = useSession((s) => s.schema);
  const openForeignRow = useSession((s) => s.openForeignRow);

  const formatted = formatValue(detail?.value);
  const isMultiline = formatted.includes('\n') || formatted.length > 160;
  const isObject =
    detail?.value !== null && detail?.value !== undefined && typeof detail.value === 'object';

  // Reverse FK lookup: which child tables have an FK pointing at the
  // current (table, column)? We resolve against the introspected schema
  // and only render entries when we're sitting on a real table tab.
  const inboundFks = useMemo(() => {
    if (!tab || tab.kind !== 'table' || !tab.tableSchema || !tab.tableName) return [];
    if (!schema || !detail) return [];
    return schema.foreignKeys.filter(
      (fk) =>
        fk.refSchema === tab.tableSchema &&
        fk.refTable === tab.tableName &&
        fk.refColumn === detail.columnName,
    );
  }, [schema, tab, detail]);

  const handleCopy = () => {
    if (!detail) return;
    const text =
      detail.value === null || detail.value === undefined
        ? ''
        : typeof detail.value === 'object'
          ? JSON.stringify(detail.value)
          : String(detail.value);
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  const rect = detail?.anchorRect;
  const value = detail?.value;
  const cellValue = detail?.value;

  return (
    <Popover open={!!detail} onOpenChange={onOpenChange}>
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
        className="w-[480px] max-w-[92vw] p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex items-baseline justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            <div className="truncate font-mono text-sm font-semibold text-foreground">
              {detail?.columnName}
            </div>
            <div className="text-xs text-muted-foreground">{detail?.dataTypeName}</div>
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={handleCopy}
            aria-label="Copy value"
            title={copied ? 'Copied!' : 'Copy'}
          >
            <Copy className={cn(copied && 'text-primary')} />
          </Button>
        </div>

        <div className="max-h-[420px] overflow-auto bg-muted/40 p-3">
          {value === null || value === undefined ? (
            <span className="font-display text-sm italic text-muted-foreground">
              {value === null ? 'null' : 'undefined'}
            </span>
          ) : value === '' ? (
            <span className="font-display text-sm italic text-muted-foreground">
              (empty string)
            </span>
          ) : isObject ? (
            <JsonTree value={value} />
          ) : (
            <pre
              className={
                isMultiline
                  ? 'whitespace-pre font-mono text-xs text-foreground'
                  : 'whitespace-pre-wrap break-words font-mono text-xs text-foreground'
              }
            >
              {formatted}
            </pre>
          )}
        </div>

        {inboundFks.length > 0 && (
          <div className="border-t border-border bg-background px-3 py-2">
            <div className="mb-1 flex items-center gap-1.5 font-display text-[10px] uppercase tracking-wider text-muted-foreground">
              <GitBranch className="h-3 w-3" />
              referenced by
            </div>
            <div className="flex flex-col gap-0.5">
              {inboundFks.map((fk) => (
                <button
                  key={`${fk.schema}.${fk.table}.${fk.column}`}
                  type="button"
                  onClick={() => {
                    onOpenChange(false);
                    // We reuse openForeignRow but flip the direction: the
                    // child table is `fk.schema.fk.table`, filtered by
                    // `fk.column = cellValue`.
                    openForeignRow(fk.schema, fk.table, fk.column, cellValue);
                  }}
                  className="flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-xs transition-colors hover:bg-accent"
                >
                  <Search className="h-3 w-3 text-muted-foreground" />
                  <span className="font-mono">
                    {fk.schema}.{fk.table}
                  </span>
                  <span className="font-mono text-muted-foreground">.{fk.column}</span>
                  <ChevronRight className="ml-auto h-3 w-3 text-muted-foreground" />
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 px-4 py-2 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {value !== null && value !== undefined
              ? `${formatted.length.toLocaleString()} chars`
              : ''}
          </span>
          <span className="text-muted-foreground/80">Esc to close</span>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

// ─── JSON tree ─────────────────────────────────────────────────────

function JsonTree({ value }: { value: unknown }) {
  const [filter, setFilter] = useState('');
  const flat = useMemo(() => flatten(value, ''), [value]);
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return null;
    const matches = new Set<string>();
    for (const e of flat) {
      const text = `${e.path} ${formatLeaf(e.value)}`.toLowerCase();
      if (text.includes(q)) {
        // Mark this path AND every parent path so the tree stays connected.
        let p = e.path;
        while (p) {
          matches.add(p);
          p = p.replace(/\.[^.]+$|\[[^\]]+\]$/, '');
        }
        matches.add('');
      }
    }
    return matches;
  }, [flat, filter]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <Search className="h-3 w-3 text-muted-foreground" />
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter keys / values…"
          className="h-6 flex-1 border-0 bg-transparent font-mono text-[11px] text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>
      <Node value={value} path="" depth={0} matches={filtered} />
    </div>
  );
}

function Node({
  value,
  path,
  depth,
  matches,
}: {
  value: unknown;
  path: string;
  depth: number;
  matches: Set<string> | null;
}) {
  const [open, setOpen] = useState(depth < 2);
  if (matches && !matches.has(path) && depth > 0) return null;
  if (value === null) return <Leaf className="text-muted-foreground italic">null</Leaf>;
  if (typeof value !== 'object') return <Leaf>{formatLeaf(value)}</Leaf>;

  const isArray = Array.isArray(value);
  const entries = isArray
    ? (value as unknown[]).map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);

  return (
    <div className="font-mono text-[11px] leading-relaxed">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-foreground"
      >
        <ChevronRight
          className={cn('h-3 w-3 text-muted-foreground transition-transform', open && 'rotate-90')}
        />
        <span className="text-muted-foreground">
          {isArray ? `[${entries.length}]` : `{${entries.length}}`}
        </span>
      </button>
      {open && (
        <ul className="ml-3 border-l border-border/60 pl-2">
          {entries.map(([k, v]) => {
            const childPath = isArray ? `${path}[${k}]` : path ? `${path}.${k}` : k;
            return (
              <li key={k} className="flex items-baseline gap-1.5 py-0.5">
                <span className="text-primary">{k}</span>
                <span className="text-muted-foreground">:</span>
                <Node value={v} path={childPath} depth={depth + 1} matches={matches} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Leaf({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <span className={cn('font-mono text-[11px] text-foreground', className)}>{children}</span>;
}

function formatLeaf(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return JSON.stringify(v);
  return String(v);
}

interface FlatEntry {
  path: string;
  value: unknown;
}

function flatten(value: unknown, path: string, out: FlatEntry[] = []): FlatEntry[] {
  out.push({ path, value });
  if (value && typeof value === 'object') {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        flatten(value[i], `${path}[${i}]`, out);
      }
    } else {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        flatten(v, path ? `${path}.${k}` : k, out);
      }
    }
  }
  return out;
}
