import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { IconButton, MenuItem } from '@/components/ui/workbench';
import { SidebarSearch } from '@/features/sidebar/sidebar-parts';
import { cn } from '@/lib/cn';
import { ipc } from '@/lib/ipc';
import { quoteIdent } from '@/lib/table-query';
import { useActiveTab, useSession } from '@/stores/session';
import { useWorkbench } from '@/stores/workbench';
import type { ColumnMeta } from '@shared/protocol';
import { Braces, Check, Copy, SlidersHorizontal } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

/**
 * Right-sidebar "Details" pane — the TablePlus row inspector.
 *
 *   - With a selected cell: every field of that row, vertically, with
 *     type labels, pretty-printed JSON, per-field copy and a field
 *     search. The selected column is highlighted.
 *   - Without a selection on a table tab: table overview (sizes,
 *     estimated rows, comment).
 *   - Otherwise an explicit "No row selected" state.
 *
 * The grid publishes the row via `useWorkbench.inspectedRow` because
 * only it knows how display rows map to result rows (sort / paging).
 */
export function DetailsPanel() {
  const tab = useActiveTab();
  const inspected = useWorkbench((s) => s.inspectedRow);
  const [query, setQuery] = useState('');
  const [copiedRow, setCopiedRow] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const current = inspected && tab && inspected.tabId === tab.id ? inspected : null;

  const fields = useMemo(() => {
    if (!current) return [];
    const q = query.trim().toLowerCase();
    return current.columns
      .map((col, i) => ({ col, value: current.row[i], index: i }))
      .filter(({ col }) => (q ? col.name.toLowerCase().includes(q) : true));
  }, [current, query]);

  const copyRowJson = () => {
    if (!current) return;
    const obj: Record<string, unknown> = {};
    current.columns.forEach((c, i) => {
      obj[c.name] = current.row[i];
    });
    void navigator.clipboard?.writeText(JSON.stringify(obj, null, 2)).then(() => {
      setCopiedRow(true);
      setTimeout(() => {
        setCopiedRow(false);
        setMenuOpen(false);
      }, 600);
    });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1.5 px-2.5 pb-2">
        <SidebarSearch
          value={query}
          onChange={setQuery}
          placeholder="Search for field…"
          ariaLabel="Search fields"
          disabled={!current}
        />
        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <PopoverTrigger asChild>
            <IconButton variant="plain" label="Row options" className="[&_svg]:h-4 [&_svg]:w-4">
              <SlidersHorizontal />
            </IconButton>
          </PopoverTrigger>
          <PopoverContent align="end" sideOffset={4} className="w-[220px] p-1" role="menu">
            <MenuItem
              icon={copiedRow ? <Check /> : <Braces />}
              label="Copy row as JSON"
              hint={current ? `row ${current.rowNumber.toLocaleString()}` : undefined}
              disabled={!current}
              onClick={copyRowJson}
            />
          </PopoverContent>
        </Popover>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {current ? (
          fields.length === 0 ? (
            <div className="px-4 py-3 text-[13px] text-[var(--wb-text-2)]">
              no field matches "{query}"
            </div>
          ) : (
            fields.map(({ col, value, index }) => (
              <FieldRow
                key={`${col.name}-${index}`}
                col={col}
                value={value}
                selected={index === current.columnIndex}
              />
            ))
          )
        ) : (
          <>
            <div className="flex min-h-[120px] flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
              <div className="text-[16px] text-[var(--wb-text-2)]">No row selected</div>
              <div className="text-[11px] text-[var(--wb-text-3)]">
                Select a cell in the grid — or press Enter on one — to inspect its row here.
              </div>
            </div>
            {tab?.kind === 'table' && tab.tableSchema && tab.tableName && (
              <TableOverview schema={tab.tableSchema} table={tab.tableName} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function FieldRow({
  col,
  value,
  selected,
}: {
  col: ColumnMeta;
  value: unknown;
  selected: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const isNullish = value === null || value === undefined;
  const isEmpty = value === '';
  const text = formatValue(value);
  const multiline = text.includes('\n') || text.length > 80;

  const copy = () => {
    const raw = isNullish ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    void navigator.clipboard?.writeText(raw).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1000);
    });
  };

  return (
    <div
      className={cn(
        'group/field mx-1.5 rounded-[5px] px-2 py-1.5',
        selected && 'bg-[var(--wb-selected)]',
      )}
    >
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 truncate text-[13px] font-semibold text-[var(--wb-text)]">
          {col.name}
        </span>
        <span className="shrink-0 text-[11px] text-[var(--wb-text-3)]">{col.dataTypeName}</span>
        <div className="flex-1" />
        <IconButton
          variant="plain"
          label={`Copy ${col.name}`}
          title="Copy value"
          onClick={copy}
          className="h-5 w-5 opacity-0 transition-opacity group-hover/field:opacity-100 focus-visible:opacity-100 [&_svg]:h-3 [&_svg]:w-3"
        >
          {copied ? <Check /> : <Copy />}
        </IconButton>
      </div>
      {isNullish ? (
        <div className="font-mono text-[12px] text-[var(--grid-null)]">NULL</div>
      ) : isEmpty ? (
        <div className="font-mono text-[12px] text-[var(--wb-text-3)]">(empty string)</div>
      ) : (
        <pre
          className={cn(
            'mt-0.5 font-mono text-[12px] text-[var(--wb-text)]',
            multiline
              ? 'max-h-60 overflow-auto whitespace-pre rounded-[5px] bg-[var(--wb-field)] p-2'
              : 'whitespace-pre-wrap break-words',
          )}
        >
          {text}
        </pre>
      )}
    </div>
  );
}

interface Overview {
  total: string;
  data: string;
  index: string;
  estimate: string;
  comment: string;
}

/** Sizes + comment for the open table — shown when no row is selected. */
function TableOverview({ schema, table }: { schema: string; table: string }) {
  const connectionState = useSession((s) => s.connectionState);
  const [info, setInfo] = useState<Overview | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (connectionState !== 'connected') return;
    let cancelled = false;
    setInfo(null);
    setFailed(false);
    (async () => {
      try {
        const res = await ipc.query.run(
          `SELECT pg_size_pretty(pg_total_relation_size(c.oid)),
                  pg_size_pretty(pg_relation_size(c.oid)),
                  pg_size_pretty(pg_indexes_size(c.oid)),
                  GREATEST(c.reltuples, 0)::bigint::text,
                  COALESCE(obj_description(c.oid, 'pg_class'), '')
             FROM pg_class c
            WHERE c.oid = $1::regclass`,
          [`${quoteIdent(schema)}.${quoteIdent(table)}`],
          { internal: true },
        );
        const r = res.rows[0];
        if (cancelled) return;
        if (!r) {
          setFailed(true);
          return;
        }
        setInfo({
          total: String(r[0] ?? ''),
          data: String(r[1] ?? ''),
          index: String(r[2] ?? ''),
          estimate: String(r[3] ?? ''),
          comment: String(r[4] ?? ''),
        });
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [schema, table, connectionState]);

  return (
    <div className="mx-2.5 mb-3 shrink-0 rounded-[7px] bg-[var(--wb-control)]/60 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--wb-text)_8%,transparent)]">
      <div className="border-b border-[color-mix(in_srgb,var(--wb-text)_8%,transparent)] px-3 py-2">
        <div className="text-[13px] font-semibold text-[var(--wb-text)]">Table</div>
        <div className="truncate font-mono text-[12px] text-[var(--wb-text-2)]">
          {schema}.{table}
        </div>
      </div>
      {failed ? (
        <div className="px-3 py-2 text-[12px] text-[var(--wb-text-2)]">
          size information unavailable for this role
        </div>
      ) : !info ? (
        <div className="px-3 py-2 text-[12px] text-[var(--wb-text-2)]">loading…</div>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-3 py-2 text-[12px]">
          <Stat label="Total size" value={info.total} />
          <Stat label="Data" value={info.data} />
          <Stat label="Indexes" value={info.index} />
          <Stat label="Rows (est.)" value={Number(info.estimate).toLocaleString()} />
          {info.comment && (
            <>
              <dt className="text-[var(--wb-text-2)]">Comment</dt>
              <dd className="text-[var(--wb-text)]">{info.comment}</dd>
            </>
          )}
        </dl>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-[var(--wb-text-2)]">{label}</dt>
      <dd className="text-right font-mono tabular-nums text-[var(--wb-text)]">{value}</dd>
    </>
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
  // JSON stored as text: pretty-print when it parses to an object/array.
  if (typeof value === 'string' && /^\s*[[{]/.test(value)) {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return String(value);
}
