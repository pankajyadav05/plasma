import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { IconButton, Pill } from '@/components/ui/workbench';
import { computeRowWindow } from '@/features/result-grid/windowed-rows';
import { useStructureDialogs } from '@/features/structure/structure-dialogs-store';
import { cn } from '@/lib/cn';
import { cleanIpcError } from '@/lib/errors';
import { ipc } from '@/lib/ipc';
import { type EntityKind, useSession } from '@/stores/session';
import { defaultSchemaName } from '@/stores/session-schema';
import type { SchemaInfo } from '@shared/protocol';
import {
  Blocks,
  Braces,
  ChevronRight,
  Copy,
  Download,
  Eraser,
  Eye,
  FileCode2,
  FileUp,
  Folder,
  FunctionSquare,
  GitBranch,
  Globe,
  Hash,
  Layers,
  Network,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  SquareArrowOutUpRight,
  Star,
  Table2,
  TableProperties,
  Trash2,
  Workflow,
} from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { DestructiveObjectDialog, type DestructiveRequest } from './DestructiveObjectDialog';
import { type ContextMenuState, type MenuEntry, SidebarContextMenu } from './SidebarContextMenu';
import { type TreeRow, buildEntityRows, rowName, treeKeyAction } from './entity-tree';
import {
  extensionDdl,
  loadRelationCreateScript,
  loadRoutineDefinition,
  loadSequenceDdl,
  loadTypeDdl,
} from './object-ddl';
import {
  type DropTarget,
  buildDropScript,
  buildInsertScript,
  buildSelectScript,
  buildTruncateScript,
  qualified,
} from './object-scripts';
import { SidebarSearch, SidebarSearchRow, sidebarRowClass } from './sidebar-parts';

type Table = SchemaInfo['tables'][number];

/** "New table…", "New view…" and "Import…" entries for a schema (blank-area menu and the + button). */
function creationEntries(schemaName: string): MenuEntry[] {
  const dialogs = useStructureDialogs.getState;
  const readOnly = Boolean(useSession.getState().activeConfig?.readOnly);
  const hint = readOnly ? 'read-only' : undefined;
  return [
    {
      type: 'item',
      label: 'New table…',
      icon: <Table2 />,
      disabled: readOnly,
      hint,
      onSelect: () => dialogs().openCreateTable(schemaName),
    },
    {
      type: 'item',
      label: 'New view…',
      icon: <Eye />,
      disabled: readOnly,
      hint,
      onSelect: () => dialogs().openCreateView(schemaName),
    },
    {
      type: 'item',
      label: 'Import…',
      icon: <FileUp />,
      disabled: readOnly,
      hint,
      onSelect: () => dialogs().openImport(schemaName, null),
    },
  ];
}

const ROW_PX = 24;
/** Vertical padding above/below the rows inside the scroller (py-1). */
const PAD_PX = 4;

/**
 * Items-mode sidebar content: the current schema's relations (favourites
 * first, partitions nested under their parent) followed by collapsible
 * Functions / Procedures / Sequences / Types / Extensions sections.
 *
 * An ARIA tree (DESIGN.md §9): the scroller holds focus and tracks the
 * active row with aria-activedescendant, so ↑/↓/←/→/Home/End/Enter and
 * type-ahead work without a tab stop per row. Rows are windowed (PF15)
 * and every row has a right-click menu (PC3) — also on Shift+F10 / the
 * Menu key.
 */
export function EntityList() {
  const activeConfig = useSession((s) => s.activeConfig);
  const schema = useSession((s) => s.schema);
  const schemaLoading = useSession((s) => s.schemaLoading);
  const schemaError = useSession((s) => s.schemaError as string | null);
  const currentSchema = useSession((s) => s.currentSchema);
  const entityFilter = useSession((s) => s.entityFilter);
  const toggleEntityFilter = useSession((s) => s.toggleEntityFilter);
  const activeTable = useSession((s) => s.activeTable);
  const favoriteTables = useSession((s) => s.settings.favoriteTables);
  const refreshSchema = useSession((s) => s.refreshSchema);

  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [focusIndex, setFocusIndex] = useState(-1);
  const [treeFocused, setTreeFocused] = useState(false);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [destructive, setDestructive] = useState<DestructiveRequest | null>(null);
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);

  const treeRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  const baseId = useId();

  const connId = activeConfig?.id;
  // PC1: depends on the favourites themselves, so starring re-sorts at once.
  const favorites = useMemo(
    () => new Set(connId ? (favoriteTables?.[connId] ?? []) : []),
    [connId, favoriteTables],
  );

  const effectiveSchema = currentSchema ?? defaultSchemaName(schema);

  const rows = useMemo(
    () =>
      schema && effectiveSchema
        ? buildEntityRows({
            schema,
            currentSchema: effectiveSchema,
            filter: entityFilter as Set<string>,
            search,
            favorites,
            expanded,
          })
        : [],
    [schema, effectiveSchema, entityFilter, search, favorites, expanded],
  );

  // Keep the focused index inside the list as it shrinks / grows.
  useEffect(() => {
    if (focusIndex >= rows.length) setFocusIndex(rows.length - 1);
  }, [rows.length, focusIndex]);

  // A new schema or search starts at the top.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on schema / search change only
  useEffect(() => {
    setFocusIndex(-1);
    if (treeRef.current) treeRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [effectiveSchema, search]);

  useEffect(() => {
    if (!status) return;
    const t = window.setTimeout(() => setStatus(null), status.error ? 6000 : 2500);
    return () => window.clearTimeout(t);
  }, [status]);

  // Track the scroller's height for windowing.
  useLayoutEffect(() => {
    const el = treeRef.current;
    if (!el) return;
    setViewport(el.clientHeight);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setViewport(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  });

  const scrollRowIntoView = useCallback(
    (index: number) => {
      const el = treeRef.current;
      if (!el || index < 0) return;
      const top = PAD_PX + index * ROW_PX;
      const height = el.clientHeight || viewport;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + ROW_PX > el.scrollTop + height) el.scrollTop = top + ROW_PX - height;
    },
    [viewport],
  );

  const toggleExpanded = useCallback((key: string, open?: boolean) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      const want = open ?? !next.has(key);
      if (want) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const actions = useEntityActions({ setStatus, setDestructive });

  const activate = useCallback(
    (row: TreeRow) => {
      switch (row.type) {
        case 'relation':
          actions.openRelation(row.table);
          return;
        case 'section':
          toggleExpanded(row.key);
          return;
        default:
          actions.openDefinition(row);
      }
    },
    [actions, toggleExpanded],
  );

  const openMenuFor = useCallback(
    (row: TreeRow, x: number, y: number) => {
      const entries = actions.menuFor(row, {
        favorite: row.type === 'relation' && row.favorite,
        toggleSection: () => toggleExpanded(row.key),
      });
      if (entries.length > 0) setMenu({ x, y, entries });
    },
    [actions, toggleExpanded],
  );

  const onTreeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (rows.length === 0) return;
    const index = focusIndex < 0 ? 0 : focusIndex;
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault();
      const row = rows[index];
      const el = document.getElementById(`${baseId}-row-${index}`);
      const rect = el?.getBoundingClientRect() ?? treeRef.current?.getBoundingClientRect();
      if (row && rect) openMenuFor(row, rect.left + 24, rect.bottom);
      return;
    }
    if (focusIndex < 0 && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      const start = e.key === 'End' || e.key === 'ArrowUp' ? rows.length - 1 : 0;
      setFocusIndex(start);
      scrollRowIntoView(start);
      return;
    }
    const action = treeKeyAction(rows, index, e.key);
    if (action) {
      e.preventDefault();
      if (action.kind === 'focus') {
        setFocusIndex(action.index);
        scrollRowIntoView(action.index);
      } else if (action.kind === 'expand') toggleExpanded(action.key, true);
      else if (action.kind === 'collapse') toggleExpanded(action.key, false);
      else if (action.kind === 'activate') {
        const row = rows[action.index];
        if (row) activate(row);
      }
      return;
    }
    // Type-ahead: jump to the next row starting with the typed character.
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && /\S/.test(e.key)) {
      const ch = e.key.toLowerCase();
      for (let step = 1; step <= rows.length; step++) {
        const i = (index + step) % rows.length;
        const row = rows[i];
        if (row && rowName(row).toLowerCase().startsWith(ch)) {
          e.preventDefault();
          setFocusIndex(i);
          scrollRowIntoView(i);
          break;
        }
      }
    }
  };

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && rows.length > 0) {
      e.preventDefault();
      setFocusIndex(0);
      scrollRowIntoView(0);
      treeRef.current?.focus();
    } else if (e.key === 'Enter' && rows[0]) {
      e.preventDefault();
      activate(rows[0]);
    }
  };

  if (!activeConfig) {
    return (
      <div className="px-4 py-3 text-[13px] text-[var(--wb-text-2)]">
        connect to browse the schema
      </div>
    );
  }

  if (!schema && schemaLoading) {
    return <div className="px-4 py-3 text-[13px] text-[var(--wb-text-2)]">loading…</div>;
  }
  if (!schema) {
    return (
      <div className="px-4 py-3">
        {schemaError ? (
          <>
            <div className="text-[13px] text-destructive">Could not load the schema</div>
            <div className="mt-1 break-words text-[11px] text-[var(--wb-text-2)]">
              {schemaError}
            </div>
            <Pill className="mt-2" onClick={() => void refreshSchema()}>
              <RefreshCw />
              Retry
            </Pill>
          </>
        ) : (
          <div className="text-[13px] text-[var(--wb-text-2)]">no schema</div>
        )}
      </div>
    );
  }

  const win = computeRowWindow(
    rows.length,
    scrollTop - PAD_PX,
    viewport > 0 ? viewport : 600,
    ROW_PX,
    10,
  );
  const activeDescendant =
    focusIndex >= 0 && focusIndex < rows.length ? `${baseId}-row-${focusIndex}` : undefined;

  return (
    <div className="flex h-full flex-col">
      {/* Schema picker lives in the topbar — don't duplicate it here. */}
      <SidebarSearchRow>
        <SidebarSearch
          value={search}
          onChange={setSearch}
          placeholder="Search for item…"
          ariaLabel="Search tables"
          onKeyDown={onSearchKeyDown}
          inputRef={searchRef}
        />
        <IconButton
          label="New table, view or import"
          disabled={Boolean(activeConfig?.readOnly)}
          title={activeConfig?.readOnly ? 'Read-only connection' : 'New table, view or import'}
          data-testid="sidebar-new-object"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({
              x: r.left,
              y: r.bottom + 4,
              entries: creationEntries(effectiveSchema ?? 'public'),
            });
          }}
        >
          <Plus />
        </IconButton>
        <EntityFilterMenu entityFilter={entityFilter} toggle={toggleEntityFilter} />
      </SidebarSearchRow>

      {/* ── Entity tree (ARIA tree — DESIGN.md §9 / U38) ── */}
      <div
        ref={treeRef}
        className="min-h-0 flex-1 overflow-y-auto outline-none"
        role="tree"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a tree is a composite widget; it holds focus and drives aria-activedescendant
        tabIndex={0}
        aria-label={effectiveSchema ? `Tables in ${effectiveSchema}` : 'Tables'}
        aria-activedescendant={activeDescendant}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onKeyDown={onTreeKeyDown}
        onFocus={(e) => {
          if (e.target === e.currentTarget) setTreeFocused(true);
        }}
        onBlur={() => setTreeFocused(false)}
        onContextMenu={(e) => {
          // Blank area (the schema): new table / view / import, refresh.
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          setMenu({
            x: e.clientX,
            y: e.clientY,
            entries: [
              ...creationEntries(effectiveSchema ?? 'public'),
              { type: 'separator' },
              {
                type: 'item',
                label: 'Show diagram',
                icon: <Network />,
                onSelect: () =>
                  useSession.getState().openErDiagram({ schema: effectiveSchema ?? 'public' }),
              },
              {
                type: 'item',
                label: 'Refresh',
                icon: <RefreshCw />,
                onSelect: () => void refreshSchema(),
              },
            ],
          });
        }}
      >
        {rows.length === 0 ? (
          <div className="px-4 py-3 text-[13px] text-[var(--wb-text-2)]">
            {search ? `no entities match "${search}"` : 'empty'}
          </div>
        ) : (
          <>
            <div style={{ height: win.topPadPx + PAD_PX }} aria-hidden />
            {rows.slice(win.start, win.end).map((row, i) => {
              const index = win.start + i;
              return (
                <TreeRowView
                  key={row.key}
                  id={`${baseId}-row-${index}`}
                  row={row}
                  active={
                    row.type === 'relation' &&
                    activeTable?.schema === row.table.schema &&
                    activeTable?.name === row.table.name
                  }
                  focused={treeFocused && index === focusIndex}
                  onActivate={() => {
                    setFocusIndex(index);
                    activate(row);
                  }}
                  onToggleExpand={() => toggleExpanded(row.key)}
                  onToggleFavorite={() => {
                    if (row.type === 'relation') actions.toggleFavorite(row.table);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setFocusIndex(index);
                    openMenuFor(row, e.clientX, e.clientY);
                  }}
                />
              );
            })}
            <div style={{ height: win.bottomPadPx + PAD_PX }} aria-hidden />
          </>
        )}
      </div>

      {(status || (schemaError && schema)) && (
        <output
          className={cn(
            'block shrink-0 truncate border-t border-[var(--wb-separator)] px-3 py-1 text-[11px]',
            (status ? status.error : true) ? 'text-destructive' : 'text-[var(--wb-text-2)]',
          )}
          title={status?.text ?? schemaError ?? undefined}
        >
          {status?.text ?? `Refresh failed: ${schemaError}`}
        </output>
      )}

      <SidebarContextMenu state={menu} onClose={() => setMenu(null)} />
      <DestructiveObjectDialog
        request={destructive}
        onCancel={() => setDestructive(null)}
        onConfirm={(sql) => {
          const req = destructive;
          setDestructive(null);
          if (req) actions.runWrite(sql, `${req.verb.toLowerCase()} ${req.target}`);
        }}
      />
    </div>
  );
}

// ─── actions ─────────────────────────────────────────────────────────

type ObjectRow = Exclude<TreeRow, { type: 'relation' } | { type: 'section' }>;

/**
 * Everything the rows and their context menus can do. Writes (truncate /
 * drop) open a SQL tab and go through `runQuery`, which owns the
 * prod-tag confirmation; they are refused on read-only connections.
 */
function useEntityActions({
  setStatus,
  setDestructive,
}: {
  setStatus: (s: { text: string; error?: boolean } | null) => void;
  setDestructive: (r: DestructiveRequest | null) => void;
}) {
  const activeConfig = useSession((s) => s.activeConfig);
  const readOnly = Boolean(activeConfig?.readOnly);

  return useMemo(() => {
    const session = () => useSession.getState();
    const fail = (err: unknown) =>
      setStatus({
        text: cleanIpcError(err instanceof Error ? err.message : String(err)),
        error: true,
      });

    const copy = async (text: string, what: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setStatus({ text: `Copied ${what}` });
      } catch (err) {
        fail(err);
      }
    };

    const openSqlTab = (title: string, sql: string) => {
      const s = session();
      s.addTab();
      s.setSql(sql);
      s.renameActiveTab(title);
      s.setEditorExpanded?.(true);
    };

    const openRelation = (t: Table, opts?: { newTab?: boolean; structure?: boolean }) => {
      const s = session();
      s.openTable(t.schema, t.name, opts?.newTab ? { newTab: true } : undefined);
      if (opts?.structure) s.setTabViewMode('structure');
    };

    const openDefinition = async (row: ObjectRow) => {
      try {
        const ddl = await definitionOf(row);
        openSqlTab(`${rowName(row)}.sql`, ddl);
      } catch (err) {
        fail(err);
      }
    };

    const columnsOf = async (t: Table) => {
      await session().ensureSchemaColumns(t.schema);
      const info: SchemaInfo | null = session().schema;
      return (info?.columns ?? [])
        .filter((c) => c.schema === t.schema && c.table === t.name)
        .sort((a, b) => a.ordinal - b.ordinal);
    };

    const runWrite = (sql: string, title: string) => {
      if (session().activeConfig?.readOnly) {
        setStatus({ text: 'This connection is read-only', error: true });
        return;
      }
      openSqlTab(`${title}.sql`, sql);
      // Runs the whole buffer through the normal path: history, result
      // pane, prod-tag confirmation and the DDL-triggered schema refresh.
      void session().runQuery({ mode: 'buffer' });
    };

    const exportRelation = async (t: Table, format: 'csv' | 'json') => {
      try {
        const res = await ipc.export.save({
          format,
          defaultPath: t.name,
          columns: [],
          sql: `SELECT * FROM ${qualified(t.schema, t.name)}`,
        });
        if (res.ok) {
          setStatus({ text: `Exported ${res.rowCount.toLocaleString()} rows to ${res.filePath}` });
        }
      } catch (err) {
        fail(err);
      }
    };

    const toggleFavorite = (t: Table) => {
      const id = session().activeConfig?.id;
      if (id) void session().toggleFavoriteTable(id, t.schema, t.name);
    };

    const writeHint = readOnly ? 'read-only' : undefined;

    const dropEntries = (target: DropTarget, label: string): MenuEntry[] => [
      {
        type: 'item',
        label: 'Drop…',
        icon: <Trash2 />,
        destructive: true,
        disabled: readOnly,
        hint: writeHint,
        onSelect: () =>
          setDestructive({
            verb: 'Drop',
            target: label,
            build: ({ cascade }) => buildDropScript(target, { cascade }),
          }),
      },
    ];

    const refreshEntry: MenuEntry = {
      type: 'item',
      label: 'Refresh',
      icon: <RefreshCw />,
      onSelect: () => void session().refreshSchema(),
    };

    const menuFor = (
      row: TreeRow,
      ctx: { favorite: boolean; toggleSection: () => void },
    ): MenuEntry[] => {
      if (row.type === 'section') {
        return [
          {
            type: 'item',
            label: row.expanded ? 'Collapse' : 'Expand',
            icon: <ChevronRight />,
            onSelect: ctx.toggleSection,
          },
          { type: 'separator' },
          refreshEntry,
        ];
      }
      if (row.type === 'relation') {
        const t = row.table;
        const qn = qualified(t.schema, t.name);
        const isView = t.kind === 'view' || t.kind === 'matview';
        const entries: MenuEntry[] = [
          { type: 'item', label: 'Open', icon: <Table2 />, onSelect: () => openRelation(t) },
          {
            type: 'item',
            label: 'Open in new tab',
            icon: <SquareArrowOutUpRight />,
            onSelect: () => openRelation(t, { newTab: true }),
          },
          {
            type: 'item',
            label: 'Open structure',
            icon: <TableProperties />,
            onSelect: () => openRelation(t, { structure: true }),
          },
          {
            type: 'item',
            label: 'Show diagram',
            icon: <Network />,
            onSelect: () => {
              // This table plus the tables it references / is referenced by.
              const ids = new Set([`${t.schema}.${t.name}`]);
              for (const fk of session().schema?.foreignKeys ?? []) {
                if (fk.schema === t.schema && fk.table === t.name)
                  ids.add(`${fk.refSchema}.${fk.refTable}`);
                if (fk.refSchema === t.schema && fk.refTable === t.name)
                  ids.add(`${fk.schema}.${fk.table}`);
              }
              useSession.getState().openErDiagram({ schema: t.schema, tables: [...ids] });
            },
          },
          {
            type: 'item',
            label: ctx.favorite ? 'Remove from favourites' : 'Add to favourites',
            icon: <Star />,
            onSelect: () => toggleFavorite(t),
          },
          { type: 'separator' },
          {
            type: 'item',
            label: 'Copy name',
            icon: <Copy />,
            onSelect: () => void copy(t.name, 'name'),
          },
          {
            type: 'item',
            label: 'Copy qualified name',
            icon: <Copy />,
            onSelect: () => void copy(qn, 'qualified name'),
          },
          { type: 'label', label: 'Copy script as' },
          {
            type: 'item',
            label: 'CREATE',
            icon: <FileCode2 />,
            onSelect: async () => {
              try {
                await copy(
                  await loadRelationCreateScript(t.schema, t.name, t.kind),
                  'CREATE script',
                );
              } catch (err) {
                fail(err);
              }
            },
          },
          {
            type: 'item',
            label: 'SELECT',
            icon: <FileCode2 />,
            onSelect: async () => {
              const cols = await columnsOf(t);
              await copy(
                buildSelectScript(
                  t.schema,
                  t.name,
                  cols.map((c) => c.name),
                ),
                'SELECT script',
              );
            },
          },
          ...(!isView
            ? ([
                {
                  type: 'item',
                  label: 'INSERT',
                  icon: <FileCode2 />,
                  onSelect: async () => {
                    const cols = await columnsOf(t);
                    await copy(buildInsertScript(t.schema, t.name, cols), 'INSERT script');
                  },
                },
                {
                  type: 'item',
                  label: 'TRUNCATE',
                  icon: <FileCode2 />,
                  onSelect: () =>
                    void copy(buildTruncateScript(t.schema, t.name), 'TRUNCATE script'),
                },
              ] as MenuEntry[])
            : []),
          {
            type: 'item',
            label: 'DROP',
            icon: <FileCode2 />,
            onSelect: () =>
              void copy(
                buildDropScript({ kind: t.kind, schema: t.schema, name: t.name }),
                'DROP script',
              ),
          },
          { type: 'separator' },
          ...(!isView
            ? ([
                {
                  type: 'item',
                  label: 'Import…',
                  icon: <FileUp />,
                  disabled: readOnly,
                  hint: writeHint,
                  onSelect: () => useStructureDialogs.getState().openImport(t.schema, t.name),
                },
              ] as MenuEntry[])
            : []),
          {
            type: 'item',
            label: 'Export as CSV…',
            icon: <Download />,
            onSelect: () => void exportRelation(t, 'csv'),
          },
          {
            type: 'item',
            label: 'Export as JSON…',
            icon: <Download />,
            onSelect: () => void exportRelation(t, 'json'),
          },
          { type: 'separator' },
          ...(!isView
            ? ([
                {
                  type: 'item',
                  label: 'Truncate…',
                  icon: <Eraser />,
                  destructive: true,
                  disabled: readOnly,
                  hint: writeHint,
                  onSelect: () =>
                    setDestructive({
                      verb: 'Truncate',
                      target: qn,
                      detail:
                        'Every row is deleted; the table itself stays. This cannot be undone.',
                      build: ({ cascade }) => buildTruncateScript(t.schema, t.name, { cascade }),
                    }),
                },
              ] as MenuEntry[])
            : []),
          ...dropEntries({ kind: t.kind, schema: t.schema, name: t.name }, qn),
          { type: 'separator' },
          refreshEntry,
        ];
        return entries;
      }

      // Functions, procedures, sequences, types, extensions.
      const { name, qn, target } = objectIdentity(row);
      return [
        {
          type: 'item',
          label: 'Open definition',
          icon: <FileCode2 />,
          onSelect: () => void openDefinition(row),
        },
        { type: 'separator' },
        {
          type: 'item',
          label: 'Copy name',
          icon: <Copy />,
          onSelect: () => void copy(name, 'name'),
        },
        ...(qn !== name
          ? ([
              {
                type: 'item',
                label: 'Copy qualified name',
                icon: <Copy />,
                onSelect: () => void copy(qn, 'qualified name'),
              },
            ] as MenuEntry[])
          : []),
        { type: 'label', label: 'Copy script as' },
        {
          type: 'item',
          label: 'CREATE',
          icon: <FileCode2 />,
          onSelect: async () => {
            try {
              await copy(await definitionOf(row), 'CREATE script');
            } catch (err) {
              fail(err);
            }
          },
        },
        {
          type: 'item',
          label: 'DROP',
          icon: <FileCode2 />,
          onSelect: () => void copy(buildDropScript(target), 'DROP script'),
        },
        { type: 'separator' },
        ...dropEntries(target, qn),
        { type: 'separator' },
        refreshEntry,
      ];
    };

    return {
      openRelation,
      openDefinition,
      toggleFavorite,
      runWrite,
      menuFor,
    };
  }, [readOnly, setStatus, setDestructive]);
}

function definitionOf(row: ObjectRow): Promise<string> {
  switch (row.type) {
    case 'routine':
      return loadRoutineDefinition(row.routine);
    case 'sequence':
      return loadSequenceDdl(row.sequence.schema, row.sequence.name);
    case 'type':
      return loadTypeDdl(row.typeInfo);
    case 'extension':
      return Promise.resolve(extensionDdl(row.extension));
  }
}

function objectIdentity(row: ObjectRow): { name: string; qn: string; target: DropTarget } {
  switch (row.type) {
    case 'routine': {
      const r = row.routine;
      return {
        name: r.name,
        qn: `${qualified(r.schema, r.name)}(${r.args})`,
        target: { kind: r.kind, schema: r.schema, name: r.name, args: r.args },
      };
    }
    case 'sequence':
      return {
        name: row.sequence.name,
        qn: qualified(row.sequence.schema, row.sequence.name),
        target: { kind: 'sequence', schema: row.sequence.schema, name: row.sequence.name },
      };
    case 'type':
      return {
        name: row.typeInfo.name,
        qn: qualified(row.typeInfo.schema, row.typeInfo.name),
        target: {
          kind: 'type',
          schema: row.typeInfo.schema,
          name: row.typeInfo.name,
          typeKind: row.typeInfo.kind,
        },
      };
    case 'extension':
      return {
        name: row.extension.name,
        qn: row.extension.name,
        target: { kind: 'extension', name: row.extension.name },
      };
  }
}

// ─── filter menu ─────────────────────────────────────────────────────

const ENTITY_KIND_LABELS: Record<EntityKind, string> = {
  table: 'Table',
  view: 'View',
  matview: 'Materialized View',
  foreign: 'Foreign Table',
  partitioned: 'Partitioned Table',
  function: 'Function',
  procedure: 'Procedure',
  sequence: 'Sequence',
  type: 'Type',
  extension: 'Extension',
};

const ENTITY_KIND_ORDER: EntityKind[] = [
  'table',
  'view',
  'matview',
  'foreign',
  'partitioned',
  'function',
  'procedure',
  'sequence',
  'type',
  'extension',
];

function EntityFilterMenu({
  entityFilter,
  toggle,
}: {
  entityFilter: Set<EntityKind>;
  toggle: (k: EntityKind) => void;
}) {
  const allOn = ENTITY_KIND_ORDER.every((k) => entityFilter.has(k));
  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton
          variant="plain"
          label="Filter entity types"
          active={!allOn}
          className="[&_svg]:h-4 [&_svg]:w-4"
        >
          <SlidersHorizontal />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={4} className="w-[220px] p-3">
        <h3 className="mb-2 text-[11px] font-semibold text-[var(--wb-text-2)]">
          Show entity types
        </h3>
        <div className="flex flex-col gap-1">
          {ENTITY_KIND_ORDER.map((k) => {
            const on = entityFilter.has(k);
            return (
              <label
                key={k}
                htmlFor={`entity-filter-${k}`}
                className="flex h-6 cursor-pointer items-center gap-2 rounded-[5px] px-1 text-[13px] text-[var(--wb-text)] hover:bg-[color-mix(in_srgb,var(--wb-text)_6%,transparent)]"
              >
                <Checkbox
                  id={`entity-filter-${k}`}
                  checked={on}
                  onCheckedChange={() => toggle(k)}
                />
                <span>{ENTITY_KIND_LABELS[k]}</span>
              </label>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ─── rows ────────────────────────────────────────────────────────────

const iconClass = 'h-3.5 w-3.5 shrink-0 text-[var(--wb-text-2)]';

function relationIcon(kind: Table['kind']) {
  return kind === 'view'
    ? Eye
    : kind === 'matview'
      ? Layers
      : kind === 'foreign'
        ? Globe
        : kind === 'partitioned'
          ? GitBranch
          : Table2;
}

function TreeRowView({
  id,
  row,
  active,
  focused,
  onActivate,
  onToggleExpand,
  onToggleFavorite,
  onContextMenu,
}: {
  id: string;
  row: TreeRow;
  active: boolean;
  focused: boolean;
  onActivate: () => void;
  onToggleExpand: () => void;
  onToggleFavorite: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const focusRing = focused && 'shadow-[inset_0_0_0_1px_var(--wb-accent)]';

  if (row.type === 'section') {
    return (
      <div
        id={id}
        role="treeitem"
        aria-level={1}
        aria-expanded={row.expanded}
        aria-selected={false}
        onContextMenu={onContextMenu}
        className={cn(sidebarRowClass(), focusRing)}
      >
        <button
          type="button"
          tabIndex={-1}
          onClick={onActivate}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-1 text-left"
        >
          <ChevronRight
            className={cn(
              'h-3 w-3 shrink-0 text-[var(--wb-text-2)] transition-transform',
              row.expanded && 'rotate-90',
            )}
          />
          <Folder className="h-4 w-4 shrink-0 fill-[var(--icon-folder)] text-[var(--icon-folder)]" />
          <span className="flex-1 truncate">{row.label}</span>
          <span className="text-[11px] tabular-nums text-[var(--wb-text-3)]">{row.count}</span>
        </button>
      </div>
    );
  }

  if (row.type === 'relation') {
    const { table: t, favorite } = row;
    const Icon = relationIcon(t.kind);
    return (
      <div
        id={id}
        role="treeitem"
        aria-level={row.level}
        aria-selected={active}
        aria-expanded={row.childCount > 0 ? row.expanded : undefined}
        onContextMenu={onContextMenu}
        className={cn('group/row relative items-stretch', sidebarRowClass(active), focusRing)}
      >
        {row.level === 2 && <span className="w-4 shrink-0" aria-hidden />}
        <button
          type="button"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            onToggleFavorite();
          }}
          aria-label={favorite ? `Unstar ${t.name}` : `Star ${t.name}`}
          className="group/star flex h-full w-6 shrink-0 cursor-pointer items-center justify-center"
        >
          <span className="relative grid h-4 w-4 place-items-center">
            <Icon
              className={cn(
                'absolute inset-0 m-auto h-3.5 w-3.5 transition-opacity duration-150',
                favorite
                  ? 'opacity-0'
                  : 'opacity-100 group-hover/row:opacity-0 group-focus-visible/star:opacity-0',
                'text-[var(--wb-text-2)]',
              )}
            />
            <Star
              className={cn(
                'absolute inset-0 m-auto h-3.5 w-3.5 transition-opacity duration-150',
                favorite
                  ? 'fill-[var(--icon-star)] text-[var(--icon-star)] opacity-100'
                  : 'text-[var(--wb-text-2)] opacity-0 group-hover/row:opacity-100 group-focus-visible/star:opacity-100',
              )}
            />
          </span>
        </button>
        <button
          type="button"
          tabIndex={-1}
          onClick={onActivate}
          title={`Open ${t.name}`}
          className="flex min-w-0 flex-1 items-center gap-2 pl-1 pr-2 text-left text-[13px] text-[var(--wb-text)]"
        >
          <span className="truncate">{t.name}</span>
        </button>
        {row.childCount > 0 && (
          <button
            type="button"
            tabIndex={-1}
            onClick={onToggleExpand}
            aria-label={
              row.expanded ? `Hide partitions of ${t.name}` : `Show partitions of ${t.name}`
            }
            title={`${row.childCount} partition${row.childCount === 1 ? '' : 's'}`}
            className="flex shrink-0 items-center gap-0.5 pr-1.5 text-[11px] tabular-nums text-[var(--wb-text-3)] hover:text-[var(--wb-text)]"
          >
            {row.childCount}
            <ChevronRight
              className={cn('h-3 w-3 transition-transform', row.expanded && 'rotate-90')}
            />
          </button>
        )}
      </div>
    );
  }

  const name = rowName(row);
  let Icon = Hash;
  let detail: string | null = null;
  let title = name;
  if (row.type === 'routine') {
    Icon = row.routine.kind === 'procedure' ? Workflow : FunctionSquare;
    detail = `(${row.routine.args})`;
    title = `${name}(${row.routine.args})${row.routine.returns ? ` → ${row.routine.returns}` : ''}`;
  } else if (row.type === 'type') {
    Icon = Braces;
    detail = row.typeInfo.kind;
  } else if (row.type === 'extension') {
    Icon = Blocks;
    detail = row.extension.version;
    title = `${name} ${row.extension.version} (schema ${row.extension.schema})`;
  }

  return (
    <div
      id={id}
      role="treeitem"
      aria-level={2}
      aria-selected={false}
      onContextMenu={onContextMenu}
      className={cn(sidebarRowClass(), focusRing)}
    >
      <button
        type="button"
        tabIndex={-1}
        onClick={onActivate}
        title={`${title}\nClick to open the definition`}
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-6 pr-2 text-left"
      >
        <Icon className={iconClass} />
        <span className="min-w-0 truncate">{name}</span>
        {detail && (
          <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--wb-text-3)]">
            {detail}
          </span>
        )}
      </button>
    </div>
  );
}
