import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { IconButton, MenuItem } from '@/components/ui/workbench';
import { usePresentation } from '@/features/presentation/presentation';
import { isRevealed, revealKey, useReveal } from '@/features/presentation/reveal-store';
import { ReferencedBy } from '@/features/result-grid/ReferencedBy';
import { SidebarSearch } from '@/features/sidebar/sidebar-parts';
import { cn } from '@/lib/cn';
import { cleanIpcError } from '@/lib/errors';
import { ipc } from '@/lib/ipc';
import { readableTypeName } from '@/lib/pg-types';
import { quoteIdent } from '@/lib/table-query';
import { useActiveTabSansSql, useSession } from '@/stores/session';
import {
  editKind,
  editsOf,
  pkValuesFromRow,
  rowKeyOf,
  tablePkNames,
} from '@/stores/session-pending-edits';
import { useWorkbench } from '@/stores/workbench';
import { type SensitiveKind, maskValue } from '@shared/masking';
import type { ColumnMeta } from '@shared/protocol';
import { engineCaps } from '@shared/sql-dialect';
import { Braces, Check, Copy, Eye, Pencil, SlidersHorizontal } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type FieldEditorKind,
  displayText,
  editorText,
  enumValuesFor,
  fieldEditorKind,
  validateFieldInput,
} from './details-fields';

/**
 * Right-sidebar "Details" pane — the TablePlus row inspector.
 *
 *   - With a selected cell: every field of that row, vertically, with
 *     type labels, pretty-printed JSON, per-field copy and a field
 *     search. The selected column is highlighted. On a writable table
 *     tab (edit mode on, not read-only, table has a primary key) each
 *     field gets a typed editor (bool / enum pickers, JSON, text, Set
 *     NULL). Edits are queued through the pending-edits store — the same
 *     tray / prod-tag confirmation as grid edits; nothing is written here.
 *   - Without a selection on a table tab: table overview (sizes,
 *     estimated rows, comment).
 *   - Otherwise an explicit "No row selected" state.
 *
 * The grid publishes the row via `useWorkbench.inspectedRow` because
 * only it knows how display rows map to result rows (sort / paging).
 */
export function DetailsPanel() {
  const tab = useActiveTabSansSql();
  const inspected = useWorkbench((s) => s.inspectedRow);
  const [query, setQuery] = useState('');
  const [copiedRow, setCopiedRow] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const current = inspected && tab && inspected.tabId === tab.id ? inspected : null;
  const engine = useSession((s) => s.activeConfig?.engine ?? 'postgres');
  const editable = useRowEditing(current?.row ?? null, current?.columns ?? null);
  const masking = useDetailsMasking(current);

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
      obj[c.name] = masking.isHidden(i) ? masking.maskedText(i, current.row[i]) : current.row[i];
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
          <>
            {fields.length === 0 ? (
              <div className="px-4 py-3 text-[13px] text-[var(--wb-text-2)]">
                no field matches "{query}"
              </div>
            ) : (
              fields.map(({ col, value, index }) => (
                <FieldRow
                  key={`${col.name}-${index}`}
                  col={col}
                  value={value}
                  columnIndex={index}
                  selected={index === current.columnIndex}
                  editing={masking.isHidden(index) ? null : editable}
                  hidden={masking.isHidden(index)}
                  maskedText={masking.isHidden(index) ? masking.maskedText(index, value) : null}
                  onReveal={() => masking.reveal(index)}
                />
              ))
            )}
            {tab?.kind === 'table' && tab.tableSchema && tab.tableName && (
              <ReferencedBy
                schemaName={tab.tableSchema}
                tableName={tab.tableName}
                columns={current.columns}
                row={current.row}
              />
            )}
          </>
        ) : (
          <>
            <div className="flex min-h-[120px] flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
              <div className="text-[16px] text-[var(--wb-text-2)]">No row selected</div>
              <div className="text-[12px] text-[var(--wb-text-3)]">
                {emptyHint(engine, tab?.kind, Boolean(tab?.queryResult))}
              </div>
            </div>
            {engineCaps(engine).pgExtras &&
              tab?.kind === 'table' &&
              tab.tableSchema &&
              tab.tableName && <TableOverview schema={tab.tableSchema} table={tab.tableName} />}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Presentation mode for the inspected row: the grid says which columns are
 * sensitive (`maskedColumns`); a revealed cell shows its real value for a
 * few seconds, shared with the grid through the reveal store.
 */
function useDetailsMasking(
  current: {
    tabId: string;
    columns: ColumnMeta[];
    maskedColumns?: Record<number, SensitiveKind>;
    resultRowIndex?: number;
  } | null,
) {
  const { active, style } = usePresentation();
  const revealed = useReveal((s) => s.revealed);
  return useMemo(() => {
    const masked = active ? (current?.maskedColumns ?? {}) : {};
    const key = (i: number) => revealKey(current?.tabId ?? '', current?.resultRowIndex ?? -1, i);
    return {
      isHidden: (i: number) => i in masked && !isRevealed(revealed, key(i)),
      maskedText: (i: number, value: unknown): string | null => {
        if (value === null || value === undefined) return null;
        const col = current?.columns[i];
        const text = displayText(value, col?.dataTypeName);
        return (maskValue(text, masked[i] ?? 'custom', style) as string) ?? null;
      },
      reveal: (i: number) => useReveal.getState().reveal(key(i)),
    };
  }, [active, style, current, revealed]);
}

/** Per-engine / per-view hint under "No row selected" (VF28). */
function emptyHint(engine: string, tabKind: string | undefined, hasResult: boolean): string {
  if (engine === 'redis') {
    return 'Select an element of a hash, list, set, sorted set or stream to see it here.';
  }
  if (engine === 'opensearch') {
    return 'Select a document, hit or mapping row to see its fields here.';
  }
  if (tabKind === 'sql' && !hasResult) {
    return 'Run a query, then select a cell to inspect its row here.';
  }
  return 'Select a cell in the grid — or press Enter on one — to inspect its row here.';
}

interface RowEditing {
  /** Index of the row in the tab's result rows (for `updateCell`). */
  rowIndex: number;
  /** Pending update values for this row, by column name. */
  pending: Map<string, string | null>;
  enumFor: (typeName: string) => string[] | null;
}

/**
 * Whether the inspected row can be edited from the Details pane, and the
 * pending (queued, uncommitted) values already recorded for it.
 */
function useRowEditing(row: unknown[] | null, columns: ColumnMeta[] | null): RowEditing | null {
  const tab = useActiveTabSansSql();
  const editMode = useSession((s) => s.editMode);
  const readOnly = useSession((s) => Boolean(s.activeConfig?.readOnly));
  const schema = useSession((s) => s.schema);
  const pendingEdits = useSession((s) => editsOf(s.pendingEditsByTab, tab?.id));

  return useMemo(() => {
    if (!row || !columns || !tab || tab.kind !== 'table' || !editMode || readOnly) return null;
    const rows: unknown[][] | undefined = tab.queryResult?.rows;
    const rowIndex = rows ? rows.indexOf(row) : -1;
    if (rowIndex < 0) return null;
    const pkNames = tablePkNames(schema, tab.tableSchema, tab.tableName);
    const pk = pkValuesFromRow(columns, row, pkNames);
    if (!pk) return null;
    const key = rowKeyOf(pk);
    const pending = new Map<string, string | null>();
    for (const e of pendingEdits) {
      if (e.tabId !== tab.id || editKind(e) !== 'update') continue;
      if ((e.rowKey ?? rowKeyOf(e.pkValues)) === key) pending.set(e.column, e.newValue);
    }
    return { rowIndex, pending, enumFor: (t: string) => enumValuesFor(schema, t) };
  }, [row, columns, tab, editMode, readOnly, schema, pendingEdits]);
}

function FieldRow({
  col,
  value,
  columnIndex,
  selected,
  editing,
  hidden,
  maskedText,
  onReveal,
}: {
  col: ColumnMeta;
  value: unknown;
  columnIndex: number;
  selected: boolean;
  editing: RowEditing | null;
  /** Presentation mode: the value is masked until revealed. */
  hidden: boolean;
  maskedText: string | null;
  onReveal: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const isPending = Boolean(editing?.pending.has(col.name));
  const pendingValue = editing?.pending.get(col.name);
  // A queued edit shows its new value (Postgres text) until committed.
  const shown: unknown = isPending ? pendingValue : value;
  const isNullish = shown === null || shown === undefined;
  const isEmpty = shown === '';
  const text = hidden && maskedText !== null ? maskedText : displayText(shown, col.dataTypeName);
  const multiline = text.includes('\n') || text.length > 80;

  const copy = () => {
    const raw = hidden
      ? (maskedText ?? '')
      : isNullish
        ? ''
        : typeof shown === 'object'
          ? displayText(shown, col.dataTypeName)
          : String(shown);
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
        <span className="shrink-0 text-[11px] text-[var(--wb-text-3)]">
          {readableTypeName(col)}
        </span>
        {isPending && (
          <span className="shrink-0 text-[11px] font-medium text-[var(--wb-accent)]">edited</span>
        )}
        <div className="flex-1" />
        {hidden && !isNullish && !isEmpty && (
          <IconButton
            variant="plain"
            label={`Reveal ${col.name}`}
            title="Reveal for 10 seconds"
            onClick={onReveal}
            className="h-5 w-5 [&_svg]:h-3 [&_svg]:w-3"
          >
            <Eye />
          </IconButton>
        )}
        {editing && !open && (
          <IconButton
            variant="plain"
            label={`Edit ${col.name}`}
            title="Edit value"
            onClick={() => setOpen(true)}
            className="h-5 w-5 opacity-0 transition-opacity group-hover/field:opacity-100 focus-visible:opacity-100 [&_svg]:h-3 [&_svg]:w-3"
          >
            <Pencil />
          </IconButton>
        )}
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
      {open && editing ? (
        <FieldEditor
          col={col}
          kind={fieldEditorKind(col.dataTypeName, editing.enumFor(col.dataTypeName))}
          enumValues={editing.enumFor(col.dataTypeName)}
          initial={isPending ? (pendingValue ?? null) : editorText(value, col.dataTypeName)}
          initialNull={isNullish}
          onDone={() => setOpen(false)}
          onSave={(next) => useSession.getState().updateCell(editing.rowIndex, columnIndex, next)}
        />
      ) : isNullish ? (
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

/**
 * Typed inline editor for one field. `onSave(null)` queues SQL NULL;
 * a string is Postgres text. Esc cancels; Enter (single-line text) or
 * ⌘/Ctrl+Enter saves.
 */
function FieldEditor({
  col,
  kind,
  enumValues,
  initial,
  initialNull,
  onSave,
  onDone,
}: {
  col: ColumnMeta;
  kind: FieldEditorKind;
  enumValues: string[] | null;
  initial: string | null;
  initialNull: boolean;
  onSave: (next: string | null) => Promise<void> | void;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState(initial ?? '');
  const [error, setError] = useState<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    areaRef.current?.focus();
    areaRef.current?.select();
  }, []);

  const save = async (next: string | null) => {
    if (next !== null) {
      const invalid = validateFieldInput(kind, next);
      if (invalid) {
        setError(invalid);
        return;
      }
    }
    try {
      await onSave(next);
      onDone();
    } catch (err) {
      setError(cleanIpcError(err instanceof Error ? err.message : String(err)));
    }
  };

  const choices = kind === 'bool' ? ['true', 'false'] : kind === 'enum' ? (enumValues ?? []) : null;

  return (
    <div className="mt-1 flex flex-col gap-1.5">
      {choices ? (
        <fieldset className="m-0 flex flex-wrap gap-1 border-0 p-0">
          <legend className="sr-only">{col.name} value</legend>
          {choices.map((c) => {
            const active = !initialNull && initial === c;
            return (
              <Button
                key={c}
                size="xs"
                variant={active ? 'primary' : 'secondary'}
                aria-pressed={active}
                className="font-mono"
                onClick={() => void save(c)}
              >
                {c}
              </Button>
            );
          })}
        </fieldset>
      ) : (
        <textarea
          ref={areaRef}
          value={draft}
          aria-label={`${col.name} value`}
          spellCheck={false}
          rows={kind === 'json' || draft.includes('\n') || draft.length > 60 ? 6 : 2}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              onDone();
            } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void save(draft);
            } else if (
              e.key === 'Enter' &&
              !e.shiftKey &&
              kind === 'text' &&
              !draft.includes('\n')
            ) {
              e.preventDefault();
              void save(draft);
            }
          }}
          className="w-full resize-y rounded-[7px] border-0 bg-[var(--wb-field)] px-2 py-1.5 font-mono text-[12px] text-[var(--wb-text)] shadow-[inset_0_0_0_1px_var(--wb-toolbar-group-edge)] outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--ring)]"
        />
      )}
      {error && (
        <div className="text-[12px] text-destructive" role="alert">
          {error}
        </div>
      )}
      <div className="flex items-center gap-1">
        <Button size="xs" variant="ghost" onClick={() => void save(null)} title="Set to SQL NULL">
          Set NULL
        </Button>
        <div className="flex-1" />
        <Button size="xs" variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        {!choices && (
          <Button size="xs" variant="primary" onClick={() => void save(draft)}>
            Save
          </Button>
        )}
      </div>
    </div>
  );
}

interface Overview {
  total: string;
  data: string;
  index: string;
  estimate: string;
  comment: string;
  /** pg_class.relkind: r table, p partitioned, v view, m matview, f foreign. */
  relkind: string;
}

const RELKIND_LABEL: Record<string, string> = {
  r: 'Table',
  p: 'Partitioned table',
  v: 'View',
  m: 'Materialized view',
  f: 'Foreign table',
};

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
                  COALESCE(obj_description(c.oid, 'pg_class'), ''),
                  c.relkind::text
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
          relkind: String(r[5] ?? 'r'),
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
        <div className="text-[13px] font-semibold text-[var(--wb-text)]">
          {info ? (RELKIND_LABEL[info.relkind] ?? 'Relation') : 'Table'}
        </div>
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
          {/* Plain / foreign views store nothing: sizes and estimates would read 0. */}
          {info.relkind !== 'v' && info.relkind !== 'f' && (
            <>
              <Stat label="Total size" value={info.total} />
              <Stat label="Data" value={info.data} />
              <Stat label="Indexes" value={info.index} />
              <Stat label="Rows (est.)" value={Number(info.estimate).toLocaleString()} />
            </>
          )}
          {info.relkind === 'v' && !info.comment && (
            <>
              <dt className="text-[var(--wb-text-2)]">Stored data</dt>
              <dd className="text-right text-[var(--wb-text)]">none (computed on read)</dd>
            </>
          )}
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
