import { Dialog, DialogOverlay, DialogPortal } from '@/components/ui/dialog';
import { type CommandId, commandAvailable, runCommand } from '@/features/keymap/commands';
import { useStructureDialogs } from '@/features/structure/structure-dialogs-store';
import { shortcut } from '@/lib/platform';
import { useSession } from '@/stores/session';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { KEYMAP, type KeyId } from '@shared/keymap';
import type { ConnectionEngine } from '@shared/protocol';
import { Command } from 'cmdk';
import {
  Bookmark,
  Boxes,
  Command as CommandIcon,
  FileCode,
  KeyRound,
  Plug,
  Search,
  Table2,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { rankItems } from './palette-rank';

interface PaletteEntry {
  id: string;
  group: string;
  label: string;
  keywords?: string[];
  /** Right-aligned secondary text (host, row count, key type). */
  meta?: string;
  /** Formatted shortcut. */
  keys?: string;
  icon: React.ReactNode;
  boost?: number;
  run: () => void | Promise<void>;
}

/** Palette commands, in the order they show with an empty query. */
const ACTIONS: ReadonlyArray<{ id: CommandId; label: string; keywords?: string[] }> = [
  { id: 'runQuery', label: 'Run query', keywords: ['execute'] },
  { id: 'runQueryAll', label: 'Run all statements', keywords: ['execute', 'script'] },
  { id: 'cancelQuery', label: 'Cancel running query', keywords: ['stop', 'abort'] },
  { id: 'newTab', label: 'New query tab', keywords: ['sql', 'editor'] },
  { id: 'closeTab', label: 'Close tab' },
  { id: 'openFile', label: 'Open SQL file…', keywords: ['load', 'import'] },
  { id: 'saveFileAs', label: 'Save SQL to file…', keywords: ['export', 'write'] },
  { id: 'commitEdits', label: 'Commit pending changes / save', keywords: ['apply', 'write'] },
  { id: 'refresh', label: 'Refresh', keywords: ['reload', 'table data'] },
  { id: 'formatSql', label: 'Beautify SQL', keywords: ['format', 'pretty'] },
  { id: 'askAi', label: 'Ask AI about this SQL', keywords: ['assistant', 'explain'] },
  { id: 'toggleAi', label: 'Toggle AI assistant', keywords: ['chat'] },
  { id: 'exportCsv', label: 'Export results as CSV', keywords: ['download'] },
  { id: 'exportJson', label: 'Export results as JSON', keywords: ['download'] },
  { id: 'history', label: 'Query history' },
  { id: 'monitor', label: 'Activity monitor', keywords: ['sessions', 'pg_stat_activity', 'locks'] },
  { id: 'codegen', label: 'Generate code…', keywords: ['codegen', 'typescript', 'types'] },
  { id: 'notebook', label: 'Notebook…' },
  { id: 'schemaDiff', label: 'Schema diff…', keywords: ['compare', 'migration'] },
  { id: 'backup', label: 'Back up database…', keywords: ['dump', 'pg_dump', 'export'] },
  { id: 'restore', label: 'Restore database…', keywords: ['pg_restore', 'import', 'backup'] },
  {
    id: 'roles',
    label: 'Roles and privileges…',
    keywords: ['users', 'grant', 'revoke', 'permissions'],
  },
  { id: 'dbSearch', label: 'Search in database…', keywords: ['find', 'grep', 'text', 'value'] },
  {
    id: 'erDiagram',
    label: 'Show diagram',
    keywords: ['er', 'erd', 'relationships', 'schema', 'foreign keys'],
  },
  { id: 'splitPane', label: 'Split pane right', keywords: ['editor', 'side by side'] },
  { id: 'closePane', label: 'Close split pane', keywords: ['editor'] },
  { id: 'nextPane', label: 'Focus next pane', keywords: ['editor', 'split'] },
  { id: 'prevPane', label: 'Focus previous pane', keywords: ['editor', 'split'] },
  { id: 'toggleEditor', label: 'Toggle query editor' },
  { id: 'toggleSidebar', label: 'Toggle sidebar' },
  { id: 'toggleRightSidebar', label: 'Toggle right sidebar', keywords: ['details'] },
  { id: 'wordWrap', label: 'Toggle word wrap', keywords: ['editor'] },
  { id: 'fontBigger', label: 'Larger editor font', keywords: ['zoom', 'size'] },
  { id: 'fontSmaller', label: 'Smaller editor font', keywords: ['zoom', 'size'] },
  { id: 'toggleTheme', label: 'Toggle dark mode', keywords: ['theme', 'light'] },
  { id: 'settings', label: 'Settings', keywords: ['preferences'] },
  { id: 'cheatSheet', label: 'Keyboard shortcuts', keywords: ['keys', 'help'] },
  { id: 'newConnection', label: 'New connection' },
  { id: 'disconnect', label: 'Disconnect' },
];

const KEY_IDS = new Set<string>(KEYMAP.map((b) => b.id));

const TABLE_LIMIT = 100;
const GROUP_ORDER = [
  'Actions',
  'Open tabs',
  'Tables',
  'Saved queries',
  'Redis keys',
  'Indexes',
  'Connections',
];

const groupClass =
  '[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground';

/**
 * Command palette — ⌘K launcher (see `@shared/keymap`) powered by `cmdk`,
 * wrapped in a Radix Dialog. We filter and rank ourselves (palette-rank)
 * so every table is searchable (H1), prefix matches win (VF23), and
 * commands are filtered by engine (K6).
 */
export function CommandPalette() {
  const open = useSession((s) => s.paletteOpen);
  const setOpen = useSession((s) => s.setPaletteOpen);
  const [query, setQuery] = useState('');
  // Every close path (Escape, click-away, running a command) starts the next
  // open with an empty search.
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
    >
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content className="fixed left-1/2 top-[15vh] z-50 w-[620px] max-w-[90vw] -translate-x-1/2 rounded-lg border bg-popover text-popover-foreground shadow-lg focus:outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 duration-200">
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Search tables, tabs, saved queries, connections, and actions
          </DialogPrimitive.Description>
          {open && <PaletteBody query={query} setQuery={setQuery} close={() => setOpen(false)} />}
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}

function PaletteBody({
  query,
  setQuery,
  close,
}: {
  query: string;
  setQuery: (q: string) => void;
  close: () => void;
}) {
  const entries = usePaletteEntries(close);
  const q = query.trim();

  const groups = useMemo(() => {
    if (q) {
      // One ranked list: the best match is first whatever its kind.
      return [
        {
          heading: 'Best matches',
          items: rankItems(q, entries, { limit: 200, limitPerGroup: { Tables: TABLE_LIMIT } }),
        },
      ];
    }
    return GROUP_ORDER.map((heading) => ({
      heading,
      items: entries
        .filter((e) => e.group === heading)
        .slice(0, heading === 'Tables' ? 50 : undefined),
    })).filter((g) => g.items.length > 0);
  }, [q, entries]);

  return (
    <Command label="Command palette" shouldFilter={false} loop>
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
        <Command.Input
          autoFocus
          value={query}
          onValueChange={setQuery}
          placeholder="Search tables, tabs, saved queries, actions…"
          className="h-8 flex-1 border-0 bg-transparent text-sm text-foreground outline-none focus:outline-none focus-visible:outline-none focus-visible:ring-0 placeholder:text-muted-foreground"
        />
      </div>

      <Command.List className="max-h-[50vh] overflow-y-auto p-2">
        <Command.Empty className="px-4 py-8 text-center text-sm text-muted-foreground">
          No matches.
        </Command.Empty>
        {groups.map((g) => (
          <Command.Group key={g.heading} heading={g.heading} className={groupClass}>
            {g.items.map((e) => (
              <PaletteItem key={e.id} entry={e} showGroup={Boolean(q)} />
            ))}
          </Command.Group>
        ))}
      </Command.List>
    </Command>
  );
}

function usePaletteEntries(close: () => void): PaletteEntry[] {
  const connectionState = useSession((s) => s.connectionState);
  const engine = useSession((s) =>
    s.connectionState === 'connected'
      ? ((s.activeConfig?.engine ?? 'postgres') as ConnectionEngine)
      : null,
  );
  const activeConfigId = useSession((s) => s.activeConfig?.id);
  const tables = useSession((s) => s.schema?.tables);
  const savedConnections = useSession((s) => s.savedConnections);
  const savedQueries = useSession((s) =>
    s.activeConfig?.id ? s.settings.savedQueries?.[s.activeConfig.id] : undefined,
  );
  const tabs = useSession((s) => s.tabs);
  const redisKeys = useSession((s) => s.redisKeys?.keys);
  const osIndices = useSession((s) => s.osOverview?.indices);

  return useMemo(() => {
    const s = useSession.getState;
    const act = (fn: () => void | Promise<void>) => () => {
      close();
      void fn();
    };
    const connected = connectionState === 'connected';
    const out: PaletteEntry[] = [];

    for (const a of ACTIONS) {
      if (!commandAvailable(a.id, engine, connected)) continue;
      out.push({
        id: `action:${a.id}`,
        group: 'Actions',
        label: a.label,
        keywords: a.keywords,
        keys: KEY_IDS.has(a.id) ? shortcut(a.id as KeyId) : undefined,
        icon: <CommandIcon className="h-3.5 w-3.5" />,
        boost: 2,
        run: act(() => {
          runCommand(a.id);
        }),
      });
    }

    if (connected && engine === 'postgres' && !useSession.getState().activeConfig?.readOnly) {
      const schemaName = () =>
        useSession.getState().currentSchema ??
        useSession.getState().schema?.schemas[0]?.name ??
        'public';
      for (const [id, label, keywords, open] of [
        [
          'newTable',
          'New table…',
          ['create', 'create table', 'structure'],
          () => useStructureDialogs.getState().openCreateTable(schemaName()),
        ],
        [
          'newView',
          'New view…',
          ['create', 'create view', 'materialized'],
          () => useStructureDialogs.getState().openCreateView(schemaName()),
        ],
        [
          'importData',
          'Import into table…',
          ['csv', 'tsv', 'json', 'ndjson', 'sql', 'load', 'file'],
          () => useStructureDialogs.getState().openImport(schemaName(), null),
        ],
      ] as const) {
        out.push({
          id: `action:${id}`,
          group: 'Actions',
          label,
          keywords: [...keywords],
          icon: <CommandIcon className="h-3.5 w-3.5" />,
          boost: 2,
          run: act(open),
        });
      }
    }

    if (connected) {
      const overview = engine !== 'postgres' ? tabs.find((t) => t.kind === 'sql')?.id : undefined;
      tabs.forEach((t, i) => {
        if (engine !== 'postgres' && t.kind === 'sql' && t.id !== overview) return;
        out.push({
          id: `tab:${t.id}`,
          group: 'Open tabs',
          label: t.id === overview ? 'Overview' : t.title,
          keywords: t.tableSchema && t.tableName ? [`${t.tableSchema}.${t.tableName}`] : undefined,
          keys: i < 8 ? shortcut('selectTab').replace(/1$/, String(i + 1)) : undefined,
          icon: <FileCode className="h-3.5 w-3.5" />,
          boost: 1,
          run: act(() => s().setActiveTab(t.id)),
        });
      });
    }

    if (connected && engine === 'postgres') {
      for (const t of tables ?? []) {
        const qualified = `${t.schema}.${t.name}`;
        out.push({
          id: `table:${qualified}`,
          group: 'Tables',
          label: t.schema === 'public' ? t.name : qualified,
          keywords: [qualified, t.name],
          meta:
            t.rowCountEstimate !== null && t.rowCountEstimate >= 0
              ? `${formatK(t.rowCountEstimate)} rows`
              : undefined,
          icon: <Table2 className="h-3.5 w-3.5" />,
          // An explicit pick from the palette keeps the tab (not a preview).
          run: act(() => s().openTable(t.schema, t.name, { preview: false })),
        });
      }
      for (const q of savedQueries ?? []) {
        out.push({
          id: `saved:${q.id}`,
          group: 'Saved queries',
          label: q.name,
          meta: q.kind === 'table' ? `${q.tableSchema}.${q.tableName}` : 'SQL',
          icon: <Bookmark className="h-3.5 w-3.5" />,
          run: act(() => s().openSavedQuery(q.id)),
        });
      }
    }

    if (connected && engine === 'redis') {
      for (const k of (redisKeys ?? []).slice(0, 5000)) {
        out.push({
          id: `redis:${k.key}`,
          group: 'Redis keys',
          label: k.key,
          meta: k.type,
          icon: <KeyRound className="h-3.5 w-3.5" />,
          run: act(() => s().openRedisKey(k.key)),
        });
      }
    }

    if (connected && engine === 'opensearch') {
      for (const idx of osIndices ?? []) {
        out.push({
          id: `index:${idx.index}`,
          group: 'Indexes',
          label: idx.index,
          meta: `${formatK(idx.docsCount)} docs`,
          icon: <Boxes className="h-3.5 w-3.5" />,
          run: act(() => s().openOsIndex(idx.index)),
        });
      }
    }

    for (const c of savedConnections) {
      const active = c.id === activeConfigId && connected;
      out.push({
        id: `conn:${c.id}`,
        group: 'Connections',
        label: c.name,
        keywords: [c.host ?? '', c.database ?? ''],
        meta: active
          ? 'connected'
          : [c.host, c.port].filter(Boolean).join(':') + (c.database ? `/${c.database}` : ''),
        icon: <Plug className="h-3.5 w-3.5" />,
        run: act(() => (active ? undefined : s().connectSaved(c.id))),
      });
    }
    return out;
  }, [
    close,
    connectionState,
    engine,
    activeConfigId,
    tables,
    savedConnections,
    savedQueries,
    tabs,
    redisKeys,
    osIndices,
  ]);
}

function PaletteItem({ entry, showGroup }: { entry: PaletteEntry; showGroup: boolean }) {
  const meta =
    showGroup && entry.group !== 'Actions'
      ? [groupLabel(entry.group), entry.meta].filter(Boolean).join(' · ')
      : entry.meta;
  return (
    <Command.Item
      value={entry.id}
      onSelect={entry.run}
      className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm text-foreground transition-colors aria-selected:bg-[var(--wb-selected)] data-[selected=true]:bg-[var(--wb-selected)]"
    >
      <span className="shrink-0 text-muted-foreground">{entry.icon}</span>
      <span className="min-w-0 flex-1 truncate">{entry.label}</span>
      {meta && <span className="ml-3 shrink-0 truncate text-xs text-muted-foreground">{meta}</span>}
      {entry.keys && (
        <span className="ml-3 shrink-0 text-xs text-muted-foreground">{entry.keys}</span>
      )}
    </Command.Item>
  );
}

function groupLabel(group: string): string {
  if (group === 'Open tabs') return 'tab';
  if (group === 'Tables') return 'table';
  if (group === 'Saved queries') return 'saved query';
  if (group === 'Redis keys') return 'key';
  if (group === 'Indexes') return 'index';
  if (group === 'Connections') return 'connection';
  return group;
}

function formatK(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(0)}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
}
