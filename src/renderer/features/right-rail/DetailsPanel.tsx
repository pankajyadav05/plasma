import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { ipc } from '@/lib/ipc';
import { quoteIdent } from '@/lib/table-query';
import { useActiveTab, useSession } from '@/stores/session';
import { useWorkbench } from '@/stores/workbench';
import type { ColumnMeta } from '@shared/protocol';
import { Braces, Check, Copy, Search, X } from 'lucide-react';
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
export function DetailsPanel({ onClose }: { onClose: () => void }) {
  const tab = useActiveTab();
  const inspected = useWorkbench((s) => s.inspectedRow);
  const [query, setQuery] = useState('');
  const [copiedRow, setCopiedRow] = useState(false);

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
      setTimeout(() => setCopiedRow(false), 1000);
    });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border pl-3 pr-2">
        <span className="text-sm font-medium text-foreground">Details</span>
        {current && (
          <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
            row {current.rowNumber.toLocaleString()}
          </span>
        )}
        <div className="flex-1" />
        {current && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={copyRowJson}
            aria-label="Copy row as JSON"
            title="Copy row as JSON"
          >
            {copiedRow ? <Check className="text-primary" /> : <Braces />}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onClose}
          aria-label="Close panel"
          title="Close"
        >
          <X />
        </Button>
      </div>

      <div className="border-b border-border px-3 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search fields…"
            aria-label="Search fields"
            disabled={!current}
            className="h-8 w-full rounded-md border border-border bg-background pl-8 pr-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary disabled:opacity-50"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {current ? (
          fields.length === 0 ? (
            <div className="px-4 py-3 font-display text-sm italic text-muted-foreground">
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
            <div className="flex flex-col items-center gap-1 px-6 py-8 text-center">
              <div className="font-display text-base italic text-foreground">No row selected</div>
              <div className="font-display text-xs italic text-muted-foreground">
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
        'group/field border-b border-border px-3 py-2',
        selected && 'bg-accent shadow-[inset_3px_0_0_var(--primary)]',
      )}
    >
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 truncate font-mono text-xs font-medium text-foreground">
          {col.name}
        </span>
        <span className="shrink-0 font-mono text-[10px] uppercase text-muted-foreground">
          {col.dataTypeName}
        </span>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={copy}
          aria-label={`Copy ${col.name}`}
          title="Copy value"
          className="h-5 w-5 opacity-0 transition-opacity group-hover/field:opacity-100 focus-visible:opacity-100"
        >
          {copied ? <Check className="text-primary" /> : <Copy />}
        </Button>
      </div>
      {isNullish ? (
        <div className="font-mono text-xs text-[var(--type-null)]">NULL</div>
      ) : isEmpty ? (
        <div className="font-display text-xs italic text-muted-foreground">(empty string)</div>
      ) : (
        <pre
          className={cn(
            'mt-0.5 font-mono text-xs text-foreground',
            multiline
              ? 'max-h-60 overflow-auto whitespace-pre rounded-sm border border-border bg-muted/50 p-2'
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
    <div className="mx-3 mb-4 rounded-sm border border-border">
      <div className="border-b border-border px-3 py-2">
        <div className="font-display text-sm italic text-foreground">Table</div>
        <div className="truncate font-mono text-xs text-muted-foreground">
          {schema}.{table}
        </div>
      </div>
      {failed ? (
        <div className="px-3 py-2 font-display text-xs italic text-muted-foreground">
          size information unavailable for this role
        </div>
      ) : !info ? (
        <div className="px-3 py-2 font-display text-xs italic text-muted-foreground">loading…</div>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-3 py-2 text-xs">
          <Stat label="Total size" value={info.total} />
          <Stat label="Data" value={info.data} />
          <Stat label="Indexes" value={info.index} />
          <Stat label="Rows (est.)" value={Number(info.estimate).toLocaleString()} />
          {info.comment && (
            <>
              <dt className="text-muted-foreground">Comment</dt>
              <dd className="font-display italic text-foreground">{info.comment}</dd>
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
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-mono tabular-nums text-foreground">{value}</dd>
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
