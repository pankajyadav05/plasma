import { type DataColumn, DataTable } from '@/components/ui/data-table';
import {
  Badge,
  EmptyState,
  SectionHeading,
  StatTile,
  ViewFooter,
  ViewToolbar,
} from '@/components/ui/view-parts';
import { IconButton, Pill } from '@/components/ui/workbench';
import { cleanIpcError } from '@/lib/errors';
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import { useWorkbench } from '@/stores/workbench';
import type { ColumnMeta, OsIndex, OsMappingNode } from '@shared/protocol';
import { Loader2, RefreshCw, Search, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function healthTone(health: string): 'neutral' | 'warn' | 'danger' {
  const h = health.toLowerCase();
  if (h === 'red') return 'danger';
  if (h === 'yellow') return 'warn';
  return 'neutral';
}

/** One mapping field, flattened to a dot path (`address.geo.lat`). */
interface FieldRow {
  path: string;
  type: string | null;
  depth: number;
  /** Direct sub-properties (object / nested fields). */
  properties: number;
}

function flattenMapping(nodes: OsMappingNode[], prefix = '', depth = 0): FieldRow[] {
  const out: FieldRow[] = [];
  for (const n of nodes) {
    const path = prefix ? `${prefix}.${n.name}` : n.name;
    out.push({ path, type: n.type, depth, properties: n.children.length });
    if (n.children.length > 0) out.push(...flattenMapping(n.children, path, depth + 1));
  }
  return out;
}

const INSPECT_COLUMNS: ColumnMeta[] = [
  { name: 'field', dataTypeID: 0, dataTypeName: 'path' },
  { name: 'type', dataTypeID: 0, dataTypeName: 'mapping type' },
  { name: 'depth', dataTypeID: 0, dataTypeName: 'int' },
  { name: 'properties', dataTypeID: 0, dataTypeName: 'int' },
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
    render: (r) => (r.type ? <Badge>{r.type}</Badge> : null),
  },
  {
    key: 'depth',
    label: 'Depth',
    title: 'Nesting level (0 = top-level field)',
    align: 'right',
    width: 70,
    render: (r) => r.depth,
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

/**
 * Mapping + stats view for one OpenSearch index. The mapping is fetched
 * lazily; index stats are read from the cached cluster overview to keep
 * the canvas snappy. Selecting a mapping row publishes it to the right
 * sidebar's Details pane.
 */
export function OsIndexView({ tabId, indexName }: { tabId: string; indexName: string }) {
  const overview = useSession((s) => s.osOverview);
  const openSearch = useSession((s) => s.openOsSearch);
  const requestDelete = useSession((s) => s.requestOsDeleteIndex);
  const setInspectedRow = useWorkbench((s) => s.setInspectedRow);

  const [mapping, setMapping] = useState<OsMappingNode | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  const stats: OsIndex | undefined = overview?.indices.find((i) => i.index === indexName);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const root = await ipc.os.mapping(indexName);
      setMapping(root);
    } catch (err) {
      setError(cleanIpcError(err instanceof Error ? err.message : String(err)));
    } finally {
      setLoading(false);
    }
  }, [indexName]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => (mapping ? flattenMapping(mapping.children) : []), [mapping]);
  const objectCount = useMemo(() => rows.filter((r) => r.properties > 0).length, [rows]);

  // Selection is per-mapping: reset (and clear Details) when it reloads.
  // biome-ignore lint/correctness/useExhaustiveDependencies: rows identity is the trigger
  useEffect(() => {
    setSelected(null);
    setInspectedRow(null);
  }, [rows, setInspectedRow]);

  // Clear the Details pane when leaving the view.
  useEffect(() => () => setInspectedRow(null), [setInspectedRow]);

  const select = useCallback(
    (row: FieldRow, index: number) => {
      setSelected(index);
      setInspectedRow({
        tabId,
        rowNumber: index + 1,
        columnIndex: 0,
        columns: INSPECT_COLUMNS,
        row: [row.path, row.type, row.depth, row.properties],
      });
    },
    [tabId, setInspectedRow],
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--wb-content)]">
      <ViewToolbar>
        <span className="truncate font-mono font-semibold text-[var(--wb-text)]">{indexName}</span>
        {stats && <Badge tone={healthTone(stats.health)}>{stats.health}</Badge>}
        {stats && (
          <span className="truncate text-[12px] text-[var(--wb-text-2)]">
            {stats.docsCount.toLocaleString()} docs · {fmtBytes(stats.storeBytes)}
          </span>
        )}
        <div className="flex-1" />
        <Pill onClick={() => openSearch(indexName)}>
          <Search />
          Search
        </Pill>
        <Pill
          onClick={() => requestDelete(indexName)}
          aria-label={`Delete index ${indexName}`}
          className="text-destructive hover:text-destructive"
        >
          <Trash2 />
          Delete
        </Pill>
      </ViewToolbar>

      {error && (
        <div className="shrink-0 border-b border-[var(--wb-separator)] bg-[color-mix(in_srgb,var(--destructive)_14%,transparent)] px-3 py-1.5 font-mono text-[12px] text-[var(--wb-text)]">
          {error.replace(/^Error invoking remote method '[^']+':\s*/i, '')}
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
            hint={mapping && objectCount > 0 ? `${objectCount} object` : undefined}
          />
        </div>
      )}

      <SectionHeading>Mapping</SectionHeading>

      {loading && !mapping ? (
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
      )}

      <ViewFooter>
        <span>
          {rows.length.toLocaleString()} {rows.length === 1 ? 'field' : 'fields'}
          {objectCount > 0 && ` · ${objectCount} ${objectCount === 1 ? 'object' : 'objects'}`}
        </span>
        <div className="flex-1" />
        <IconButton label="Refresh mapping" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        </IconButton>
      </ViewFooter>
    </div>
  );
}
