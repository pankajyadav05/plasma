import { type DataColumn, DataTable } from '@/components/ui/data-table';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { EmptyState, StatTile, ViewFooter, ViewToolbar } from '@/components/ui/view-parts';
import { IconButton, MenuItem, Pill, Segmented } from '@/components/ui/workbench';
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import { useWorkbench } from '@/stores/workbench';
import type { ColumnMeta, OsAlias, OsMappingNode } from '@shared/protocol';
import {
  ChevronDown,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  Wrench,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { OsCodeEditor } from './OsCodeEditor';
import { fmtBytes, healthTone } from './os-format';
import { OsBadge, errMessage } from './os-parts';
import { confirmOsWrite, useOsWriteAccess } from './os-write';

/** One mapping field, flattened to a dot path (`address.geo.lat`). */
interface FieldRow {
  path: string;
  type: string | null;
  depth: number;
  /** Direct sub-properties (object / nested fields). */
  properties: number;
  multiFields: string;
  conflicts: string | null;
}

function flattenMapping(nodes: OsMappingNode[], prefix = '', depth = 0): FieldRow[] {
  const out: FieldRow[] = [];
  for (const n of nodes) {
    const path = prefix ? `${prefix}.${n.name}` : n.name;
    out.push({
      path,
      type: n.type,
      depth,
      properties: n.children.length,
      multiFields: (n.multiFields ?? []).map((m) => `${m.name} (${m.type ?? '?'})`).join(', '),
      conflicts: n.conflicts && n.conflicts.length > 1 ? n.conflicts.join(' / ') : null,
    });
    if (n.children.length > 0) out.push(...flattenMapping(n.children, path, depth + 1));
  }
  return out;
}

const INSPECT_COLUMNS: ColumnMeta[] = [
  { name: 'field', dataTypeID: 0, dataTypeName: 'path' },
  { name: 'type', dataTypeID: 0, dataTypeName: 'mapping type' },
  { name: 'depth', dataTypeID: 0, dataTypeName: 'int' },
  { name: 'properties', dataTypeID: 0, dataTypeName: 'int' },
  { name: 'multi-fields', dataTypeID: 0, dataTypeName: 'fields' },
  { name: 'conflicts', dataTypeID: 0, dataTypeName: 'types' },
];

const COLUMNS: DataColumn<FieldRow>[] = [
  {
    key: 'path',
    label: 'Field',
    title: 'Field path (nested objects flattened with dots)',
    width: 280,
    render: (r) => r.path,
    titleOf: (r) => r.path,
  },
  {
    key: 'type',
    label: 'Type',
    width: 140,
    sans: true,
    render: (r) =>
      r.type ? (
        <OsBadge tone={r.conflicts ? 'warn' : 'neutral'}>{r.conflicts ?? r.type}</OsBadge>
      ) : null,
  },
  {
    key: 'multi',
    label: 'Multi-fields',
    width: 180,
    render: (r) => r.multiFields || '',
    titleOf: (r) => r.multiFields || undefined,
  },
  {
    key: 'properties',
    label: 'Properties',
    title: 'Direct sub-properties of an object / nested field',
    render: (r) =>
      r.properties > 0 ? (
        <span className="text-[var(--wb-text-2)]">
          {r.properties} {r.properties === 1 ? 'property' : 'properties'}
        </span>
      ) : (
        ''
      ),
  },
];

type Section = 'mapping' | 'settings' | 'aliases' | 'stats';

interface KV {
  key: string;
  value: string;
}

const KV_COLUMNS: DataColumn<KV>[] = [
  { key: 'k', label: 'Setting', width: 340, render: (r) => r.key, titleOf: (r) => r.key },
  { key: 'v', label: 'Value', render: (r) => r.value, titleOf: (r) => r.value },
];

const ALIAS_COLUMNS: DataColumn<OsAlias>[] = [
  { key: 'alias', label: 'Alias', width: 260, render: (r) => r.alias },
  {
    key: 'write',
    label: 'Write index',
    width: 100,
    sans: true,
    render: (r) => (r.isWriteIndex ? <OsBadge>write</OsBadge> : ''),
  },
  {
    key: 'filter',
    label: 'Filter',
    render: (r) => r.filter,
    titleOf: (r) => r.filter ?? undefined,
  },
];

/** Index operations (O16). All confirmed; destructive ones type-to-confirm. */
const OPERATIONS: Array<{
  label: string;
  method: 'POST' | 'PUT';
  suffix: string;
  destructive?: boolean;
  description: string;
  body?: string;
}> = [
  {
    label: 'Refresh',
    method: 'POST',
    suffix: '_refresh',
    description: 'Make recent writes searchable.',
  },
  { label: 'Flush', method: 'POST', suffix: '_flush', description: 'Flush the translog to disk.' },
  {
    label: 'Clear cache',
    method: 'POST',
    suffix: '_cache/clear',
    description: 'Clear the query, request and field data caches.',
  },
  {
    label: 'Force merge to 1 segment…',
    method: 'POST',
    suffix: '_forcemerge?max_num_segments=1',
    destructive: true,
    description: 'Heavy I/O: merges every shard down to one segment. Only for read-only indices.',
  },
  {
    label: 'Close index…',
    method: 'POST',
    suffix: '_close',
    destructive: true,
    description: 'A closed index cannot be read or written until it is opened again.',
  },
  { label: 'Open index', method: 'POST', suffix: '_open', description: 'Re-open a closed index.' },
  {
    label: 'Block writes',
    method: 'PUT',
    suffix: '_settings',
    body: '{"index.blocks.write": true}',
    description: 'Set index.blocks.write = true.',
  },
  {
    label: 'Allow writes',
    method: 'PUT',
    suffix: '_settings',
    body: '{"index.blocks.write": null}',
    description: 'Remove index.blocks.write.',
  },
];

function flatSettings(obj: unknown): KV[] {
  const out: KV[] = [];
  const walk = (v: unknown, prefix: string) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        walk(x, prefix ? `${prefix}.${k}` : k);
      }
    } else {
      out.push({ key: prefix, value: typeof v === 'string' ? v : JSON.stringify(v) });
    }
  };
  walk(obj, '');
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * One OpenSearch index: mapping (multi-fields, conflicts), settings with
 * a dynamic-settings editor, aliases with add/remove, live `_stats`, and
 * index operations (O15/O16). Writes follow the write gate (S1).
 */
export function OsIndexView({ tabId, indexName }: { tabId: string; indexName: string }) {
  const overview = useSession((s) => s.osOverview);
  const openSearch = useSession((s) => s.openOsSearch);
  const requestDelete = useSession((s) => s.requestOsDeleteIndex);
  const refreshOverview = useSession((s) => s.refreshOsOverview);
  const setInspectedRow = useWorkbench((s) => s.setInspectedRow);
  const access = useOsWriteAccess();

  const [section, setSection] = useState<Section>('mapping');
  const [mapping, setMapping] = useState<OsMappingNode | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [opsMenu, setOpsMenu] = useState(false);
  const [reindexDest, setReindexDest] = useState('');

  const stats = overview?.indices.find((i) => i.index === indexName);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const root = await ipc.os.mapping(indexName);
      setMapping(root);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setLoading(false);
    }
  }, [indexName]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => (mapping ? flattenMapping(mapping.children) : []), [mapping]);
  const objectCount = useMemo(() => rows.filter((r) => r.properties > 0).length, [rows]);
  const conflictCount = useMemo(() => rows.filter((r) => r.conflicts).length, [rows]);

  // Selection is per-mapping: reset (and clear Details) when it reloads.
  // biome-ignore lint/correctness/useExhaustiveDependencies: rows identity is the trigger
  useEffect(() => {
    setSelected(null);
    setInspectedRow(null);
  }, [rows, setInspectedRow]);

  useEffect(() => () => setInspectedRow(null), [setInspectedRow]);

  const select = useCallback(
    (row: FieldRow, index: number) => {
      setSelected(index);
      setInspectedRow({
        tabId,
        rowNumber: index + 1,
        columnIndex: 0,
        columns: INSPECT_COLUMNS,
        row: [row.path, row.type, row.depth, row.properties, row.multiFields, row.conflicts],
      });
    },
    [tabId, setInspectedRow],
  );

  const indexPath = encodeURIComponent(indexName);

  const runOperation = async (op: (typeof OPERATIONS)[number]) => {
    setOpsMenu(false);
    const ok = await confirmOsWrite({
      title: `${op.label.replace(/…$/, '')} ${indexName}?`,
      description: op.description,
      confirmLabel: op.label.replace(/…$/, ''),
      destructive: op.destructive,
      typeToConfirm: op.destructive ? indexName : undefined,
    });
    if (!ok) return;
    setNotice(`${op.label.replace(/…$/, '')}…`);
    try {
      const res = await ipc.os.request({
        method: op.method,
        path: `/${indexPath}/${op.suffix}`,
        body: op.body,
        timeoutMs: 600_000,
      });
      if (res.status >= 400) {
        const b = res.body as { error?: { reason?: string } };
        throw new Error(b.error?.reason ?? JSON.stringify(res.body));
      }
      setNotice(`${op.label.replace(/…$/, '')}: done`);
      void refreshOverview();
    } catch (err) {
      setNotice(`${op.label.replace(/…$/, '')} failed: ${errMessage(err)}`);
    }
  };

  const reindex = async (dest: string) => {
    setOpsMenu(false);
    if (!dest) return;
    const ok = await confirmOsWrite({
      title: `Reindex into ${dest}?`,
      description: `Every document in ${indexName} will be copied into ${dest}.`,
      confirmLabel: 'Reindex',
      destructive: true,
      typeToConfirm: dest,
    });
    if (!ok) return;
    setNotice('Reindexing…');
    try {
      const res = await ipc.os.request({
        method: 'POST',
        path: '/_reindex?wait_for_completion=false',
        body: JSON.stringify({ source: { index: indexName }, dest: { index: dest } }),
      });
      const b = res.body as { task?: string; error?: { reason?: string } };
      if (res.status >= 400) throw new Error(b.error?.reason ?? JSON.stringify(res.body));
      setNotice(`Reindex started — task ${b.task ?? '?'} (see Tasks on the overview)`);
    } catch (err) {
      setNotice(`Reindex failed: ${errMessage(err)}`);
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--wb-content)]">
      <ViewToolbar className="min-w-0 overflow-hidden">
        <span className="min-w-0 truncate font-mono font-semibold text-[var(--wb-text)]">
          {indexName}
        </span>
        {stats && <OsBadge tone={healthTone(stats.health)}>{stats.health}</OsBadge>}
        {stats && stats.status !== 'open' && <OsBadge tone="warn">{stats.status}</OsBadge>}
        {stats && (
          <span className="min-w-0 truncate whitespace-nowrap text-[12px] text-[var(--wb-text-2)]">
            {stats.docsCount.toLocaleString()} docs · {fmtBytes(stats.storeBytes)}
          </span>
        )}
        <div className="flex-1" />
        <Pill onClick={() => openSearch(indexName)}>
          <Search />
          Search
        </Pill>
        <Popover open={opsMenu} onOpenChange={setOpsMenu}>
          <PopoverTrigger asChild>
            <Pill title={access.reason ?? 'Index operations'} aria-label="Index operations">
              <Wrench />
              Operations
              <ChevronDown className="opacity-70" />
            </Pill>
          </PopoverTrigger>
          <PopoverContent align="end" sideOffset={4} className="w-[240px] p-1" role="menu">
            {OPERATIONS.map((op) => (
              <MenuItem
                key={op.label}
                label={op.label}
                disabled={!access.canWrite}
                onClick={() => void runOperation(op)}
              />
            ))}
            <div className="my-1 h-px bg-[var(--wb-separator)]" />
            <form
              className="flex items-center gap-1 px-1 py-0.5"
              onSubmit={(e) => {
                e.preventDefault();
                void reindex(reindexDest.trim());
              }}
            >
              <input
                value={reindexDest}
                onChange={(e) => setReindexDest(e.target.value)}
                placeholder={`${indexName}-copy`}
                aria-label="Reindex destination"
                spellCheck={false}
                disabled={!access.canWrite}
                className="h-6 min-w-0 flex-1 rounded-[6px] bg-[var(--wb-field)] px-2 font-mono text-[12px] text-[var(--wb-text)] outline-none"
              />
              <Pill type="submit" disabled={!access.canWrite || !reindexDest.trim()}>
                Reindex
              </Pill>
            </form>
            {!access.canWrite && (
              <div className="px-2 py-1 text-[11px] leading-snug text-[var(--wb-text-3)]">
                {access.reason}
              </div>
            )}
          </PopoverContent>
        </Popover>
        <Pill
          onClick={() => requestDelete(indexName)}
          aria-label={`Delete index ${indexName}`}
          disabled={!access.canWrite}
          title={access.reason ?? `Delete index ${indexName}`}
          className="text-destructive hover:text-destructive"
        >
          <Trash2 />
          Delete
        </Pill>
      </ViewToolbar>

      {error && (
        <div className="shrink-0 border-b border-[var(--wb-separator)] bg-[color-mix(in_srgb,var(--destructive)_14%,transparent)] px-3 py-1.5 font-mono text-[12px] text-[var(--wb-text)]">
          {error}
        </div>
      )}

      {stats && (
        <div className="grid shrink-0 grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2 px-4 pt-3">
          <StatTile label="Documents" value={stats.docsCount.toLocaleString()} />
          <StatTile label="Deleted docs" value={stats.docsDeleted.toLocaleString()} />
          <StatTile label="Store size" value={fmtBytes(stats.storeBytes)} />
          <StatTile label="Shards" value={`${stats.primaries}p / ${stats.replicas}r`} />
          <StatTile label="Status" value={stats.status} hint={`health ${stats.health}`} />
          <StatTile
            label="Fields"
            value={mapping ? rows.length.toLocaleString() : '—'}
            hint={
              conflictCount > 0
                ? `${conflictCount} conflicting`
                : mapping && objectCount > 0
                  ? `${objectCount} object`
                  : undefined
            }
          />
        </div>
      )}

      <div className="flex shrink-0 items-center px-4 pb-2 pt-4">
        <Segmented<Section>
          ariaLabel="Index section"
          value={section}
          onChange={setSection}
          options={[
            { value: 'mapping', label: 'Mapping' },
            { value: 'settings', label: 'Settings' },
            { value: 'aliases', label: 'Aliases' },
            { value: 'stats', label: 'Stats' },
          ]}
        />
      </div>

      {section === 'mapping' &&
        (loading && !mapping ? (
          <EmptyState
            title={
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading mapping…
              </span>
            }
          />
        ) : (
          <DataTable
            ariaLabel={`Mapping of ${indexName}`}
            columns={COLUMNS}
            rows={rows}
            rowKey={(r) => r.path}
            selectedIndex={selected}
            onSelect={select}
            empty={
              mapping ? 'No fields declared (dynamic mapping)' : error ? 'Mapping unavailable' : ''
            }
            className="border-t border-[var(--wb-separator)]"
          />
        ))}
      {section === 'settings' && (
        <SettingsSection indexName={indexName} canWrite={access.canWrite} reason={access.reason} />
      )}
      {section === 'aliases' && (
        <AliasesSection indexName={indexName} canWrite={access.canWrite} reason={access.reason} />
      )}
      {section === 'stats' && <StatsSection indexName={indexName} />}

      <ViewFooter className="whitespace-nowrap">
        <span className="min-w-0 truncate">
          {notice ??
            `${rows.length.toLocaleString()} ${rows.length === 1 ? 'field' : 'fields'}${
              objectCount > 0 ? ` · ${objectCount} ${objectCount === 1 ? 'object' : 'objects'}` : ''
            }`}
        </span>
        <div className="flex-1" />
        <IconButton
          label="Refresh"
          onClick={() => {
            setNotice(null);
            void load();
            void refreshOverview();
          }}
          disabled={loading}
        >
          {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        </IconButton>
      </ViewFooter>
    </div>
  );
}

function SettingsSection({
  indexName,
  canWrite,
  reason,
}: {
  indexName: string;
  canWrite: boolean;
  reason: string | null;
}) {
  const [settings, setSettings] = useState<KV[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('{\n  "index": {\n    "number_of_replicas": 1\n  }\n}\n');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await ipc.os.request({
        method: 'GET',
        path: `/${encodeURIComponent(indexName)}/_settings`,
      });
      if (res.status >= 400) throw new Error(JSON.stringify(res.body));
      const body = res.body as Record<string, { settings?: unknown }>;
      const first = Object.values(body)[0];
      setSettings(flatSettings(first?.settings ?? {}));
    } catch (err) {
      setError(errMessage(err));
    }
  }, [indexName]);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = async () => {
    const ok = await confirmOsWrite({
      title: `Update settings of ${indexName}?`,
      description: 'Only dynamic settings can change on an open index.',
      confirmLabel: 'Apply settings',
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const res = await ipc.os.request({
        method: 'PUT',
        path: `/${encodeURIComponent(indexName)}/_settings`,
        body: draft,
      });
      if (res.status >= 400) {
        const b = res.body as { error?: { reason?: string } };
        throw new Error(b.error?.reason ?? JSON.stringify(res.body));
      }
      setEditing(false);
      void load();
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-[var(--wb-separator)]">
      {error && (
        <div className="shrink-0 px-4 py-1.5 font-mono text-[12px] text-destructive">{error}</div>
      )}
      {editing ? (
        <>
          <OsCodeEditor
            value={draft}
            onChange={setDraft}
            language="json"
            ariaLabel="Settings to apply"
            onRun={() => void apply()}
            className="min-h-0 flex-1"
          />
          <div className="flex h-9 shrink-0 items-center justify-end gap-2 border-t border-[var(--wb-separator)] px-2.5">
            <Pill onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </Pill>
            <Pill onClick={() => void apply()} disabled={busy}>
              {busy ? 'Applying…' : 'Apply settings'}
            </Pill>
          </div>
        </>
      ) : (
        <>
          <DataTable
            ariaLabel={`Settings of ${indexName}`}
            columns={KV_COLUMNS}
            rows={settings ?? []}
            rowKey={(r) => r.key}
            empty={settings === null ? 'Loading…' : 'No settings'}
          />
          <div className="flex h-9 shrink-0 items-center justify-end gap-2 border-t border-[var(--wb-separator)] px-2.5">
            <Pill
              onClick={() => setEditing(true)}
              disabled={!canWrite}
              title={reason ?? 'Edit dynamic settings'}
            >
              <Settings2 />
              Edit settings…
            </Pill>
          </div>
        </>
      )}
    </div>
  );
}

function AliasesSection({
  indexName,
  canWrite,
  reason,
}: {
  indexName: string;
  canWrite: boolean;
  reason: string | null;
}) {
  const [aliases, setAliases] = useState<OsAlias[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<number | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const all = await ipc.os.aliases();
      setAliases(all.filter((a) => a.index === indexName));
    } catch (err) {
      setError(errMessage(err));
    }
  }, [indexName]);

  useEffect(() => {
    void load();
  }, [load]);

  const change = async (action: 'add' | 'remove', alias: string) => {
    const ok = await confirmOsWrite({
      title: action === 'add' ? `Add alias ${alias}?` : `Remove alias ${alias}?`,
      description:
        action === 'add'
          ? `${alias} will point at ${indexName}.`
          : `${alias} will no longer point at ${indexName}. Clients using it may break.`,
      confirmLabel: action === 'add' ? 'Add alias' : 'Remove alias',
      destructive: action === 'remove',
    });
    if (!ok) return;
    try {
      const res = await ipc.os.request({
        method: 'POST',
        path: '/_aliases',
        body: JSON.stringify({ actions: [{ [action]: { index: indexName, alias } }] }),
      });
      if (res.status >= 400) {
        const b = res.body as { error?: { reason?: string } };
        throw new Error(b.error?.reason ?? JSON.stringify(res.body));
      }
      setName('');
      setSelected(null);
      void load();
    } catch (err) {
      setError(errMessage(err));
    }
  };

  const current = selected !== null ? aliases?.[selected] : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-[var(--wb-separator)]">
      {error && (
        <div className="shrink-0 px-4 py-1.5 font-mono text-[12px] text-destructive">{error}</div>
      )}
      <DataTable
        ariaLabel={`Aliases of ${indexName}`}
        columns={ALIAS_COLUMNS}
        rows={aliases ?? []}
        rowKey={(r) => r.alias}
        selectedIndex={selected}
        onSelect={(_, i) => setSelected(i)}
        empty={aliases === null ? 'Loading…' : 'No aliases point at this index'}
      />
      <form
        className="flex h-9 shrink-0 items-center gap-2 border-t border-[var(--wb-separator)] px-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void change('add', name.trim());
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="alias name"
          aria-label="New alias name"
          spellCheck={false}
          className="h-6 w-56 rounded-[6px] bg-[var(--wb-field)] px-2 font-mono text-[13px] text-[var(--wb-text)] outline-none"
        />
        <Pill type="submit" disabled={!canWrite || !name.trim()} title={reason ?? 'Add alias'}>
          <Plus />
          Add alias
        </Pill>
        <div className="flex-1" />
        <Pill
          disabled={!canWrite || !current}
          title={reason ?? 'Remove the selected alias'}
          onClick={() => current && void change('remove', current.alias)}
          className="text-destructive hover:text-destructive"
        >
          <Trash2 />
          Remove
        </Pill>
      </form>
    </div>
  );
}

function StatsSection({ indexName }: { indexName: string }) {
  const [rows, setRows] = useState<KV[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await ipc.os.request({
        method: 'GET',
        path: `/${encodeURIComponent(indexName)}/_stats`,
      });
      if (res.status >= 400) throw new Error(JSON.stringify(res.body));
      const body = res.body as {
        indices?: Record<
          string,
          { primaries?: Record<string, unknown>; total?: Record<string, unknown> }
        >;
      };
      const entry = Object.values(body.indices ?? {})[0];
      const pick = (scope: 'primaries' | 'total') => {
        const s = (entry?.[scope] ?? {}) as Record<string, Record<string, unknown>>;
        return [
          ['docs.count', s.docs?.count],
          ['docs.deleted', s.docs?.deleted],
          [
            'store.size',
            typeof s.store?.size_in_bytes === 'number'
              ? fmtBytes(s.store.size_in_bytes as number)
              : undefined,
          ],
          ['indexing.index_total', s.indexing?.index_total],
          [
            'indexing.index_time',
            s.indexing?.index_time_in_millis !== undefined
              ? `${s.indexing.index_time_in_millis} ms`
              : undefined,
          ],
          ['search.query_total', s.search?.query_total],
          [
            'search.query_time',
            s.search?.query_time_in_millis !== undefined
              ? `${s.search.query_time_in_millis} ms`
              : undefined,
          ],
          ['refresh.total', s.refresh?.total],
          ['merges.total', s.merges?.total],
          ['segments.count', s.segments?.count],
        ]
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => ({ key: `${scope}.${k}`, value: String(v) }));
      };
      setRows([...pick('primaries'), ...pick('total')]);
      setLoadedAt(Date.now());
    } catch (err) {
      setError(errMessage(err));
    }
  }, [indexName]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-[var(--wb-separator)]">
      {error && (
        <div className="shrink-0 px-4 py-1.5 font-mono text-[12px] text-destructive">{error}</div>
      )}
      <DataTable
        ariaLabel={`Stats of ${indexName}`}
        columns={KV_COLUMNS}
        rows={rows ?? []}
        rowKey={(r) => r.key}
        empty={rows === null ? 'Loading…' : 'No stats'}
      />
      <div className="flex h-9 shrink-0 items-center gap-2 border-t border-[var(--wb-separator)] px-2.5 text-[12px] text-[var(--wb-text-2)]">
        <span>{loadedAt ? `Live _stats · ${new Date(loadedAt).toLocaleTimeString()}` : ''}</span>
        <div className="flex-1" />
        <IconButton label="Refresh stats" onClick={() => void load()}>
          <RefreshCw />
        </IconButton>
      </div>
    </div>
  );
}
