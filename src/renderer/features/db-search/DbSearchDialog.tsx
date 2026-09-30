import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/view-parts';
import { CheckLine } from '@/features/backup/admin-parts';
import { cn } from '@/lib/cn';
import { cleanIpcError } from '@/lib/errors';
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import {
  DEFAULT_SEARCH_CLASSES,
  DEFAULT_SEARCH_LIMIT,
  SEARCH_CLASS_LABEL,
  SEARCH_OPS,
  type SearchColumnClass,
  type SearchOp,
  buildTableSearch,
  cellMatches,
  orderForSearch,
  rowFilters,
} from '@shared/pg-search';
import { ChevronDown, ChevronRight, Search, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';

const CLASS_CHOICES: SearchColumnClass[] = [
  'text',
  'number',
  'uuid',
  'datetime',
  'boolean',
  'json',
];
const STATEMENT_TIMEOUT_MS = 10_000;
const ALL = '__all__';
const SHOWN_ROWS = 100;

interface TableHit {
  key: string;
  schema: string;
  table: string;
  columns: string[];
  rows: { id: string; cells: unknown[] }[];
  matched: string[];
  limited: boolean;
  error?: string;
}

interface Progress {
  done: number;
  total: number;
  current: string;
}

export function DbSearchDialog({
  open,
  onOpenChange,
}: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const schemaInfo = useSession((s) => s.schema);
  const ensureAll = useSession((s) => s.ensureAllSchemaColumns);
  const openForeignRow = useSession((s) => s.openForeignRow);

  const [term, setTerm] = useState('');
  const [op, setOp] = useState<SearchOp>('contains');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [classes, setClasses] = useState<Set<SearchColumnClass>>(new Set(DEFAULT_SEARCH_CLASSES));
  const [limit, setLimit] = useState(String(DEFAULT_SEARCH_LIMIT));
  const [schemaName, setSchemaName] = useState(ALL);
  const [tableFilter, setTableFilter] = useState('');
  const [hits, setHits] = useState<TableHit[]>([]);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [searched, setSearched] = useState<{
    term: string;
    op: SearchOp;
    caseSensitive: boolean;
  } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [note, setNote] = useState<string | null>(null);
  const cancelRef = useRef(false);
  const running = progress !== null;

  const schemas = useMemo(
    () =>
      (schemaInfo?.schemas ?? [])
        .map((s) => s.name)
        .filter((n) => !n.startsWith('pg_') && n !== 'information_schema'),
    [schemaInfo],
  );

  const run = async () => {
    if (!term || running) return;
    cancelRef.current = false;
    setHits([]);
    setNote(null);
    setCollapsed(new Set());
    setSearched({ term, op, caseSensitive });
    setProgress({ done: 0, total: 0, current: 'Loading columns…' });
    try {
      await ensureAll();
      const info = useSession.getState().schema;
      if (!info) throw new Error('Schema is not loaded yet.');
      const needle = tableFilter.trim().toLowerCase();
      const tables = orderForSearch(
        info.tables.filter(
          (t) =>
            (t.kind === 'table' ||
              t.kind === 'partitioned' ||
              t.kind === 'matview' ||
              t.kind === 'foreign') &&
            !t.partitionOf &&
            (schemaName === ALL
              ? !t.schema.startsWith('pg_') && t.schema !== 'information_schema'
              : t.schema === schemaName) &&
            (needle === '' || t.name.toLowerCase().includes(needle)),
        ),
      );
      const spec = {
        term,
        op,
        caseSensitive,
        classes: [...classes],
        limit: Number.parseInt(limit, 10),
      };
      const plan = tables.flatMap((t) => {
        const cols = info.columns
          .filter((c) => c.schema === t.schema && c.table === t.name)
          .sort((a, b) => a.ordinal - b.ordinal)
          .map((c) => ({ name: c.name, dataType: c.dataType }));
        const q = buildTableSearch(t.schema, t.name, cols, spec);
        return q ? [{ t, q }] : [];
      });
      setProgress({ done: 0, total: plan.length, current: '' });
      let done = 0;
      for (const { t, q } of plan) {
        if (cancelRef.current) break;
        const name = `${t.schema}.${t.name}`;
        setProgress({ done, total: plan.length, current: name });
        try {
          // Aux connection: read-only transaction under a statement timeout.
          const res = await ipc.query.sideband(q.sql, q.params, {
            timeoutMs: STATEMENT_TIMEOUT_MS,
          });
          if (res.rows.length > 0) {
            setHits((h) => [
              ...h,
              {
                key: name,
                schema: t.schema,
                table: t.name,
                columns: res.columns.map((c) => c.name),
                rows: res.rows.map((cells, n) => ({ id: `${name}:${n}`, cells })),
                matched: q.columns,
                limited: res.rows.length >= (Number.parseInt(limit, 10) || DEFAULT_SEARCH_LIMIT),
              },
            ]);
          }
        } catch (err) {
          const message = cleanIpcError(err instanceof Error ? err.message : String(err));
          setHits((h) => [
            ...h,
            {
              key: name,
              schema: t.schema,
              table: t.name,
              columns: [],
              rows: [],
              matched: [],
              limited: false,
              error: message,
            },
          ]);
        }
        done++;
      }
      setProgress(null);
      if (cancelRef.current) setNote(`Canceled after ${done} of ${plan.length} tables.`);
      else setNote(`Searched ${plan.length} table${plan.length === 1 ? '' : 's'}.`);
    } catch (err) {
      setProgress(null);
      setNote(cleanIpcError(err instanceof Error ? err.message : String(err)));
    }
  };

  const openRow = (hit: TableHit, row: unknown[]) => {
    const pk = (schemaInfo?.columns ?? [])
      .filter((c) => c.schema === hit.schema && c.table === hit.table && c.isPrimaryKey)
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((c) => c.name);
    const filters = rowFilters(
      hit.columns,
      row,
      pk,
      hit.matched.filter((c) => searched && cellMatches(row[hit.columns.indexOf(c)], searched)),
    );
    const [first, ...rest] = filters;
    if (!first) return;
    openForeignRow(hit.schema, hit.table, first.column, first.value, rest);
    onOpenChange(false);
  };

  const totalRows = hits.reduce((n, h) => n + h.rows.length, 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[78vh] max-w-[860px] flex-col"
        data-testid="db-search-dialog"
      >
        <DialogHeader>
          <DialogTitle>Search in database</DialogTitle>
          <DialogDescription>
            Find a text or number across tables. Runs read-only with a {STATEMENT_TIMEOUT_MS / 1000}
            s limit per table.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <div className="flex gap-2">
            <Select value={op} onValueChange={(v) => setOp(v as SearchOp)}>
              <SelectTrigger className="w-[150px]" aria-label="Operator">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SEARCH_OPS.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Text or number to find"
              aria-label="Search term"
              autoFocus
            />
            {running ? (
              <Button
                variant="secondary"
                onClick={() => {
                  cancelRef.current = true;
                }}
              >
                <X /> Cancel
              </Button>
            ) : (
              <Button variant="primary" type="submit" disabled={!term}>
                <Search /> Search
              </Button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px] text-[var(--wb-text-2)]">
            <Select value={schemaName} onValueChange={setSchemaName}>
              <SelectTrigger className="w-[160px]" aria-label="Schema">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All schemas</SelectItem>
                {schemas.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              className="w-[150px]"
              value={tableFilter}
              onChange={(e) => setTableFilter(e.target.value)}
              placeholder="Table name contains"
              aria-label="Table filter"
            />
            <label htmlFor="ds-limit" className="flex items-center gap-2">
              Rows per table
              <Input
                id="ds-limit"
                className="w-16"
                inputMode="numeric"
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
                aria-label="Rows per table"
              />
            </label>
            <CheckLine
              id="ds-case"
              label="Match case"
              checked={caseSensitive}
              onChange={setCaseSensitive}
            />
          </div>
          <fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 border-0 p-0 text-[13px]">
            <legend className="sr-only">Column types</legend>
            <span className="text-[var(--wb-text-2)]">Columns of type</span>
            {CLASS_CHOICES.map((c) => (
              <CheckLine
                key={c}
                id={`ds-class-${c}`}
                label={SEARCH_CLASS_LABEL[c]}
                checked={classes.has(c)}
                onChange={(v) =>
                  setClasses((s) => {
                    const n = new Set(s);
                    if (v) n.add(c);
                    else n.delete(c);
                    return n;
                  })
                }
              />
            ))}
          </fieldset>
        </form>

        <output
          className="flex h-5 items-center gap-2 text-[12px] text-[var(--wb-text-2)]"
          aria-live="polite"
        >
          {progress ? (
            <>
              <span>
                {progress.total
                  ? `Searching ${progress.done + 1} of ${progress.total}`
                  : 'Preparing…'}
              </span>
              <span className="truncate text-[var(--wb-text-3)]">{progress.current}</span>
              {progress.total > 0 && (
                <span className="h-1 w-32 overflow-hidden rounded-full bg-[var(--wb-control)]">
                  <span
                    className="block h-full bg-[var(--wb-text-2)]"
                    style={{ width: `${(progress.done / progress.total) * 100}%` }}
                  />
                </span>
              )}
            </>
          ) : (
            searched && (
              <span>
                {note} {totalRows} row{totalRows === 1 ? '' : 's'} in{' '}
                {hits.filter((h) => !h.error).length} table{hits.length === 1 ? '' : 's'}.
              </span>
            )
          )}
        </output>

        <div className="min-h-0 flex-1 overflow-y-auto rounded-[7px] bg-[var(--wb-field)] shadow-[inset_0_0_0_1px_var(--wb-toolbar-group-edge)]">
          {hits.length === 0 && !running && (
            <p className="p-6 text-center text-[13px] text-[var(--wb-text-3)]">
              {searched ? 'No matches.' : 'Results are grouped by table. Click a row to open it.'}
            </p>
          )}
          {hits.map((hit) => {
            const isCollapsed = collapsed.has(hit.key);
            return (
              <section
                key={hit.key}
                className="border-b border-[var(--wb-separator)] last:border-b-0"
              >
                <button
                  type="button"
                  className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[13px] hover:bg-[var(--wb-control-hover)]"
                  aria-expanded={!isCollapsed}
                  onClick={() =>
                    setCollapsed((s) => {
                      const n = new Set(s);
                      if (n.has(hit.key)) n.delete(hit.key);
                      else n.add(hit.key);
                      return n;
                    })
                  }
                >
                  {isCollapsed ? (
                    <ChevronRight className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5" />
                  )}
                  <span className="font-medium text-[var(--wb-text)]">
                    {hit.schema}.{hit.table}
                  </span>
                  {hit.error ? (
                    <Badge tone="danger">Failed</Badge>
                  ) : (
                    <Badge>
                      {hit.rows.length}
                      {hit.limited ? '+' : ''} row{hit.rows.length === 1 ? '' : 's'}
                    </Badge>
                  )}
                </button>
                {hit.error && <p className="px-7 pb-2 text-[12px] text-destructive">{hit.error}</p>}
                {!isCollapsed && !hit.error && (
                  <div className="overflow-x-auto pb-1">
                    <table className="w-full border-collapse text-[12px]">
                      <thead>
                        <tr className="text-left text-[var(--wb-text-3)]">
                          {hit.columns.map((c) => (
                            <th key={c} className="whitespace-nowrap px-2 py-0.5 font-normal">
                              {c}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {hit.rows.slice(0, SHOWN_ROWS).map(({ id, cells: row }) => (
                          <tr
                            key={id}
                            className="cursor-pointer hover:bg-[var(--wb-control-hover)]"
                            tabIndex={0}
                            onClick={() => openRow(hit, row)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') openRow(hit, row);
                            }}
                            title="Open in table"
                          >
                            {row.map((cell, ci) => {
                              const hitCell =
                                searched !== null &&
                                hit.matched.includes(hit.columns[ci] ?? '') &&
                                cellMatches(cell, searched);
                              return (
                                <td
                                  key={hit.columns[ci]}
                                  className={cn(
                                    'max-w-[240px] truncate whitespace-nowrap px-2 py-0.5 text-[var(--wb-text-2)]',
                                    hitCell &&
                                      'bg-[color-mix(in_srgb,var(--wb-accent)_22%,transparent)] text-[var(--wb-text)]',
                                  )}
                                >
                                  {cell === null ? (
                                    <span className="text-[var(--wb-text-3)]">NULL</span>
                                  ) : typeof cell === 'object' ? (
                                    JSON.stringify(cell)
                                  ) : (
                                    String(cell)
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {hit.rows.length > SHOWN_ROWS && (
                      <p className="px-2 py-1 text-[12px] text-[var(--wb-text-3)]">
                        Showing the first {SHOWN_ROWS} rows.
                      </p>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
