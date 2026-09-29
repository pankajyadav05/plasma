import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { type DataColumn, DataTable } from '@/components/ui/data-table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Badge, EmptyState, ViewFooter, ViewToolbar } from '@/components/ui/view-parts';
import { IconButton, Pill, Segmented } from '@/components/ui/workbench';
import { cleanIpcError } from '@/lib/errors';
import { ipc } from '@/lib/ipc';
import { useActiveTab, useSession } from '@/stores/session';
import { useWorkbench } from '@/stores/workbench';
import type { ColumnMeta, RedisKeyValue, RedisValueType, RedisWriteOp } from '@shared/protocol';
import { KeyRound, Loader2, Pencil, Plus, RefreshCw, Timer, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * Inspect / mutate a single Redis key — TablePlus-style:
 *
 *   ViewToolbar  key name · type badge · size   TTL · edit · refresh · delete
 *   body         DataTable per collection type, or a pre for strings/JSON
 *   ViewFooter   element count / truncation note (Auto|Raw for strings)
 *
 * Loads the payload via ipc.redis.getKey on mount + manual refresh.
 * Selecting a row publishes it to the right sidebar's Details pane.
 *
 *   - string   → JSON-aware pretty view if the payload parses as JSON
 *   - list     → index | value
 *   - set      → member
 *   - zset     → member | score
 *   - hash     → field | value
 *   - stream   → id | one column per field name
 *   - json     → pretty-printed (already parsed by RedisJSON)
 */

type Cell = string | null;

interface TableModel {
  kind: 'table';
  columns: { name: string; typeName: string; align?: 'left' | 'right'; width?: number }[];
  rows: Cell[][];
  total: number;
  /** false for list: the index column replaces the row-number gutter. */
  rowNumbers: boolean;
  noun: string;
  /** Write op that removes the element in `row`, when the type supports it. */
  removeOp?: (row: Cell[]) => RedisWriteOp;
}

type BodyModel =
  | TableModel
  | { kind: 'string'; raw: string }
  | { kind: 'json'; value: unknown }
  | { kind: 'large'; stub: LargeValueStubView }
  | { kind: 'error'; message: string }
  | { kind: 'empty' };

const TYPE_LABEL: Record<RedisValueType, string> = {
  string: 'STRING',
  list: 'LIST',
  set: 'SET',
  zset: 'ZSET',
  hash: 'HASH',
  stream: 'STREAM',
  json: 'JSON',
  none: 'NONE',
  unknown: 'UNKNOWN',
};

/** Stream entries with many distinct field names are capped to keep the grid usable. */
const MAX_STREAM_FIELD_COLUMNS = 24;

function buildModel(data: RedisKeyValue, keyName: string): BodyModel {
  switch (data.type) {
    case 'string': {
      if (isLargeValueStub(data.value)) return { kind: 'large', stub: data.value };
      const raw = typeof data.value === 'string' ? data.value : String(data.value ?? '');
      return { kind: 'string', raw };
    }
    case 'list': {
      const v = data.value as { items: string[]; total: number } | null;
      if (!v) return { kind: 'empty' };
      return {
        kind: 'table',
        columns: [
          { name: 'index', typeName: 'list index', align: 'right', width: 72 },
          { name: 'value', typeName: 'list element' },
        ],
        rows: v.items.map((s, i) => [String(i), s]),
        total: v.total,
        rowNumbers: false,
        noun: 'elements',
      };
    }
    case 'set': {
      const v = data.value as { items: string[]; total: number } | null;
      return {
        kind: 'table',
        columns: [{ name: 'member', typeName: 'set member' }],
        rows: (v?.items ?? []).map((s) => [s]),
        total: v?.total ?? 0,
        rowNumbers: true,
        noun: 'members',
        removeOp: (row) => ({ kind: 'setRem', key: keyName, member: row[0] ?? '' }),
      };
    }
    case 'zset': {
      const v = data.value as { items: [string, string][]; total: number } | null;
      return {
        kind: 'table',
        columns: [
          { name: 'member', typeName: 'zset member' },
          { name: 'score', typeName: 'score', align: 'right', width: 140 },
        ],
        rows: v?.items ?? [],
        total: v?.total ?? 0,
        rowNumbers: true,
        noun: 'members',
        removeOp: (row) => ({ kind: 'zsetRem', key: keyName, member: row[0] ?? '' }),
      };
    }
    case 'hash': {
      const v = data.value as { items: [string, string][]; total: number } | null;
      return {
        kind: 'table',
        columns: [
          { name: 'field', typeName: 'hash field', width: 220 },
          { name: 'value', typeName: 'hash value' },
        ],
        rows: v?.items ?? [],
        total: v?.total ?? 0,
        rowNumbers: true,
        noun: 'fields',
        removeOp: (row) => ({ kind: 'hashDel', key: keyName, field: row[0] ?? '' }),
      };
    }
    case 'stream': {
      const v = data.value as
        | { items: { id: string; fields: [string, string][] }[]; total: number }
        | { error: string }
        | null;
      if (!v) return { kind: 'empty' };
      if ('error' in v) return { kind: 'error', message: v.error };
      const fieldNames: string[] = [];
      const seen = new Set<string>();
      for (const it of v.items) {
        for (const [f] of it.fields) {
          if (!seen.has(f) && fieldNames.length < MAX_STREAM_FIELD_COLUMNS) {
            seen.add(f);
            fieldNames.push(f);
          }
        }
      }
      return {
        kind: 'table',
        columns: [
          { name: 'id', typeName: 'stream entry id', width: 170 },
          ...fieldNames.map((f) => ({ name: f, typeName: 'stream field' })),
        ],
        rows: v.items.map((it) => {
          const byName = new Map(it.fields);
          return [it.id, ...fieldNames.map((f) => byName.get(f) ?? null)];
        }),
        total: v.total,
        rowNumbers: true,
        noun: 'entries',
      };
    }
    case 'json': {
      if (isLargeValueStub(data.value)) return { kind: 'large', stub: data.value };
      if (isErrorValue(data.value)) return { kind: 'error', message: data.value.error };
      return { kind: 'json', value: data.value };
    }
    case 'none':
      return { kind: 'empty' };
    default:
      return { kind: 'json', value: data.value };
  }
}

function formatTtl(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const FIELD_CLASS =
  'h-[26px] min-w-0 rounded-[7px] border-0 bg-[var(--wb-field)] px-2.5 font-mono text-[13px] text-[var(--wb-text)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--wb-text)_10%,transparent)] outline-none placeholder:text-[var(--wb-text-3)] focus:shadow-[0_0_0_2px_color-mix(in_srgb,var(--wb-accent)_55%,transparent)]';

export function RedisKeyView({ keyName }: { keyName: string }) {
  const tab = useActiveTab();
  const tabId = tab?.id ?? null;
  const editMode = useSession((s) => s.editMode);
  const deleteRedisKey = useSession((s) => s.deleteRedisKey);
  const setRedisTtl = useSession((s) => s.setRedisTtl);
  const setInspectedRow = useWorkbench((s) => s.setInspectedRow);

  const [data, setData] = useState<RedisKeyValue | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [ttlInput, setTtlInput] = useState('');
  const [ttlBusy, setTtlBusy] = useState(false);
  const [ttlOpen, setTtlOpen] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [stringView, setStringView] = useState<'auto' | 'raw'>('auto');

  /** Drop our row from the Details pane (only if it's still ours). */
  const clearInspected = useCallback(() => {
    const cur = useWorkbench.getState().inspectedRow;
    if (cur && cur.tabId === tabId) setInspectedRow(null);
  }, [tabId, setInspectedRow]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await ipc.redis.getKey(keyName);
      setData(r);
      setTtlInput(r.ttlMs !== null ? Math.round(r.ttlMs / 1000).toString() : '');
      // Element positions can shift after a reload — drop the selection.
      setSelected(null);
      clearInspected();
    } catch (err) {
      setError(cleanIpcError(err instanceof Error ? err.message : String(err)));
    } finally {
      setLoading(false);
    }
  }, [keyName, clearInspected]);

  useEffect(() => {
    void load();
  }, [load]);

  // Clear the Details pane when the key changes or the view goes away.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyName is the trigger
  useEffect(() => clearInspected, [keyName, clearInspected]);

  const onSetTtl = async (seconds: number) => {
    setTtlBusy(true);
    try {
      await setRedisTtl(keyName, seconds);
      await load();
      setTtlOpen(false);
    } finally {
      setTtlBusy(false);
    }
  };

  const onDelete = async () => {
    await deleteRedisKey(keyName);
    setConfirmDelete(false);
  };

  const writeAndReload = useCallback(
    async (op: RedisWriteOp) => {
      try {
        await ipc.redis.write(op);
        await load();
      } catch (err) {
        console.error('[plasma] redis write failed', err);
        setError(cleanIpcError(err instanceof Error ? err.message : String(err)));
      }
    },
    [load],
  );

  const model = useMemo(() => (data ? buildModel(data, keyName) : null), [data, keyName]);

  const selectRow = (row: Cell[], index: number) => {
    if (!model || model.kind !== 'table') return;
    setSelected(index);
    if (!tabId) return;
    const columns: ColumnMeta[] = model.columns.map((c) => ({
      name: c.name,
      dataTypeID: 0,
      dataTypeName: c.typeName,
    }));
    setInspectedRow({ tabId, rowNumber: index + 1, columnIndex: 0, columns, row });
  };

  const sizeText = (() => {
    if (!model) return null;
    if (model.kind === 'table') return `${model.total.toLocaleString()} ${model.noun}`;
    if (model.kind === 'string') return `${model.raw.length.toLocaleString()} chars`;
    if (model.kind === 'large') return `${model.stub.sizeBytes.toLocaleString()} bytes`;
    return null;
  })();

  const ttlText = !data ? '…' : data.ttlMs !== null ? `TTL ${formatTtl(data.ttlMs)}` : 'No expiry';

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--wb-content)] text-[var(--wb-text)]">
      <ViewToolbar>
        <KeyRound className="h-3.5 w-3.5 shrink-0 text-[var(--wb-text-2)]" />
        <h1 className="min-w-0 truncate font-mono text-[13px] font-semibold" title={keyName}>
          {keyName}
        </h1>
        {data && <Badge>{TYPE_LABEL[data.type]}</Badge>}
        {sizeText && (
          <span className="shrink-0 text-[12px] tabular-nums text-[var(--wb-text-2)]">
            {sizeText}
          </span>
        )}
        <div className="flex-1" />

        {editMode && data ? (
          <Popover open={ttlOpen} onOpenChange={setTtlOpen}>
            <PopoverTrigger asChild>
              <Pill aria-label="Edit TTL" title="Set or remove the expiry">
                <Timer />
                <span className="tabular-nums">{ttlText}</span>
              </Pill>
            </PopoverTrigger>
            <PopoverContent align="end" sideOffset={4} className="w-[260px] p-3">
              <form
                className="flex flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const n = Number(ttlInput);
                  if (ttlInput.trim() && Number.isFinite(n)) void onSetTtl(Math.floor(n));
                }}
              >
                <div className="text-[12px] text-[var(--wb-text-2)]">Expire in (seconds)</div>
                <input
                  value={ttlInput}
                  onChange={(e) => setTtlInput(e.target.value)}
                  placeholder="seconds"
                  inputMode="numeric"
                  aria-label="TTL seconds"
                  className={FIELD_CLASS}
                />
                <div className="flex justify-end gap-1.5">
                  <Pill
                    onClick={() => void onSetTtl(0)}
                    disabled={ttlBusy || data.ttlMs === null}
                    title="Remove TTL (PERSIST)"
                  >
                    Persist
                  </Pill>
                  <Pill type="submit" disabled={ttlBusy || !ttlInput.trim()} title="EXPIRE">
                    {ttlBusy && <Loader2 className="animate-spin" />}
                    Set expire
                  </Pill>
                </div>
              </form>
            </PopoverContent>
          </Popover>
        ) : (
          <span className="flex shrink-0 items-center gap-1 text-[12px] tabular-nums text-[var(--wb-text-2)]">
            <Timer className="h-3.5 w-3.5" />
            {ttlText}
          </span>
        )}

        {editMode && data && model && (
          <EditAction
            type={data.type}
            ttlMs={data.ttlMs}
            model={model}
            keyName={keyName}
            onWrite={writeAndReload}
          />
        )}

        <IconButton
          label="Refresh key"
          title="Refresh"
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        </IconButton>
        {editMode && (
          <IconButton
            label="Delete key"
            title="Delete key (DEL)"
            onClick={() => setConfirmDelete(true)}
            className="text-destructive hover:text-destructive"
          >
            <Trash2 />
          </IconButton>
        )}
      </ViewToolbar>

      {error && (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-2 border-b border-[var(--wb-separator)] bg-[color-mix(in_srgb,var(--destructive)_14%,var(--wb-content))] px-3 py-1.5 text-[13px] text-[var(--wb-text)]"
        >
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <IconButton variant="plain" label="Dismiss error" onClick={() => setError(null)}>
            <X />
          </IconButton>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        {!model ? (
          loading ? (
            <EmptyState title="Loading…" />
          ) : (
            !error && <EmptyState title="No data" />
          )
        ) : (
          <KeyBody
            model={model}
            keyName={keyName}
            editMode={editMode}
            selected={selected}
            onSelect={selectRow}
            onWrite={writeAndReload}
            stringView={stringView}
          />
        )}
      </div>

      <ViewFooter>
        {model?.kind === 'string' && (
          <Segmented<'auto' | 'raw'>
            ariaLabel="String view"
            variant="track"
            value={stringView}
            onChange={setStringView}
            options={[
              { value: 'auto', label: 'Auto', title: 'Pretty-print JSON payloads' },
              { value: 'raw', label: 'Raw' },
            ]}
          />
        )}
        <FooterSummary model={model} />
        <div className="flex-1" />
        {data?.encoding && (
          <span className="truncate text-[12px]">
            encoding <span className="font-mono text-[var(--wb-text)]">{data.encoding}</span>
          </span>
        )}
      </ViewFooter>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete key?"
        description={`DEL ${keyName} — this cannot be undone.`}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={() => void onDelete()}
      />
    </main>
  );
}

function FooterSummary({ model }: { model: BodyModel | null }) {
  if (!model) return null;
  if (model.kind === 'table') {
    const count = model.rows.length;
    const truncated = model.total > count;
    return (
      <span className="flex min-w-0 items-center gap-2 truncate tabular-nums">
        {truncated
          ? `${count.toLocaleString()} of ${model.total.toLocaleString()} ${model.noun}`
          : `${count.toLocaleString()} ${count === 1 ? model.noun.replace(/s$/, '') : model.noun}`}
        {truncated && (
          <Badge tone="warn" className="normal-case tracking-normal">
            truncated
          </Badge>
        )}
      </span>
    );
  }
  if (model.kind === 'string') {
    return <span className="truncate tabular-nums">{model.raw.length.toLocaleString()} chars</span>;
  }
  if (model.kind === 'json') return <span>RedisJSON document</span>;
  if (model.kind === 'large') return <span>Value not fetched</span>;
  return null;
}

function KeyBody({
  model,
  keyName,
  editMode,
  selected,
  onSelect,
  onWrite,
  stringView,
}: {
  model: BodyModel;
  keyName: string;
  editMode: boolean;
  selected: number | null;
  onSelect: (row: Cell[], index: number) => void;
  onWrite: (op: RedisWriteOp) => Promise<void>;
  stringView: 'auto' | 'raw';
}) {
  switch (model.kind) {
    case 'table':
      return (
        <CollectionTable
          model={model}
          keyName={keyName}
          editMode={editMode}
          selected={selected}
          onSelect={onSelect}
          onWrite={onWrite}
        />
      );
    case 'string':
      return <StringBody raw={model.raw} view={stringView} />;
    case 'json':
      return <CodeBlock text={JSON.stringify(model.value, null, 2) ?? 'null'} />;
    case 'large':
      return (
        <EmptyState
          title="Large value — not fetched"
          hint={`${model.stub.error} (${model.stub.sizeBytes.toLocaleString()} bytes)`}
        />
      );
    case 'error':
      return <EmptyState title="Could not read this key" hint={model.message} />;
    default:
      return <EmptyState title="Empty" hint="Key has no value or has been removed." />;
  }
}

function CollectionTable({
  model,
  keyName,
  editMode,
  selected,
  onSelect,
  onWrite,
}: {
  model: TableModel;
  keyName: string;
  editMode: boolean;
  selected: number | null;
  onSelect: (row: Cell[], index: number) => void;
  onWrite: (op: RedisWriteOp) => Promise<void>;
}) {
  const columns = useMemo(() => {
    const cols: DataColumn<Cell[]>[] = model.columns.map((c, i) => ({
      key: `${i}:${c.name}`,
      label: c.name,
      title: `${c.name} — ${c.typeName}`,
      align: c.align,
      width: c.width,
      render: (r) => r[i],
      titleOf: (r) => r[i] ?? undefined,
    }));
    const removeOp = model.removeOp;
    if (editMode && removeOp) {
      cols.push({
        key: '__remove',
        label: '',
        width: 36,
        sans: true,
        render: (r) => (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void onWrite(removeOp(r));
            }}
            className="grid h-5 w-5 place-items-center rounded-[5px] text-[var(--wb-text-3)] hover:bg-[color-mix(in_srgb,var(--destructive)_18%,transparent)] hover:text-destructive"
            aria-label={`Remove ${r[0] ?? ''}`}
            title="Remove"
          >
            <X className="h-3 w-3" />
          </button>
        ),
      });
    }
    return cols;
  }, [model, editMode, onWrite]);

  return (
    <DataTable<Cell[]>
      ariaLabel={`${keyName} ${model.noun}`}
      columns={columns}
      rows={model.rows}
      rowKey={(r, i) => `${i}:${r[0] ?? ''}`}
      rowNumbers={model.rowNumbers}
      selectedIndex={selected}
      onSelect={onSelect}
      empty={`No ${model.noun}`}
    />
  );
}

function StringBody({ raw, view }: { raw: string; view: 'auto' | 'raw' }) {
  // Pretty-print when the payload is a JSON object/array; otherwise raw.
  const text = useMemo(() => {
    if (view === 'raw') return raw;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object') return JSON.stringify(parsed, null, 2);
    } catch {
      /* not JSON */
    }
    return raw;
  }, [raw, view]);
  return <CodeBlock text={text} />;
}

/** Read-only editor-like pane: mono 13/20, gutter-free, wraps long lines. */
function CodeBlock({ text }: { text: string }) {
  return (
    <pre className="min-h-0 flex-1 select-text overflow-auto whitespace-pre-wrap break-all bg-[var(--wb-content)] px-4 py-3 font-mono text-[13px] leading-5 text-[var(--grid-text)]">
      {text}
    </pre>
  );
}

// ───────────────────────── Edit actions ─────────────────────────

/** The per-type "add / edit" pill in the toolbar (edit mode only). */
function EditAction({
  type,
  ttlMs,
  model,
  keyName,
  onWrite,
}: {
  type: RedisValueType;
  ttlMs: number | null;
  model: BodyModel;
  keyName: string;
  onWrite: (op: RedisWriteOp) => Promise<void>;
}) {
  switch (type) {
    case 'string':
      return model.kind === 'string' ? (
        <StringEditDialog
          initial={model.raw}
          // SET drops the expiry, so re-apply the remaining TTL (EX) when there is one.
          onSubmit={(value) =>
            onWrite({
              kind: 'setString',
              key: keyName,
              value,
              ...(ttlMs !== null && ttlMs > 0 ? { ttlSeconds: Math.ceil(ttlMs / 1000) } : {}),
            })
          }
        />
      ) : null;
    case 'hash':
      return (
        <HashEditPopover
          onSet={(field, value) => onWrite({ kind: 'hashSet', key: keyName, field, value })}
        />
      );
    case 'list':
      return (
        <ListEditPopover
          onPush={(side, values) => onWrite({ kind: 'listPush', key: keyName, side, values })}
        />
      );
    case 'set':
      return (
        <SetEditPopover onAdd={(members) => onWrite({ kind: 'setAdd', key: keyName, members })} />
      );
    case 'zset':
      return (
        <ZsetEditPopover
          onAdd={(member, score) => onWrite({ kind: 'zsetAdd', key: keyName, member, score })}
        />
      );
    default:
      return null;
  }
}

function EditPopover({
  label,
  title,
  open,
  onOpenChange,
  children,
}: {
  label: string;
  title: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Pill title={title}>
          <Plus />
          {label}
        </Pill>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={4} className="w-[340px] p-3">
        <div className="mb-2 text-[12px] font-medium text-[var(--wb-text-2)]">{title}</div>
        {children}
      </PopoverContent>
    </Popover>
  );
}

function StringEditDialog({
  initial,
  onSubmit,
}: {
  initial: string;
  onSubmit: (value: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Pill
        onClick={() => {
          setValue(initial);
          setOpen(true);
        }}
        title="Edit string (SET)"
      >
        <Pencil />
        Edit value…
      </Pill>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[640px] gap-3 bg-[var(--wb-sidebar)] p-5">
          <DialogHeader>
            <DialogTitle className="text-[15px]">Edit string</DialogTitle>
            <DialogDescription className="text-[12px] text-[var(--wb-text-2)]">
              Saved with SET; any remaining TTL is re-applied.
            </DialogDescription>
          </DialogHeader>
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={12}
            spellCheck={false}
            aria-label="String value"
            className="w-full resize-y rounded-[7px] border-0 bg-[var(--wb-field)] px-2.5 py-2 font-mono text-[13px] leading-5 text-[var(--wb-text)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--wb-text)_10%,transparent)] outline-none focus:shadow-[0_0_0_2px_color-mix(in_srgb,var(--wb-accent)_55%,transparent)]"
          />
          <DialogFooter className="gap-2">
            <Pill onClick={() => setValue(initial)} disabled={busy || value === initial}>
              Reset
            </Pill>
            <Pill
              disabled={busy || value === initial}
              onClick={async () => {
                setBusy(true);
                try {
                  await onSubmit(value);
                  setOpen(false);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy && <Loader2 className="animate-spin" />}
              Save
            </Pill>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function HashEditPopover({ onSet }: { onSet: (field: string, value: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [field, setField] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <EditPopover label="Set field" title="Set field (HSET)" open={open} onOpenChange={setOpen}>
      <form
        className="flex flex-col gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!field) return;
          setBusy(true);
          try {
            await onSet(field, value);
            setField('');
            setValue('');
          } finally {
            setBusy(false);
          }
        }}
      >
        <input
          value={field}
          onChange={(e) => setField(e.target.value)}
          placeholder="field"
          aria-label="Field"
          className={FIELD_CLASS}
        />
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="value"
          aria-label="Value"
          className={FIELD_CLASS}
        />
        <div className="flex justify-end">
          <Pill type="submit" disabled={busy || !field}>
            {busy && <Loader2 className="animate-spin" />}
            Set
          </Pill>
        </div>
      </form>
    </EditPopover>
  );
}

function ListEditPopover({
  onPush,
}: {
  onPush: (side: 'l' | 'r', values: string[]) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (side: 'l' | 'r') => {
    if (!value) return;
    setBusy(true);
    try {
      await onPush(side, [value]);
      setValue('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <EditPopover label="Push" title="Push (LPUSH / RPUSH)" open={open} onOpenChange={setOpen}>
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit('r');
        }}
      >
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="value"
          aria-label="Value"
          className={FIELD_CLASS}
        />
        <div className="flex justify-end gap-1.5">
          <Pill onClick={() => void submit('l')} disabled={busy || !value} title="LPUSH (head)">
            ← LPUSH
          </Pill>
          <Pill type="submit" disabled={busy || !value} title="RPUSH (tail)">
            RPUSH →
          </Pill>
        </div>
      </form>
    </EditPopover>
  );
}

function SetEditPopover({ onAdd }: { onAdd: (members: string[]) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [member, setMember] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <EditPopover label="Add member" title="Add member (SADD)" open={open} onOpenChange={setOpen}>
      <form
        className="flex items-center gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!member) return;
          setBusy(true);
          try {
            await onAdd([member]);
            setMember('');
          } finally {
            setBusy(false);
          }
        }}
      >
        <input
          value={member}
          onChange={(e) => setMember(e.target.value)}
          placeholder="member"
          aria-label="Member"
          className={`${FIELD_CLASS} flex-1`}
        />
        <Pill type="submit" disabled={busy || !member}>
          {busy && <Loader2 className="animate-spin" />}
          Add
        </Pill>
      </form>
    </EditPopover>
  );
}

function ZsetEditPopover({ onAdd }: { onAdd: (member: string, score: number) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [member, setMember] = useState('');
  const [scoreStr, setScoreStr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <EditPopover label="Add member" title="Add member (ZADD)" open={open} onOpenChange={setOpen}>
      <form
        className="flex items-center gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!member) return;
          const score = Number(scoreStr);
          if (!Number.isFinite(score)) return;
          setBusy(true);
          try {
            await onAdd(member, score);
            setMember('');
            setScoreStr('');
          } finally {
            setBusy(false);
          }
        }}
      >
        <input
          value={member}
          onChange={(e) => setMember(e.target.value)}
          placeholder="member"
          aria-label="Member"
          className={`${FIELD_CLASS} flex-1`}
        />
        <input
          value={scoreStr}
          onChange={(e) => setScoreStr(e.target.value)}
          placeholder="score"
          inputMode="decimal"
          aria-label="Score"
          className={`${FIELD_CLASS} w-20`}
        />
        <Pill type="submit" disabled={busy || !member}>
          {busy && <Loader2 className="animate-spin" />}
          Add
        </Pill>
      </form>
    </EditPopover>
  );
}

// ───────────────────────── Value guards ─────────────────────────

type LargeValueStubView = { truncated: true; sizeBytes: number; error: string };

function isLargeValueStub(v: unknown): v is LargeValueStubView {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as LargeValueStubView).truncated === true &&
    typeof (v as LargeValueStubView).error === 'string' &&
    typeof (v as LargeValueStubView).sizeBytes === 'number'
  );
}

function isErrorValue(v: unknown): v is { error: string } {
  return (
    typeof v === 'object' &&
    v !== null &&
    'error' in v &&
    typeof (v as { error: unknown }).error === 'string'
  );
}
