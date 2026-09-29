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
import { IconButton, MenuItem, Pill, Segmented } from '@/components/ui/workbench';
import { SidebarSearch } from '@/features/sidebar/sidebar-parts';
import { ipc } from '@/lib/ipc';
import { useActiveTab, useSession } from '@/stores/session';
import { useWorkbench } from '@/stores/workbench';
import type { ColumnMeta, RedisKeyValue, RedisValueType, RedisWriteOp } from '@shared/protocol';
import {
  type RedisCell,
  cellBytes,
  cellNote,
  cellText,
  hexBytes,
  isBinaryCell,
  isCellObject,
  isEditableCell,
} from '@shared/redis-cell';
import {
  Copy,
  CopyPlus,
  KeyRound,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Terminal,
  TextCursorInput,
  Timer,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionDialog,
  FIELD_CLASS,
  RenameCopyDialog,
  TEXTAREA_CLASS,
  errMsg,
} from './redis-dialogs';
import { formatBytes, formatDuration, formatTtl, plural, streamIdTime } from './redis-format';
import { useRedisWriteGate } from './use-redis-write';

/**
 * Inspect / mutate a single Redis key — TablePlus-style:
 *
 *   ViewToolbar  key name · type · size        TTL · edit · more · refresh · delete
 *   filter strip MATCH filter / order / load more (collections, R24)
 *   body         DataTable per collection type, or a text/hex pane
 *   ViewFooter   counts · memory · idle · encoding
 *
 * Values are binary-safe cells (R12): only plain UTF-8 cells can be edited
 * as text. Every write follows the S1 gate (edit mode + writable
 * connection) and reports failures inline (R7).
 */

type Cell = RedisCell | null;

interface TableModel {
  kind: 'table';
  columns: {
    name: string;
    typeName: string;
    align?: 'left' | 'right';
    width?: number;
    sans?: boolean;
  }[];
  rows: Cell[][];
  total: number;
  /** false for list: the index column replaces the row-number gutter. */
  rowNumbers: boolean;
  noun: string;
  /** Write op that removes the element in `row`, when the type supports it. */
  removeOp?: (row: Cell[]) => RedisWriteOp | null;
  /** Row can be edited in place. */
  editable?: (row: Cell[]) => boolean;
}

type LargeStub = { truncated: true; sizeBytes: number; error: string; preview?: RedisCell | null };

type BodyModel =
  | TableModel
  | { kind: 'string'; cell: RedisCell }
  | { kind: 'json'; value: unknown }
  | { kind: 'large'; stub: LargeStub }
  | { kind: 'error'; message: string }
  | { kind: 'unsupported'; typeName: string }
  | { kind: 'empty' };

const TYPE_LABEL: Record<RedisValueType, string> = {
  string: 'string',
  list: 'list',
  set: 'set',
  zset: 'sorted set',
  hash: 'hash',
  stream: 'stream',
  json: 'json',
  none: 'none',
  unknown: 'unknown',
};

/** Stream entries with many distinct field names are capped to keep the grid usable. */
const MAX_STREAM_FIELD_COLUMNS = 24;
const PAGE = 500;

interface StreamGroup {
  name: string;
  consumers: number;
  pending: number;
  lastDeliveredId: string;
  lag: number | null;
}

/** Items accumulated over pages (R24). */
type Items = unknown[];

function collectionTotal(data: RedisKeyValue): number {
  const v = data.value as { total?: number } | null;
  return typeof v?.total === 'number' ? v.total : 0;
}

export function buildModel(
  data: RedisKeyValue,
  items: Items,
  keyName: string,
  listOffset = 0,
): BodyModel {
  switch (data.type) {
    case 'string': {
      if (isLargeStub(data.value)) return { kind: 'large', stub: data.value };
      const cell = (
        typeof data.value === 'string' || isCellObject(data.value) ? data.value : ''
      ) as RedisCell;
      return { kind: 'string', cell };
    }
    case 'list':
      return {
        kind: 'table',
        columns: [
          { name: 'index', typeName: 'list index', align: 'right', width: 72 },
          { name: 'value', typeName: 'list element' },
        ],
        rows: (items as Cell[]).map((c, i) => [String(listOffset + i), c]),
        total: collectionTotal(data),
        rowNumbers: false,
        noun: 'elements',
        removeOp: (row) =>
          isEditableCell(row[1])
            ? { kind: 'listRem', key: keyName, value: row[1], count: 1 }
            : null,
        editable: (row) => isEditableCell(row[1]),
      };
    case 'set':
      return {
        kind: 'table',
        columns: [{ name: 'member', typeName: 'set member' }],
        rows: (items as Cell[]).map((s) => [s]),
        total: collectionTotal(data),
        rowNumbers: true,
        noun: 'members',
        removeOp: (row) =>
          isEditableCell(row[0]) ? { kind: 'setRem', key: keyName, member: row[0] } : null,
        editable: (row) => isEditableCell(row[0]),
      };
    case 'zset':
      return {
        kind: 'table',
        columns: [
          { name: 'member', typeName: 'zset member' },
          { name: 'score', typeName: 'score', align: 'right', width: 140 },
        ],
        rows: items as Cell[][],
        total: collectionTotal(data),
        rowNumbers: true,
        noun: 'members',
        removeOp: (row) =>
          isEditableCell(row[0]) ? { kind: 'zsetRem', key: keyName, member: row[0] } : null,
        editable: (row) => isEditableCell(row[0]),
      };
    case 'hash':
      return {
        kind: 'table',
        columns: [
          { name: 'field', typeName: 'hash field', width: 220 },
          { name: 'value', typeName: 'hash value' },
        ],
        rows: items as Cell[][],
        total: collectionTotal(data),
        rowNumbers: true,
        noun: 'fields',
        removeOp: (row) =>
          isEditableCell(row[0]) ? { kind: 'hashDel', key: keyName, field: row[0] } : null,
        editable: (row) => isEditableCell(row[0]) && isEditableCell(row[1]),
      };
    case 'stream': {
      const v = data.value as { error?: string } | null;
      if (v && typeof v.error === 'string') return { kind: 'error', message: v.error };
      const entries = items as { id: string; fields: [string, Cell][] }[];
      const fieldNames: string[] = [];
      const seen = new Set<string>();
      for (const it of entries) {
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
          // F38: ids are ms timestamps — show them as a time too.
          { name: 'time', typeName: 'entry time', width: 190, sans: true },
          ...fieldNames.map((f) => ({ name: f, typeName: 'stream field' })),
        ],
        rows: entries.map((it) => {
          const byName = new Map(it.fields);
          return [it.id, streamIdTime(it.id), ...fieldNames.map((f) => byName.get(f) ?? null)];
        }),
        total: collectionTotal(data),
        rowNumbers: true,
        noun: 'entries',
        removeOp: (row) => ({ kind: 'streamDel', key: keyName, ids: [String(row[0])] }),
      };
    }
    case 'json': {
      if (isLargeStub(data.value)) return { kind: 'large', stub: data.value };
      if (isErrorValue(data.value)) return { kind: 'error', message: data.value.error };
      return { kind: 'json', value: data.value };
    }
    case 'none':
      return { kind: 'empty' };
    default:
      return { kind: 'unsupported', typeName: data.typeName ?? 'unknown' };
  }
}

function pageItems(data: RedisKeyValue): Items {
  const v = data.value as { items?: unknown[] } | null;
  return Array.isArray(v?.items) ? v.items : [];
}

export function RedisKeyView({ keyName, db }: { keyName: string; db: number }) {
  const tab = useActiveTab();
  const tabId = tab?.id ?? null;
  const deleteRedisKey = useSession((s) => s.deleteRedisKey);
  const setRedisTtl = useSession((s) => s.setRedisTtl);
  const redisKeysRemoved = useSession((s) => s.redisKeysRemoved);
  const redisKeyRenamed = useSession((s) => s.redisKeyRenamed);
  const redisKeyAdded = useSession((s) => s.redisKeyAdded);
  const openRedisKey = useSession((s) => s.openRedisKey);
  const openRedisCli = useSession((s) => s.openRedisCli);
  const setInspectedRow = useWorkbench((s) => s.setInspectedRow);
  const { canWrite, prod, reason } = useRedisWriteGate();

  const [data, setData] = useState<RedisKeyValue | null>(null);
  const [items, setItems] = useState<Items>([]);
  const [listOffset, setListOffset] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [appliedFilter, setAppliedFilter] = useState('');
  const [reverse, setReverse] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<{ op: RedisWriteOp; label: string } | null>(
    null,
  );
  const [editRow, setEditRow] = useState<Cell[] | null>(null);
  const [renameMode, setRenameMode] = useState<'rename' | 'copy' | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [stringView, setStringView] = useState<'auto' | 'raw' | 'hex'>('auto');
  const loadSeq = useRef(0);

  /** Drop our row from the Details pane (only if it's still ours). */
  const clearInspected = useCallback(() => {
    const cur = useWorkbench.getState().inspectedRow;
    if (cur && cur.tabId === tabId) setInspectedRow(null);
  }, [tabId, setInspectedRow]);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    try {
      const r = await ipc.redis.getKey(keyName, {
        db,
        count: PAGE,
        match: appliedFilter || undefined,
        reverse: reverse || undefined,
      });
      if (seq !== loadSeq.current) return;
      if (r.type === 'none' && data && data.type !== 'none') {
        // The key is gone (last element removed / expired / deleted elsewhere).
        redisKeysRemoved([keyName], db);
      }
      setData(r);
      setItems(pageItems(r));
      setListOffset(0);
      setNextCursor(r.nextCursor ?? null);
      setLoadedAt(Date.now());
      // Element positions can shift after a reload — drop the selection.
      setSelected(null);
      clearInspected();
    } catch (err) {
      if (seq === loadSeq.current) setError(errMsg(err));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [keyName, db, appliedFilter, reverse, clearInspected, data, redisKeysRemoved]);

  const loadMore = async () => {
    if (!nextCursor || !data) return;
    setLoading(true);
    try {
      const r = await ipc.redis.getKey(keyName, {
        db,
        cursor: nextCursor,
        count: PAGE,
        match: appliedFilter || undefined,
        reverse: reverse || undefined,
      });
      setItems((prev) => [...prev, ...pageItems(r)]);
      setNextCursor(r.nextCursor ?? null);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setLoading(false);
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload when the query inputs change, not on every data update
  useEffect(() => {
    void load();
  }, [keyName, db, appliedFilter, reverse]);

  // Clear the Details pane when the key changes or the view goes away.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyName is the trigger
  useEffect(() => clearInspected, [keyName, clearInspected]);

  const model = useMemo(
    () => (data ? buildModel(data, items, keyName, listOffset) : null),
    [data, items, keyName, listOffset],
  );

  // F28: scalar keys have no grid — publish the key itself to Details.
  useEffect(() => {
    if (!tabId || !data || !model || model.kind === 'table') return;
    const value =
      model.kind === 'string'
        ? cellText(model.cell)
        : model.kind === 'json'
          ? JSON.stringify(model.value, null, 2)
          : model.kind === 'large'
            ? cellText(model.stub.preview ?? null)
            : null;
    setInspectedRow({
      tabId,
      rowNumber: 1,
      columnIndex: 6,
      columns: [
        { name: 'key', dataTypeID: 0, dataTypeName: 'redis key' },
        { name: 'type', dataTypeID: 0, dataTypeName: 'redis type' },
        { name: 'db', dataTypeID: 0, dataTypeName: 'database' },
        { name: 'ttl', dataTypeID: 0, dataTypeName: 'PTTL' },
        { name: 'memory', dataTypeID: 0, dataTypeName: 'MEMORY USAGE' },
        { name: 'encoding', dataTypeID: 0, dataTypeName: 'OBJECT ENCODING' },
        {
          name: 'value',
          dataTypeID: 0,
          dataTypeName: model.kind === 'string' ? (cellNote(model.cell) ?? 'text') : model.kind,
        },
      ],
      row: [
        keyName,
        data.typeName ?? data.type,
        `db${db}`,
        data.ttlMs === null ? 'no expiry' : formatTtl(data.ttlMs),
        data.memoryBytes == null ? null : formatBytes(data.memoryBytes),
        data.encoding ?? null,
        value,
      ],
    });
  }, [tabId, data, model, keyName, db, setInspectedRow]);

  const writeAndReload = useCallback(
    async (op: RedisWriteOp) => {
      await ipc.redis.write(op, { db });
      await load();
    },
    [db, load],
  );

  const selectRow = (row: Cell[], index: number) => {
    if (!model || model.kind !== 'table') return;
    setSelected(index);
    if (!tabId) return;
    const columns: ColumnMeta[] = model.columns.map((c, i) => ({
      name: c.name,
      dataTypeID: 0,
      dataTypeName: cellNote(row[i]) ?? c.typeName,
    }));
    setInspectedRow({
      tabId,
      rowNumber: index + 1,
      columnIndex: 0,
      columns,
      row: row.map((c) => cellText(c)),
    });
  };

  // Live TTL countdown (R22/R31).
  const [now, setNow] = useState(Date.now());
  const hasTtl = data?.ttlMs !== null && data?.ttlMs !== undefined;
  useEffect(() => {
    if (!hasTtl) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [hasTtl]);
  const ttlLeft = data && data.ttlMs !== null ? data.ttlMs - (now - loadedAt) : null;
  const ttlText = !data
    ? '…'
    : ttlLeft === null
      ? 'No expiry'
      : ttlLeft <= 0
        ? 'Expired'
        : `TTL ${formatTtl(ttlLeft)}`;

  const sizeText = (() => {
    if (!model) return null;
    if (model.kind === 'table')
      return plural(model.total, model.noun.replace(/s$/, ''), model.noun);
    if (model.kind === 'string') {
      const n = isCellObject(model.cell) ? model.cell.$bytes : cellBytes(model.cell).length;
      return formatBytes(n);
    }
    if (model.kind === 'large') return formatBytes(model.stub.sizeBytes);
    return null;
  })();

  const doDelete = async () => {
    await deleteRedisKey(keyName, db);
  };

  const collection = model?.kind === 'table';
  const filterable = data && (data.type === 'hash' || data.type === 'set' || data.type === 'zset');
  const orderable = data && (data.type === 'stream' || (data.type === 'zset' && !appliedFilter));
  const groups =
    data?.type === 'stream' ? ((data.value as { groups?: StreamGroup[] })?.groups ?? []) : [];

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--wb-content)] text-[var(--wb-text)]">
      <ViewToolbar>
        <KeyRound className="h-3.5 w-3.5 shrink-0 text-[var(--wb-text-2)]" />
        <h1 className="min-w-0 truncate font-mono text-[13px] font-semibold" title={keyName}>
          {keyName}
        </h1>
        {data && <Badge className="normal-case">{data.typeName ?? TYPE_LABEL[data.type]}</Badge>}
        <span className="shrink-0 font-mono text-[11px] text-[var(--wb-text-3)]">db{db}</span>
        {sizeText && (
          <span className="shrink-0 text-[12px] tabular-nums text-[var(--wb-text-2)]">
            {sizeText}
          </span>
        )}
        <div className="flex-1" />

        {canWrite && data && data.type !== 'none' ? (
          <TtlPopover
            ttlText={ttlText}
            ttlMs={ttlLeft}
            onSet={async (value, mode) => {
              await setRedisTtl(keyName, value, { db, mode });
              await load();
            }}
          />
        ) : (
          <span
            className="flex shrink-0 items-center gap-1 text-[12px] tabular-nums text-[var(--wb-text-2)]"
            title={data?.ttlMs != null ? 'Counts down live; refresh to re-read PTTL' : undefined}
          >
            <Timer className="h-3.5 w-3.5" />
            {ttlText}
          </span>
        )}

        {canWrite && data && model && (
          <EditAction type={data.type} model={model} keyName={keyName} onWrite={writeAndReload} />
        )}

        <KeyMenu
          canWrite={canWrite}
          keyName={keyName}
          valueText={
            model?.kind === 'string'
              ? cellText(model.cell)
              : model?.kind === 'json'
                ? JSON.stringify(model.value, null, 2)
                : null
          }
          onRename={() => setRenameMode('rename')}
          onCopyKey={() => setRenameMode('copy')}
          onOpenCli={openRedisCli}
        />

        <IconButton
          label="Refresh key"
          title="Refresh"
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        </IconButton>
        {canWrite && (
          <IconButton
            label="Delete key"
            title="Delete key (UNLINK)"
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

      {collection && (filterable || orderable) && (
        <div className="flex h-[34px] shrink-0 items-center gap-2 border-b border-[var(--wb-separator)] px-3">
          {filterable && (
            <form
              className="flex w-[280px] min-w-0"
              onSubmit={(e) => {
                e.preventDefault();
                setAppliedFilter(filter.trim());
              }}
            >
              <SidebarSearch
                value={filter}
                onChange={(v) => {
                  setFilter(v);
                  if (v === '' && appliedFilter) setAppliedFilter('');
                }}
                placeholder={`MATCH ${data?.type === 'hash' ? 'field' : 'member'} pattern…`}
                ariaLabel="Filter elements (Enter to apply)"
              />
            </form>
          )}
          {orderable && (
            <Segmented<'asc' | 'desc'>
              ariaLabel="Order"
              variant="track"
              value={reverse ? 'desc' : 'asc'}
              onChange={(v) => setReverse(v === 'desc')}
              options={
                data?.type === 'stream'
                  ? [
                      { value: 'asc', label: 'Oldest first' },
                      { value: 'desc', label: 'Newest first' },
                    ]
                  : [
                      { value: 'asc', label: 'Lowest score' },
                      { value: 'desc', label: 'Highest score' },
                    ]
              }
            />
          )}
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
            canWrite={canWrite}
            selected={selected}
            onSelect={selectRow}
            onRemove={(op, label) => setConfirmRemove({ op, label })}
            onEdit={(row) => setEditRow(row)}
            stringView={stringView}
            onOpenCli={openRedisCli}
          />
        )}
      </div>

      <ViewFooter>
        {model?.kind === 'string' && (
          <Segmented<'auto' | 'raw' | 'hex'>
            ariaLabel="String view"
            variant="track"
            value={isBinaryCell(model.cell) && stringView === 'auto' ? 'raw' : stringView}
            onChange={setStringView}
            options={[
              { value: 'auto', label: 'Auto', title: 'Pretty-print JSON payloads' },
              { value: 'raw', label: isBinaryCell(model.cell) ? 'Escaped' : 'Raw' },
              { value: 'hex', label: 'Hex' },
            ]}
          />
        )}
        <FooterSummary model={model} total={model?.kind === 'table' ? model.total : 0} />
        {nextCursor && collection && (
          <Pill onClick={() => void loadMore()} disabled={loading}>
            {loading ? <Loader2 className="animate-spin" /> : <Plus />}
            Load {PAGE} more
          </Pill>
        )}
        {groups.length > 0 && <StreamGroups groups={groups} />}
        <div className="flex-1" />
        {data?.memoryBytes != null && (
          <span className="truncate text-[12px]" title="MEMORY USAGE">
            {formatBytes(data.memoryBytes)} in memory
          </span>
        )}
        {data?.idleSeconds != null && (
          <span className="truncate text-[12px]" title="OBJECT IDLETIME">
            idle {formatDuration(data.idleSeconds)}
          </span>
        )}
        {data?.encoding && (
          <span className="truncate text-[12px]">
            encoding <span className="font-mono text-[var(--wb-text)]">{data.encoding}</span>
          </span>
        )}
      </ViewFooter>

      <ActionDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete key?"
        description={`UNLINK ${keyName} in db${db} — this cannot be undone.`}
        confirmLabel="Delete"
        typeToConfirm={prod ? keyName : null}
        onConfirm={doDelete}
      />

      <ActionDialog
        open={confirmRemove !== null}
        onOpenChange={(o) => !o && setConfirmRemove(null)}
        title={`Remove ${confirmRemove?.label ?? 'element'}?`}
        description={
          model?.kind === 'table' && model.total <= 1
            ? 'This is the last element — removing it deletes the key.'
            : 'This cannot be undone.'
        }
        confirmLabel="Remove"
        onConfirm={async () => {
          if (confirmRemove) await writeAndReload(confirmRemove.op);
        }}
      />

      {editRow && data && (
        <ElementEditDialog
          type={data.type}
          row={editRow}
          keyName={keyName}
          listOffset={listOffset}
          onClose={() => setEditRow(null)}
          onWrite={writeAndReload}
        />
      )}

      <RenameCopyDialog
        open={renameMode !== null}
        onOpenChange={(o) => !o && setRenameMode(null)}
        mode={renameMode ?? 'rename'}
        keyName={keyName}
        db={db}
        onDone={(newKey) => {
          if (renameMode === 'rename') redisKeyRenamed(keyName, newKey, db);
          else if (data) {
            redisKeyAdded({ key: newKey, type: data.type, ttlMs: data.ttlMs, sizeBytes: null }, db);
            openRedisKey(newKey, db);
          }
        }}
      />
      {!canWrite && reason && <span className="sr-only">{reason}</span>}
    </main>
  );
}

function KeyMenu({
  canWrite,
  keyName,
  valueText,
  onRename,
  onCopyKey,
  onOpenCli,
}: {
  canWrite: boolean;
  keyName: string;
  valueText: string | null;
  onRename: () => void;
  onCopyKey: () => void;
  onOpenCli: () => void;
}) {
  const [open, setOpen] = useState(false);
  const run = (fn: () => void) => {
    setOpen(false);
    fn();
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton label="Key actions">
          <MoreHorizontal />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={4} className="w-[210px] p-1" role="menu">
        <MenuItem
          icon={<Copy />}
          label="Copy key name"
          onClick={() => run(() => void navigator.clipboard?.writeText(keyName))}
        />
        <MenuItem
          icon={<Copy />}
          label="Copy value"
          disabled={valueText === null}
          onClick={() => run(() => void navigator.clipboard?.writeText(valueText ?? ''))}
        />
        <MenuItem icon={<Terminal />} label="Open redis-cli" onClick={() => run(onOpenCli)} />
        <div className="my-1 h-px bg-[var(--wb-separator)]" />
        <MenuItem
          icon={<TextCursorInput />}
          label="Rename…"
          disabled={!canWrite}
          onClick={() => run(onRename)}
        />
        <MenuItem
          icon={<CopyPlus />}
          label="Duplicate…"
          disabled={!canWrite}
          onClick={() => run(onCopyKey)}
        />
      </PopoverContent>
    </Popover>
  );
}

function StreamGroups({ groups }: { groups: StreamGroup[] }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="shrink-0 text-[12px] underline-offset-2 hover:underline">
          {plural(groups.length, 'consumer group')}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} className="w-[420px] p-0">
        <div className="h-[180px]">
          <DataTable
            ariaLabel="Consumer groups"
            columns={[
              { key: 'name', label: 'group', render: (g: StreamGroup) => g.name },
              {
                key: 'consumers',
                label: 'consumers',
                align: 'right',
                width: 90,
                render: (g) => g.consumers,
              },
              {
                key: 'pending',
                label: 'pending',
                align: 'right',
                width: 80,
                render: (g) => g.pending,
              },
              {
                key: 'last',
                label: 'last delivered',
                width: 150,
                render: (g) => g.lastDeliveredId,
              },
              { key: 'lag', label: 'lag', align: 'right', width: 60, render: (g) => g.lag },
            ]}
            rows={groups}
            rowKey={(g) => g.name}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function FooterSummary({ model, total }: { model: BodyModel | null; total: number }) {
  if (!model) return null;
  if (model.kind === 'table') {
    const count = model.rows.length;
    const partial = total > count;
    const one = model.noun.replace(/s$/, '');
    return (
      <span className="flex min-w-0 items-center gap-2 truncate tabular-nums">
        {partial
          ? `${count.toLocaleString()} of ${plural(total, one, model.noun)}`
          : plural(count, one, model.noun)}
      </span>
    );
  }
  if (model.kind === 'string') {
    const note = cellNote(model.cell);
    return (
      <span className="truncate tabular-nums">
        {note ?? `${(model.cell as string).length.toLocaleString()} chars`}
      </span>
    );
  }
  if (model.kind === 'json') return <span>RedisJSON document</span>;
  if (model.kind === 'large') return <span>Preview only — value not fully fetched</span>;
  return null;
}

function KeyBody({
  model,
  keyName,
  canWrite,
  selected,
  onSelect,
  onRemove,
  onEdit,
  stringView,
  onOpenCli,
}: {
  model: BodyModel;
  keyName: string;
  canWrite: boolean;
  selected: number | null;
  onSelect: (row: Cell[], index: number) => void;
  onRemove: (op: RedisWriteOp, label: string) => void;
  onEdit: (row: Cell[]) => void;
  stringView: 'auto' | 'raw' | 'hex';
  onOpenCli: () => void;
}) {
  switch (model.kind) {
    case 'table':
      return (
        <CollectionTable
          model={model}
          keyName={keyName}
          canWrite={canWrite}
          selected={selected}
          onSelect={onSelect}
          onRemove={onRemove}
          onEdit={onEdit}
        />
      );
    case 'string':
      return <StringBody cell={model.cell} view={stringView} />;
    case 'json':
      return <CodeBlock text={JSON.stringify(model.value, null, 2) ?? 'null'} />;
    case 'large':
      return model.stub.preview ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 border-b border-[var(--wb-separator)] px-4 py-1.5 text-[12px] text-[var(--wb-text-2)]">
            {model.stub.error} — showing the first {formatBytes(64 * 1024)}.
          </div>
          <StringBody cell={model.stub.preview} view="raw" />
        </div>
      ) : (
        <EmptyState title="Large value — not fetched" hint={model.stub.error} />
      );
    case 'error':
      return <EmptyState title="Could not read this key" hint={model.message} />;
    case 'unsupported':
      return (
        <EmptyState
          title={`Unsupported type: ${model.typeName}`}
          hint="Module types (TimeSeries, Bloom, …) have no viewer yet — inspect them with their own commands in redis-cli."
          action={
            <Pill onClick={onOpenCli}>
              <Terminal />
              Open redis-cli
            </Pill>
          }
        />
      );
    default:
      return (
        <EmptyState title="Key not found" hint="It expired or was deleted. Refresh the sidebar." />
      );
  }
}

function CollectionTable({
  model,
  keyName,
  canWrite,
  selected,
  onSelect,
  onRemove,
  onEdit,
}: {
  model: TableModel;
  keyName: string;
  canWrite: boolean;
  selected: number | null;
  onSelect: (row: Cell[], index: number) => void;
  onRemove: (op: RedisWriteOp, label: string) => void;
  onEdit: (row: Cell[]) => void;
}) {
  const columns = useMemo(() => {
    const cols: DataColumn<Cell[]>[] = model.columns.map((c, i) => ({
      key: `${i}:${c.name}`,
      label: c.name,
      title: `${c.name} — ${c.typeName}`,
      align: c.align,
      width: c.width,
      sans: c.sans,
      render: (r) => {
        const cell = r[i];
        if (cell === null || cell === undefined) return null;
        const text = cellText(cell);
        return isCellObject(cell) ? <span className="text-[var(--wb-text-2)]">{text}</span> : text;
      },
      titleOf: (r) => {
        const t = cellText(r[i]);
        const note = cellNote(r[i]);
        return t === null ? undefined : note ? `${t.slice(0, 400)}\n(${note})` : t.slice(0, 400);
      },
    }));
    const removeOp = model.removeOp;
    if (canWrite && (removeOp || model.editable)) {
      cols.push({
        key: '__actions',
        label: '',
        width: 56,
        sans: true,
        render: (r) => {
          const op = removeOp?.(r) ?? null;
          const editable = model.editable?.(r) ?? false;
          const label = cellText(r[0]) ?? '';
          return (
            <span className="flex items-center justify-end gap-0.5">
              {model.editable && (
                <button
                  type="button"
                  disabled={!editable}
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit(r);
                  }}
                  className="grid h-5 w-5 place-items-center rounded-[5px] text-[var(--wb-text-3)] hover:bg-[var(--wb-control-hover)] hover:text-[var(--wb-text)] disabled:opacity-30"
                  aria-label={`Edit ${label}`}
                  title={editable ? 'Edit' : 'Binary / truncated values cannot be edited as text'}
                >
                  <Pencil className="h-3 w-3" />
                </button>
              )}
              {removeOp && (
                <button
                  type="button"
                  disabled={!op}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (op) onRemove(op, label.length > 60 ? `${label.slice(0, 60)}…` : label);
                  }}
                  className="grid h-5 w-5 place-items-center rounded-[5px] text-[var(--wb-text-3)] hover:bg-[color-mix(in_srgb,var(--destructive)_18%,transparent)] hover:text-destructive disabled:opacity-30"
                  aria-label={`Remove ${label}`}
                  title="Remove"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </span>
          );
        },
      });
    }
    return cols;
  }, [model, canWrite, onRemove, onEdit]);

  return (
    <DataTable<Cell[]>
      ariaLabel={`${keyName} ${model.noun}`}
      columns={columns}
      rows={model.rows}
      rowKey={(r, i) => `${i}:${cellText(r[0]) ?? ''}`}
      rowNumbers={model.rowNumbers}
      selectedIndex={selected}
      onSelect={onSelect}
      onActivate={canWrite && model.editable ? (r) => model.editable?.(r) && onEdit(r) : undefined}
      empty={`No ${model.noun}`}
    />
  );
}

function StringBody({ cell, view }: { cell: RedisCell; view: 'auto' | 'raw' | 'hex' }) {
  const text = useMemo(() => {
    if (view === 'hex') return hexBytes(cellBytes(cell));
    const t = cellText(cell) ?? '';
    if (view === 'raw' || isCellObject(cell)) return t;
    try {
      const parsed: unknown = JSON.parse(t);
      if (parsed !== null && typeof parsed === 'object') return JSON.stringify(parsed, null, 2);
    } catch {
      /* not JSON */
    }
    return t;
  }, [cell, view]);
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

// ───────────────────────── TTL (R22) ─────────────────────────

function TtlPopover({
  ttlText,
  ttlMs,
  onSet,
}: {
  ttlText: string;
  ttlMs: number | null;
  onSet: (value: number, mode: 'expire' | 'pexpire' | 'expireat' | 'persist') => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [unit, setUnit] = useState<'s' | 'ms' | 'at'>('s');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setError(null);
      setInput(ttlMs !== null && ttlMs > 0 ? String(Math.round(ttlMs / 1000)) : '');
      setUnit('s');
    }
  }, [open, ttlMs]);

  const parsed = (() => {
    if (unit === 'at') {
      const t = new Date(input).getTime();
      return Number.isFinite(t) && t > Date.now() ? Math.floor(t / 1000) : null;
    }
    const n = Number(input);
    return input.trim() && Number.isInteger(n) && n > 0 ? n : null;
  })();

  const run = async (value: number, mode: 'expire' | 'pexpire' | 'expireat' | 'persist') => {
    setBusy(true);
    setError(null);
    try {
      await onSet(value, mode);
      setOpen(false);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Pill aria-label="Edit TTL" title="Set or remove the expiry">
          <Timer />
          <span className="tabular-nums">{ttlText}</span>
        </Pill>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={4} className="w-[290px] p-3">
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (parsed !== null)
              void run(parsed, unit === 's' ? 'expire' : unit === 'ms' ? 'pexpire' : 'expireat');
          }}
        >
          <Segmented<'s' | 'ms' | 'at'>
            ariaLabel="TTL unit"
            variant="track"
            value={unit}
            onChange={(u) => {
              setUnit(u);
              setInput('');
            }}
            options={[
              { value: 's', label: 'Seconds', title: 'EXPIRE' },
              { value: 'ms', label: 'Millis', title: 'PEXPIRE' },
              { value: 'at', label: 'At time', title: 'EXPIREAT' },
            ]}
          />
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            type={unit === 'at' ? 'datetime-local' : 'text'}
            placeholder={unit === 's' ? 'seconds' : 'milliseconds'}
            inputMode={unit === 'at' ? undefined : 'numeric'}
            aria-label={
              unit === 'at' ? 'Expire at' : unit === 's' ? 'TTL seconds' : 'TTL milliseconds'
            }
            className={FIELD_CLASS}
          />
          {input && parsed === null && (
            <span className="text-[12px] text-destructive">
              {unit === 'at' ? 'Pick a time in the future' : 'Use a positive whole number'}
            </span>
          )}
          {error && (
            <span role="alert" className="text-[12px] text-destructive">
              {error}
            </span>
          )}
          <div className="flex justify-end gap-1.5">
            <Pill
              onClick={() => void run(0, 'persist')}
              disabled={busy || ttlMs === null}
              title="Remove TTL (PERSIST)"
            >
              Persist
            </Pill>
            <Pill type="submit" disabled={busy || parsed === null}>
              {busy && <Loader2 className="animate-spin" />}
              Set expire
            </Pill>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

// ───────────────────────── Edit actions ─────────────────────────

/** The per-type "add / edit" pill in the toolbar (write gate on). */
function EditAction({
  type,
  model,
  keyName,
  onWrite,
}: {
  type: RedisValueType;
  model: BodyModel;
  keyName: string;
  onWrite: (op: RedisWriteOp) => Promise<void>;
}) {
  switch (type) {
    case 'string':
      if (model.kind !== 'string') return null;
      if (!isEditableCell(model.cell)) {
        return (
          <Pill disabled title="Binary or truncated values cannot be edited as text">
            <Pencil />
            Edit value…
          </Pill>
        );
      }
      return (
        <TextEditDialog
          title="Edit string"
          description="Saved with SET … KEEPTTL — the key keeps its current expiry."
          initial={model.cell}
          // R9: KEEPTTL instead of re-applying a stale TTL snapshot.
          onSubmit={(value) => onWrite({ kind: 'setString', key: keyName, value, keepTtl: true })}
        />
      );
    case 'json':
      return model.kind === 'json' ? (
        <TextEditDialog
          title="Edit JSON document"
          description="Saved with JSON.SET key $ — the document must be valid JSON."
          initial={JSON.stringify(model.value, null, 2)}
          json
          onSubmit={(value) => onWrite({ kind: 'jsonSet', key: keyName, path: '$', value })}
        />
      ) : null;
    case 'hash':
      return (
        <FieldsPopover
          label="Set field"
          title="Set field (HSET)"
          fields={['field', 'value']}
          onSubmit={([field, value]) =>
            onWrite({ kind: 'hashSet', key: keyName, field: field!, value: value! })
          }
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
        <FieldsPopover
          label="Add member"
          title="Add member (SADD)"
          fields={['member']}
          onSubmit={([member]) => onWrite({ kind: 'setAdd', key: keyName, members: [member!] })}
        />
      );
    case 'zset':
      return (
        <FieldsPopover
          label="Add member"
          title="Add member (ZADD)"
          fields={['member', 'score']}
          validate={([, score]) =>
            Number.isFinite(Number(score)) && score !== '' ? null : 'Score must be a number'
          }
          onSubmit={([member, score]) =>
            onWrite({ kind: 'zsetAdd', key: keyName, member: member!, score: Number(score) })
          }
        />
      );
    case 'stream':
      return (
        <FieldsPopover
          label="Add entry"
          title="Add entry (XADD *)"
          fields={['field', 'value']}
          onSubmit={([field, value]) =>
            onWrite({ kind: 'streamAdd', key: keyName, id: '*', fields: [[field!, value!]] })
          }
        />
      );
    default:
      return null;
  }
}

function FieldsPopover({
  label,
  title,
  fields,
  validate,
  onSubmit,
}: {
  label: string;
  title: string;
  fields: string[];
  validate?: (values: string[]) => string | null;
  onSubmit: (values: string[]) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<string[]>(() => fields.map(() => ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalid = validate?.(values) ?? null;
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setError(null);
      }}
    >
      <PopoverTrigger asChild>
        <Pill title={title}>
          <Plus />
          {label}
        </Pill>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={4} className="w-[340px] p-3">
        <div className="mb-2 text-[12px] font-medium text-[var(--wb-text-2)]">{title}</div>
        <form
          className="flex flex-col gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!values[0] || invalid) return;
            setBusy(true);
            setError(null);
            try {
              await onSubmit(values);
              setValues(fields.map(() => ''));
            } catch (err) {
              setError(errMsg(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          {fields.map((f, i) => (
            <input
              key={f}
              value={values[i]}
              onChange={(e) =>
                setValues((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))
              }
              placeholder={f}
              aria-label={f[0]!.toUpperCase() + f.slice(1)}
              inputMode={f === 'score' ? 'decimal' : undefined}
              className={FIELD_CLASS}
            />
          ))}
          {(error || (values.some(Boolean) && invalid)) && (
            <span role="alert" className="text-[12px] text-destructive">
              {error ?? invalid}
            </span>
          )}
          <div className="flex justify-end">
            <Pill type="submit" disabled={busy || !values[0] || Boolean(invalid)}>
              {busy && <Loader2 className="animate-spin" />}
              {label.split(' ')[0]}
            </Pill>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function ListEditPopover({
  onPush,
}: { onPush: (side: 'l' | 'r', values: string[]) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (side: 'l' | 'r') => {
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      await onPush(side, [value]);
      setValue('');
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Pill title="Push (LPUSH / RPUSH)">
          <Plus />
          Push
        </Pill>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={4} className="w-[340px] p-3">
        <div className="mb-2 text-[12px] font-medium text-[var(--wb-text-2)]">
          Push (LPUSH / RPUSH)
        </div>
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
          {error && (
            <span role="alert" className="text-[12px] text-destructive">
              {error}
            </span>
          )}
          <div className="flex justify-end gap-1.5">
            <Pill onClick={() => void submit('l')} disabled={busy || !value} title="LPUSH (head)">
              ← LPUSH
            </Pill>
            <Pill type="submit" disabled={busy || !value} title="RPUSH (tail)">
              RPUSH →
            </Pill>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function TextEditDialog({
  title,
  description,
  initial,
  json = false,
  onSubmit,
}: {
  title: string;
  description: string;
  initial: string;
  json?: boolean;
  onSubmit: (value: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const looksJson = json || /^\s*[{[]/.test(value);
  const jsonError = looksJson ? jsonProblem(value) : null;
  return (
    <>
      <Pill
        onClick={() => {
          setValue(initial);
          setError(null);
          setOpen(true);
        }}
        title={title}
      >
        <Pencil />
        Edit value…
      </Pill>
      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent className="max-w-[680px] gap-3 bg-[var(--wb-sidebar)] p-5">
          <DialogHeader>
            <DialogTitle className="text-[15px]">{title}</DialogTitle>
            <DialogDescription className="text-[12px] text-[var(--wb-text-2)]">
              {description}
            </DialogDescription>
          </DialogHeader>
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={14}
            spellCheck={false}
            aria-label="Value"
            className={TEXTAREA_CLASS}
          />
          <div className="flex min-h-4 items-center gap-2 text-[12px]">
            {looksJson &&
              (jsonError ? (
                <span className={json ? 'text-destructive' : 'text-[var(--wb-text-2)]'}>
                  JSON: {jsonError}
                </span>
              ) : (
                <>
                  <span className="text-[var(--wb-text-2)]">Valid JSON</span>
                  <button
                    type="button"
                    className="text-[var(--wb-text-2)] underline-offset-2 hover:text-[var(--wb-text)] hover:underline"
                    onClick={() => setValue(JSON.stringify(JSON.parse(value), null, 2))}
                  >
                    Format
                  </button>
                </>
              ))}
            {error && (
              <span role="alert" className="text-destructive">
                {error}
              </span>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Pill onClick={() => setValue(initial)} disabled={busy || value === initial}>
              Reset
            </Pill>
            <Pill
              disabled={busy || value === initial || (json && jsonError !== null)}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await onSubmit(value);
                  setOpen(false);
                } catch (err) {
                  setError(errMsg(err));
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

function jsonProblem(s: string): string | null {
  try {
    JSON.parse(s);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'invalid';
  }
}

/** In-place edit of one element (R23): hash field/value, zset score, list element, set member. */
function ElementEditDialog({
  type,
  row,
  keyName,
  listOffset,
  onClose,
  onWrite,
}: {
  type: RedisValueType;
  row: Cell[];
  keyName: string;
  listOffset: number;
  onClose: () => void;
  onWrite: (op: RedisWriteOp) => Promise<void>;
}) {
  const first = (row[0] as string) ?? '';
  const second =
    type === 'hash' ? ((row[1] as string) ?? '') : type === 'zset' ? String(row[1] ?? '') : '';
  const listValue = type === 'list' ? ((row[1] as string) ?? '') : '';
  const [a, setA] = useState(type === 'list' ? listValue : first);
  const [b, setB] = useState(second);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (type === 'hash') {
        if (a !== first)
          await onWrite({ kind: 'hashRename', key: keyName, field: first, newField: a });
        if (b !== second) await onWrite({ kind: 'hashSet', key: keyName, field: a, value: b });
      } else if (type === 'zset') {
        const score = Number(b);
        if (!Number.isFinite(score)) throw new Error('Score must be a number');
        if (a !== first) {
          await onWrite({ kind: 'zsetAdd', key: keyName, member: a, score });
          await onWrite({ kind: 'zsetRem', key: keyName, member: first });
        } else {
          await onWrite({ kind: 'zsetAdd', key: keyName, member: a, score });
        }
      } else if (type === 'list') {
        const index = Number(row[0]);
        await onWrite({
          kind: 'listSet',
          key: keyName,
          index: Number.isFinite(index) ? index : listOffset,
          value: a,
        });
      } else if (type === 'set') {
        if (a !== first) {
          await onWrite({ kind: 'setAdd', key: keyName, members: [a] });
          await onWrite({ kind: 'setRem', key: keyName, member: first });
        }
      }
      onClose();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const labels: Record<string, [string, string | null]> = {
    hash: ['Field', 'Value'],
    zset: ['Member', 'Score'],
    list: [`Element at index ${String(row[0])}`, null],
    set: ['Member', null],
  };
  const [la, lb] = labels[type] ?? ['Value', null];
  const hints: Record<string, string> = {
    hash: 'Renaming the field uses HSET + HDEL in one transaction.',
    zset: 'ZADD updates the score; renaming a member is ZADD + ZREM.',
    list: 'LSET by index — if the list changed since loading, refresh first.',
    set: 'SADD the new member, then SREM the old one.',
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-[560px] gap-3 bg-[var(--wb-sidebar)] p-5">
        <DialogHeader>
          <DialogTitle className="text-[15px]">
            Edit {type === 'list' ? 'element' : la.toLowerCase()}
          </DialogTitle>
          <DialogDescription className="text-[12px] text-[var(--wb-text-2)]">
            {hints[type]}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1 text-[12px] text-[var(--wb-text-2)]">
          {la}
          {type === 'list' ? (
            <textarea
              value={a}
              onChange={(e) => setA(e.target.value)}
              aria-label={la}
              rows={6}
              className={TEXTAREA_CLASS}
              spellCheck={false}
            />
          ) : (
            <input
              value={a}
              onChange={(e) => setA(e.target.value)}
              aria-label={la}
              className={FIELD_CLASS}
              spellCheck={false}
            />
          )}
        </div>
        {lb && (
          <div className="flex flex-col gap-1 text-[12px] text-[var(--wb-text-2)]">
            {lb}
            {type === 'hash' ? (
              <textarea
                value={b}
                onChange={(e) => setB(e.target.value)}
                aria-label={lb}
                rows={6}
                className={TEXTAREA_CLASS}
                spellCheck={false}
              />
            ) : (
              <input
                value={b}
                onChange={(e) => setB(e.target.value)}
                aria-label={lb}
                inputMode="decimal"
                className={FIELD_CLASS}
              />
            )}
          </div>
        )}
        {error && (
          <span role="alert" className="text-[12px] text-destructive">
            {error}
          </span>
        )}
        <DialogFooter className="gap-2">
          <Pill onClick={onClose} disabled={busy}>
            Cancel
          </Pill>
          <Pill onClick={() => void save()} disabled={busy || !a}>
            {busy && <Loader2 className="animate-spin" />}
            Save
          </Pill>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────── Value guards ─────────────────────────

function isLargeStub(v: unknown): v is LargeStub {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as LargeStub).truncated === true &&
    typeof (v as LargeStub).error === 'string' &&
    typeof (v as LargeStub).sizeBytes === 'number'
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
