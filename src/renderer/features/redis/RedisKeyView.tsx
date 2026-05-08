import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import type { RedisKeyValue, RedisWriteOp } from '@shared/protocol';
import { Loader2, Plus, RefreshCw, Save, Timer, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

/**
 * Inspect / mutate a single Redis key.
 *
 * Loads the key payload via ipc.redis.getKey on mount + manual refresh.
 * Renders engine-shape-specific bodies:
 *
 *   - string   → JSON-aware preview if the payload parses as JSON,
 *                otherwise raw text
 *   - list/set → enumerated rows with index + value
 *   - zset     → score | member two-column grid
 *   - hash     → field | value two-column grid
 *   - stream   → XID header + key/value rows per entry
 *   - json     → JsonTree (already-parsed)
 */
export function RedisKeyView({ keyName }: { keyName: string }) {
  const editMode = useSession((s) => s.editMode);
  const deleteRedisKey = useSession((s) => s.deleteRedisKey);
  const setRedisTtl = useSession((s) => s.setRedisTtl);

  const [data, setData] = useState<RedisKeyValue | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [ttlInput, setTtlInput] = useState('');
  const [ttlBusy, setTtlBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await ipc.redis.getKey(keyName);
      setData(r);
      setTtlInput(r.ttlMs !== null ? Math.round(r.ttlMs / 1000).toString() : '');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [keyName]);

  useEffect(() => {
    void load();
  }, [load]);

  const onSetTtl = async (seconds: number) => {
    setTtlBusy(true);
    try {
      await setRedisTtl(keyName, seconds);
      await load();
    } finally {
      setTtlBusy(false);
    }
  };

  const onDelete = async () => {
    await deleteRedisKey(keyName);
    setConfirmDelete(false);
  };

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {data && (
              <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                {data.type}
              </span>
            )}
            <h1 className="truncate font-mono text-sm">{keyName}</h1>
          </div>
          {data?.encoding && (
            <p className="mt-0.5 font-display text-[11px] italic text-muted-foreground">
              encoding: {data.encoding}
            </p>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          Refresh
        </Button>
        {editMode && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirmDelete(true)}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 />
            Delete
          </Button>
        )}
      </div>

      {/* TTL strip */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/30 px-4 py-2">
        <Timer className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-display text-xs italic text-muted-foreground">TTL</span>
        {data ? (
          data.ttlMs !== null ? (
            <span className="font-mono text-xs">{(data.ttlMs / 1000).toFixed(1)}s</span>
          ) : (
            <span className="font-display text-xs italic text-muted-foreground">never expires</span>
          )
        ) : (
          <span className="font-display text-xs italic text-muted-foreground">…</span>
        )}
        {editMode && data && (
          <>
            <div className="flex-1" />
            <Input
              value={ttlInput}
              onChange={(e) => setTtlInput(e.target.value)}
              placeholder="seconds"
              inputMode="numeric"
              className="h-7 w-32 font-mono text-xs"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const n = Number(ttlInput);
                if (Number.isFinite(n)) void onSetTtl(Math.floor(n));
              }}
              disabled={ttlBusy}
            >
              Set
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void onSetTtl(0)}
              disabled={ttlBusy}
              title="Remove TTL (PERSIST)"
            >
              Clear
            </Button>
          </>
        )}
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {error && (
          <div className="rounded-md border-l-4 border-destructive bg-muted px-4 py-2 text-sm text-foreground">
            {error}
          </div>
        )}
        {loading && !data && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> loading…
          </div>
        )}
        {data && (
          <KeyBody
            data={data}
            keyName={keyName}
            editMode={editMode}
            onMutated={() => {
              void load();
            }}
          />
        )}
      </div>

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

function KeyBody({
  data,
  keyName,
  editMode,
  onMutated,
}: {
  data: RedisKeyValue;
  keyName: string;
  editMode: boolean;
  onMutated: () => void;
}) {
  const writeAndReload = async (op: RedisWriteOp) => {
    try {
      await ipc.redis.write(op);
      onMutated();
    } catch (err) {
      console.error('[plasma] redis write failed', err);
    }
  };

  switch (data.type) {
    case 'string': {
      const raw = typeof data.value === 'string' ? data.value : String(data.value ?? '');
      return (
        <div className="space-y-3">
          <StringBody raw={raw} />
          {editMode && (
            <StringEditDock
              keyName={keyName}
              initial={raw}
              onSubmit={(value) =>
                writeAndReload({ kind: 'setString', key: keyName, value })
              }
            />
          )}
        </div>
      );
    }
    case 'list': {
      const v = data.value as { items: string[]; total: number } | null;
      if (!v) {
        return editMode ? (
          <ListEditDock
            keyName={keyName}
            onPush={(side, values) =>
              writeAndReload({ kind: 'listPush', key: keyName, side, values })
            }
          />
        ) : (
          <Empty />
        );
      }
      return (
        <div className="space-y-3">
          <CollectionBody
            headers={['#', 'value']}
            rows={v.items.map((s, i) => [String(i), s])}
            total={v.total}
            count={v.items.length}
          />
          {editMode && (
            <ListEditDock
              keyName={keyName}
              onPush={(side, values) =>
                writeAndReload({ kind: 'listPush', key: keyName, side, values })
              }
            />
          )}
        </div>
      );
    }
    case 'set': {
      const v = data.value as { items: string[]; total: number } | null;
      const items = v?.items ?? [];
      const removeMember = (member: string) =>
        writeAndReload({ kind: 'setRem', key: keyName, member });
      return (
        <div className="space-y-3">
          {items.length > 0 && (
            <CollectionBody
              headers={['member']}
              rows={items.map((s) => [s])}
              total={v?.total ?? 0}
              count={items.length}
              onRowRemove={editMode ? (row) => removeMember(row[0]) : undefined}
            />
          )}
          {items.length === 0 && !editMode && <Empty />}
          {editMode && (
            <SetEditDock
              keyName={keyName}
              onAdd={(members) =>
                writeAndReload({ kind: 'setAdd', key: keyName, members })
              }
            />
          )}
        </div>
      );
    }
    case 'zset': {
      const v = data.value as { items: [string, string][]; total: number } | null;
      const items = v?.items ?? [];
      const removeMember = (member: string) =>
        writeAndReload({ kind: 'zsetRem', key: keyName, member });
      return (
        <div className="space-y-3">
          {items.length > 0 && (
            <CollectionBody
              headers={['member', 'score']}
              rows={items}
              total={v?.total ?? 0}
              count={items.length}
              onRowRemove={editMode ? (row) => removeMember(row[0]) : undefined}
            />
          )}
          {items.length === 0 && !editMode && <Empty />}
          {editMode && (
            <ZsetEditDock
              keyName={keyName}
              onAdd={(member, score) =>
                writeAndReload({ kind: 'zsetAdd', key: keyName, member, score })
              }
            />
          )}
        </div>
      );
    }
    case 'hash': {
      const v = data.value as { items: [string, string][]; total: number } | null;
      const items = v?.items ?? [];
      const removeField = (field: string) =>
        writeAndReload({ kind: 'hashDel', key: keyName, field });
      return (
        <div className="space-y-3">
          {items.length > 0 && (
            <CollectionBody
              headers={['field', 'value']}
              rows={items}
              total={v?.total ?? 0}
              count={items.length}
              onRowRemove={editMode ? (row) => removeField(row[0]) : undefined}
            />
          )}
          {items.length === 0 && !editMode && <Empty />}
          {editMode && (
            <HashEditDock
              keyName={keyName}
              onSet={(field, value) =>
                writeAndReload({ kind: 'hashSet', key: keyName, field, value })
              }
            />
          )}
        </div>
      );
    }
    case 'stream': {
      const v = data.value as
        | { items: { id: string; fields: [string, string][] }[]; total: number }
        | { error: string }
        | null;
      if (!v) return <Empty />;
      if ('error' in v) return <ErrorBlock message={v.error} />;
      return <StreamBody items={v.items} total={v.total} />;
    }
    case 'json': {
      return (
        <pre className="overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-5">
          {JSON.stringify(data.value, null, 2)}
        </pre>
      );
    }
    case 'none':
      return <Empty />;
    default:
      return (
        <pre className="overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-5">
          {JSON.stringify(data.value, null, 2)}
        </pre>
      );
  }
}

function StringBody({ raw }: { raw: string }) {
  // Try to render JSON pretty-printed if the string is valid JSON. If
  // not, fall through to the raw view. Either way the raw bytes are
  // available below the toggle.
  const [view, setView] = useState<'auto' | 'raw'>('auto');
  let parsed: unknown = null;
  let isJson = false;
  if (view === 'auto') {
    try {
      parsed = JSON.parse(raw);
      isJson = parsed !== null && (typeof parsed === 'object' || Array.isArray(parsed));
    } catch {
      isJson = false;
    }
  }
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setView('auto')}
          className={
            view === 'auto'
              ? 'rounded-sm bg-foreground px-2 py-0.5 text-[11px] uppercase text-background'
              : 'cursor-pointer rounded-sm border border-border px-2 py-0.5 text-[11px] uppercase text-muted-foreground'
          }
        >
          Auto
        </button>
        <button
          type="button"
          onClick={() => setView('raw')}
          className={
            view === 'raw'
              ? 'rounded-sm bg-foreground px-2 py-0.5 text-[11px] uppercase text-background'
              : 'cursor-pointer rounded-sm border border-border px-2 py-0.5 text-[11px] uppercase text-muted-foreground'
          }
        >
          Raw
        </button>
        <span className="font-display text-[11px] italic text-muted-foreground">
          {raw.length} chars
        </span>
      </div>
      <pre className="overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-5">
        {view === 'auto' && isJson ? JSON.stringify(parsed, null, 2) : raw}
      </pre>
    </div>
  );
}

function CollectionBody({
  headers,
  rows,
  total,
  count,
  onRowRemove,
}: {
  headers: string[];
  rows: string[][];
  total: number;
  count: number;
  /** When provided, each row gets a trash icon that calls this with the row tuple. */
  onRowRemove?: (row: string[]) => void;
}) {
  return (
    <div>
      {total > count && (
        <div className="mb-2 rounded-md border-l-4 border-amber-500 bg-muted/40 px-3 py-1 font-display text-[11px] italic text-muted-foreground">
          showing {count.toLocaleString()} of {total.toLocaleString()} elements
        </div>
      )}
      <div className="overflow-auto rounded-md border border-border">
        <table className="w-full font-mono text-xs">
          <thead className="bg-muted/60 text-muted-foreground">
            <tr>
              {headers.map((h) => (
                <th
                  key={h}
                  className="border-b border-border px-3 py-1.5 text-left text-[10px] uppercase tracking-wider"
                >
                  {h}
                </th>
              ))}
              {onRowRemove && <th className="border-b border-border px-3 py-1.5" />}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={`${i}-${r[0] ?? ''}`}
                className="border-b border-border/50 last:border-b-0 hover:bg-muted/30"
              >
                {r.map((cell, j) => (
                  <td
                    key={headers[j] ?? `col-${j}`}
                    className="break-all px-3 py-1 align-top text-foreground"
                  >
                    {cell}
                  </td>
                ))}
                {onRowRemove && (
                  <td className="px-3 py-1 align-top text-right">
                    <button
                      type="button"
                      onClick={() => onRowRemove(r)}
                      className="cursor-pointer rounded-sm p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      aria-label="Remove"
                      title="Remove"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EditDockShell({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-dashed border-border bg-muted/20 p-3">
      <div className="mb-2 font-display text-[11px] uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      {children}
    </div>
  );
}

function StringEditDock({
  keyName: _keyName,
  initial,
  onSubmit,
}: {
  keyName: string;
  initial: string;
  onSubmit: (value: string) => Promise<void>;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  return (
    <EditDockShell title="Edit string (SET)">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={4}
        spellCheck={false}
        className="w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-xs text-foreground outline-none focus:border-primary"
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setValue(initial)}
          disabled={busy || value === initial}
        >
          Reset
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={busy || value === initial}
          onClick={async () => {
            setBusy(true);
            try {
              await onSubmit(value);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Loader2 className="animate-spin" /> : <Save />}
          Save
        </Button>
      </div>
    </EditDockShell>
  );
}

function HashEditDock({
  keyName: _keyName,
  onSet,
}: {
  keyName: string;
  onSet: (field: string, value: string) => Promise<void>;
}) {
  const [field, setField] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <EditDockShell title="Set field (HSET)">
      <form
        className="flex items-center gap-2"
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
        <Input
          value={field}
          onChange={(e) => setField(e.target.value)}
          placeholder="field"
          className="h-7 font-mono text-xs"
        />
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="value"
          className="h-7 font-mono text-xs"
        />
        <Button type="submit" variant="primary" size="sm" disabled={busy || !field}>
          {busy ? <Loader2 className="animate-spin" /> : <Plus />}
          Set
        </Button>
      </form>
    </EditDockShell>
  );
}

function ListEditDock({
  keyName: _keyName,
  onPush,
}: {
  keyName: string;
  onPush: (side: 'l' | 'r', values: string[]) => Promise<void>;
}) {
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
    <EditDockShell title="Push (LPUSH / RPUSH)">
      <div className="flex items-center gap-2">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="value"
          className="h-7 font-mono text-xs"
        />
        <Button
          variant="outline"
          size="sm"
          onClick={() => void submit('l')}
          disabled={busy || !value}
          title="LPUSH (head)"
        >
          ← LPUSH
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void submit('r')}
          disabled={busy || !value}
          title="RPUSH (tail)"
        >
          RPUSH →
        </Button>
      </div>
    </EditDockShell>
  );
}

function SetEditDock({
  keyName: _keyName,
  onAdd,
}: {
  keyName: string;
  onAdd: (members: string[]) => Promise<void>;
}) {
  const [member, setMember] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <EditDockShell title="Add member (SADD)">
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
        <Input
          value={member}
          onChange={(e) => setMember(e.target.value)}
          placeholder="member"
          className="h-7 font-mono text-xs"
        />
        <Button type="submit" variant="primary" size="sm" disabled={busy || !member}>
          {busy ? <Loader2 className="animate-spin" /> : <Plus />}
          Add
        </Button>
      </form>
    </EditDockShell>
  );
}

function ZsetEditDock({
  keyName: _keyName,
  onAdd,
}: {
  keyName: string;
  onAdd: (member: string, score: number) => Promise<void>;
}) {
  const [member, setMember] = useState('');
  const [scoreStr, setScoreStr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <EditDockShell title="Add member (ZADD)">
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
        <Input
          value={member}
          onChange={(e) => setMember(e.target.value)}
          placeholder="member"
          className="h-7 font-mono text-xs"
        />
        <Input
          value={scoreStr}
          onChange={(e) => setScoreStr(e.target.value)}
          placeholder="score"
          inputMode="decimal"
          className="h-7 w-28 font-mono text-xs"
        />
        <Button type="submit" variant="primary" size="sm" disabled={busy || !member}>
          {busy ? <Loader2 className="animate-spin" /> : <Plus />}
          Add
        </Button>
      </form>
    </EditDockShell>
  );
}

function StreamBody({
  items,
  total,
}: {
  items: { id: string; fields: [string, string][] }[];
  total: number;
}) {
  return (
    <div className="space-y-3">
      {total > items.length && (
        <div className="rounded-md border-l-4 border-amber-500 bg-muted/40 px-3 py-1 font-display text-[11px] italic text-muted-foreground">
          showing {items.length.toLocaleString()} of {total.toLocaleString()} entries
        </div>
      )}
      {items.map((it) => (
        <details
          key={it.id}
          className="rounded-md border border-border bg-muted/20 [&_summary]:cursor-pointer"
          open
        >
          <summary className="flex items-center gap-2 px-3 py-2 font-mono text-xs">
            <span className="text-muted-foreground">XID</span>
            <span className="text-foreground">{it.id}</span>
            <span className="ml-auto font-display italic text-muted-foreground">
              {it.fields.length} fields
            </span>
          </summary>
          <table className="w-full font-mono text-xs">
            <tbody>
              {it.fields.map(([f, v], i) => (
                <tr
                  key={`${it.id}-${i}-${f}`}
                  className="border-t border-border/50 hover:bg-muted/30"
                >
                  <td className="w-1/3 px-3 py-1 align-top text-muted-foreground">{f}</td>
                  <td className="break-all px-3 py-1 align-top">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ))}
    </div>
  );
}

function Empty() {
  return (
    <div className="flex flex-col items-start gap-1 font-display italic text-muted-foreground">
      <span className="text-sm">empty</span>
      <span className="text-[11px]">key has no value or has been removed</span>
    </div>
  );
}

function ErrorBlock({ message }: { message: string }) {
  return (
    <div className="rounded-md border-l-4 border-destructive bg-muted px-4 py-2 text-sm text-foreground">
      {message}
    </div>
  );
}
