import { type DataColumn, DataTable } from '@/components/ui/data-table';
import { EmptyState, ViewFooter, ViewTitle, ViewToolbar } from '@/components/ui/view-parts';
import { IconButton, Pill, Segmented } from '@/components/ui/workbench';
import { SidebarSearch } from '@/features/sidebar/sidebar-parts';
import { ipc } from '@/lib/ipc';
import { useActiveTab } from '@/stores/session';
import { useWorkbench } from '@/stores/workbench';
import { Loader2, Pencil, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActionDialog, FIELD_CLASS, errMsg } from './redis-dialogs';
import { ago, plural } from './redis-format';
import { useRedisWriteGate } from './use-redis-write';

/**
 * Server panel (R28): the full INFO, CLIENT LIST and CONFIG GET as
 * filterable grids. Kill client / CONFIG SET follow the S1 write gate and
 * always confirm. Everything is read through the CLI route, so the
 * read-only and destructive-command policies apply unchanged.
 */

type Section = 'info' | 'clients' | 'config';
type Row = { cells: string[] };

export function parseInfoAll(text: string): Row[] {
  const rows: Row[] = [];
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line.startsWith('#')) {
      section = line.replace(/^#\s*/, '').trim();
      continue;
    }
    const i = line.indexOf(':');
    if (i > 0) rows.push({ cells: [section, line.slice(0, i), line.slice(i + 1)] });
  }
  return rows;
}

export const CLIENT_COLUMNS = [
  'id',
  'addr',
  'name',
  'user',
  'db',
  'age',
  'idle',
  'cmd',
  'flags',
] as const;

export function parseClientList(text: string): Row[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((line) => {
      const m = new Map<string, string>();
      for (const part of line.split(' ')) {
        const i = part.indexOf('=');
        if (i > 0) m.set(part.slice(0, i), part.slice(i + 1));
      }
      return { cells: CLIENT_COLUMNS.map((c) => m.get(c) ?? '') };
    });
}

function pairs(reply: unknown): Row[] {
  if (!Array.isArray(reply)) return [];
  const out: Row[] = [];
  for (let i = 0; i + 1 < reply.length; i += 2)
    out.push({ cells: [String(reply[i]), String(reply[i + 1])] });
  return out.sort((a, b) => a.cells[0]!.localeCompare(b.cells[0]!));
}

const COLUMNS: Record<Section, { label: string; width?: number; align?: 'right' }[]> = {
  info: [{ label: 'section', width: 130 }, { label: 'field', width: 260 }, { label: 'value' }],
  clients: [
    { label: 'id', width: 70, align: 'right' },
    { label: 'addr', width: 170 },
    { label: 'name', width: 120 },
    { label: 'user', width: 90 },
    { label: 'db', width: 50, align: 'right' },
    { label: 'age', width: 70, align: 'right' },
    { label: 'idle', width: 70, align: 'right' },
    { label: 'cmd', width: 130 },
    { label: 'flags' },
  ],
  config: [{ label: 'parameter', width: 300 }, { label: 'value' }],
};

export function RedisServerView() {
  const tabId = useActiveTab()?.id ?? null;
  const { canWrite } = useRedisWriteGate();
  const [section, setSection] = useState<Section>('info');
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [kill, setKill] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ name: string; value: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (section === 'info') {
        const r = await ipc.redis.command(['INFO', 'everything']);
        setRows(parseInfoAll(String(r.reply ?? '')));
      } else if (section === 'clients') {
        const r = await ipc.redis.command(['CLIENT', 'LIST']);
        setRows(parseClientList(String(r.reply ?? '')));
      } else {
        const r = await ipc.redis.command(['CONFIG', 'GET', '*']);
        setRows(pairs(r.reply));
      }
      setLoadedAt(Date.now());
    } catch (err) {
      setRows([]);
      setError(errMsg(err));
    } finally {
      setLoading(false);
      setSelected(null);
    }
  }, [section]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => useWorkbench.getState().setInspectedRow(null), []);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.cells.some((c) => c.toLowerCase().includes(q)));
  }, [rows, filter]);

  const columns = useMemo<DataColumn<Row>[]>(() => {
    const cols: DataColumn<Row>[] = COLUMNS[section].map((c, i) => ({
      key: c.label,
      label: c.label,
      width: c.width,
      align: c.align,
      render: (r) => r.cells[i] || null,
      titleOf: (r) => r.cells[i],
    }));
    if (canWrite && section !== 'info') {
      cols.push({
        key: '__act',
        label: '',
        width: 36,
        sans: true,
        render: (r) =>
          section === 'clients' ? (
            <button
              type="button"
              className="grid h-5 w-5 place-items-center rounded-[5px] text-[var(--wb-text-3)] hover:bg-[color-mix(in_srgb,var(--destructive)_18%,transparent)] hover:text-destructive"
              aria-label={`Kill client ${r.cells[0]}`}
              title="CLIENT KILL"
              onClick={(e) => {
                e.stopPropagation();
                setKill(r.cells[0] ?? null);
              }}
            >
              <X className="h-3 w-3" />
            </button>
          ) : (
            <button
              type="button"
              className="grid h-5 w-5 place-items-center rounded-[5px] text-[var(--wb-text-3)] hover:bg-[var(--wb-control-hover)] hover:text-[var(--wb-text)]"
              aria-label={`Edit ${r.cells[0]}`}
              title="CONFIG SET"
              onClick={(e) => {
                e.stopPropagation();
                setEdit({ name: r.cells[0]!, value: r.cells[1] ?? '' });
              }}
            >
              <Pencil className="h-3 w-3" />
            </button>
          ),
      });
    }
    return cols;
  }, [section, canWrite]);

  const onSelect = (r: Row, i: number) => {
    setSelected(i);
    if (!tabId) return;
    useWorkbench.getState().setInspectedRow({
      tabId,
      rowNumber: i + 1,
      columnIndex: r.cells.length - 1,
      columns: COLUMNS[section].map((c) => ({
        name: c.label,
        dataTypeID: 0,
        dataTypeName: section,
      })),
      row: r.cells,
    });
  };

  const noun = section === 'info' ? 'field' : section === 'clients' ? 'client' : 'parameter';

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--wb-content)]">
      <ViewToolbar>
        <ViewTitle
          title="Server"
          meta={
            section === 'info'
              ? 'INFO everything'
              : section === 'clients'
                ? 'CLIENT LIST'
                : 'CONFIG GET *'
          }
        />
        <Segmented<Section>
          ariaLabel="Server section"
          variant="plain"
          value={section}
          onChange={(v) => {
            setSection(v);
            setFilter('');
          }}
          options={[
            { value: 'info', label: 'Info' },
            { value: 'clients', label: 'Clients' },
            { value: 'config', label: 'Config' },
          ]}
        />
        <div className="flex-1" />
        <div className="w-[240px]">
          <SidebarSearch value={filter} onChange={setFilter} placeholder={`Filter ${noun}s…`} />
        </div>
        <IconButton label="Refresh" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        </IconButton>
      </ViewToolbar>
      {error ? (
        <EmptyState
          title="Could not read server data"
          hint={`${error}${/NOPERM|unknown command|disabled/i.test(error) ? ' — the server or your ACL user does not allow this command.' : ''}`}
          action={<Pill onClick={() => void load()}>Retry</Pill>}
        />
      ) : (
        <DataTable
          ariaLabel={`Server ${section}`}
          columns={columns}
          rows={visible}
          rowKey={(r, i) => `${i}:${r.cells[0]}:${r.cells[1]}`}
          selectedIndex={selected}
          onSelect={onSelect}
          empty={loading ? 'Loading…' : filter ? `No ${noun} matches "${filter}"` : `No ${noun}s`}
        />
      )}
      <ViewFooter>
        <span className="tabular-nums">
          {filter && visible.length !== rows.length
            ? `${visible.length.toLocaleString()} of ${plural(rows.length, noun)}`
            : plural(rows.length, noun)}
        </span>
        {loadedAt && (
          <span className="text-[12px] text-[var(--wb-text-3)]">· read {ago(loadedAt)}</span>
        )}
      </ViewFooter>

      <ActionDialog
        open={kill !== null}
        onOpenChange={(o) => !o && setKill(null)}
        title={`Kill client ${kill ?? ''}?`}
        description="CLIENT KILL ID — the client is disconnected immediately."
        confirmLabel="Kill client"
        onConfirm={async () => {
          await ipc.redis.command(['CLIENT', 'KILL', 'ID', kill ?? '']);
          await load();
        }}
      />
      <ConfigEditDialog
        entry={edit}
        onClose={() => setEdit(null)}
        onSaved={() => {
          setEdit(null);
          void load();
        }}
      />
    </main>
  );
}

function ConfigEditDialog({
  entry,
  onClose,
  onSaved,
}: {
  entry: { name: string; value: string } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState('');
  useEffect(() => setValue(entry?.value ?? ''), [entry]);
  return (
    <ActionDialog
      open={entry !== null}
      onOpenChange={(o) => !o && onClose()}
      title={`CONFIG SET ${entry?.name ?? ''}`}
      description="Changes the live server configuration (not redis.conf)."
      confirmLabel="Apply"
      onConfirm={async () => {
        if (!entry) return;
        await ipc.redis.command(['CONFIG', 'SET', entry.name, value]);
        onSaved();
      }}
    >
      <input
        aria-label="Value"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className={FIELD_CLASS}
        spellCheck={false}
      />
    </ActionDialog>
  );
}
