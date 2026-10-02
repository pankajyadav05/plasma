import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { IconButton, MenuItem, Pill } from '@/components/ui/workbench';
import { SnippetsPanel } from '@/features/snippets/SnippetsPanel';
import { cn } from '@/lib/cn';
import { useActiveTab, useSession } from '@/stores/session';
import { savedQueryFolders } from '@/stores/session-saved-queries';
import type { SavedQuery } from '@shared/protocol';
import {
  BookmarkPlus,
  ChevronDown,
  ChevronRight,
  File,
  FilePlus2,
  Folder,
  FolderInput,
  FolderMinus,
  FolderPlus,
  Pencil,
  Plus,
  Save,
  SlidersHorizontal,
  Star,
  Table2,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { type ContextMenuState, type MenuEntry, SidebarContextMenu } from './SidebarContextMenu';
import { fuzzyFilter } from './fuzzy';
import { SidebarEmpty, SidebarSearch, SidebarSearchRow, sidebarRowClass } from './sidebar-parts';

/** Inline edit in progress: rename a query, or name a new folder for it. */
type Editing = { id: string; mode: 'rename' | 'folder'; draft: string } | null;

/**
 * Sidebar "Queries" mode — saved SQL snippets and saved table views for
 * the active connection (PC6). Grouped as Favourites, user folders and
 * Ungrouped; each row has a right-click menu to rename, move to a
 * folder, favourite, update from the current tab, or delete. A tab that
 * was opened from (or saved as) a query can be written back in place.
 */
export function SavedQueriesList() {
  const tab = useActiveTab();
  const connId = useSession((s) => s.activeConfig?.id);
  const savedMap = useSession((s) => s.settings.savedQueries);
  const saveCurrentTab = useSession((s) => s.saveCurrentTab);
  const deleteSavedQuery = useSession((s) => s.deleteSavedQuery);
  const openSavedQuery = useSession((s) => s.openSavedQuery);
  const updateSavedQuery = useSession((s) => s.updateSavedQuery);
  const updateSavedQueryFromTab = useSession((s) => s.updateSavedQueryFromTab);
  const addTab = useSession((s) => s.addTab);

  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState('');
  const [filter, setFilter] = useState('');
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const list: SavedQuery[] = (connId && savedMap?.[connId]) || [];
  const visible = fuzzyFilter(list, filter, (s) =>
    s.kind === 'sql' ? `${s.name} ${s.sql}` : `${s.name} ${s.tableSchema}.${s.tableName}`,
  );
  const folders = savedQueryFolders(list);
  const favourites = visible.filter((s) => s.favorite);
  const ungrouped = visible.filter((s) => !s.folder && !s.favorite);

  const canSave = !!tab && !!connId && (tab.kind === 'table' ? true : tab.sql.trim().length > 0);
  const linked = tab?.savedQueryId ? list.find((q) => q.id === tab.savedQueryId) : undefined;

  const defaultName = (() => {
    if (!tab) return '';
    if (tab.kind === 'table') {
      const base =
        tab.tableSchema === 'public' ? tab.tableName : `${tab.tableSchema}.${tab.tableName}`;
      const tag = [
        tab.filters.length > 0 && `${tab.filters.length}f`,
        tab.tableSort.length > 0 && 'sorted',
        tab.hiddenColumns.size > 0 && 'cols',
      ]
        .filter(Boolean)
        .join(' · ');
      return tag ? `${base} (${tag})` : (base ?? '');
    }
    return tab.title;
  })();

  const startNaming = () => {
    if (!canSave) return;
    setDraft(defaultName);
    setNaming(true);
  };

  const confirmSave = async () => {
    const name = draft.trim();
    if (!name) return;
    await saveCurrentTab(name);
    setNaming(false);
    setDraft('');
  };

  // PC7: opening only opens — never runs. `:name` variables are filled in
  // the Variables bar on the first run (saved values come back as defaults).
  const open = (s: SavedQuery) => openSavedQuery(s.id);

  const commitEdit = () => {
    if (!editing) return;
    const value = editing.draft.trim();
    if (value) {
      void updateSavedQuery(
        editing.id,
        editing.mode === 'rename' ? { name: value } : { folder: value },
      );
    }
    setEditing(null);
  };

  const menuFor = (q: SavedQuery): MenuEntry[] => {
    const entries: MenuEntry[] = [
      { type: 'item', label: 'Open', icon: <File />, onSelect: () => open(q) },
      {
        type: 'item',
        label: 'Rename…',
        icon: <Pencil />,
        onSelect: () => setEditing({ id: q.id, mode: 'rename', draft: q.name }),
      },
      {
        type: 'item',
        label: 'Update with current tab',
        icon: <Save />,
        disabled: !canSave || (tab?.kind === 'table') !== (q.kind === 'table'),
        onSelect: () => void updateSavedQueryFromTab(q.id),
      },
      {
        type: 'item',
        label: q.favorite ? 'Remove from favourites' : 'Add to favourites',
        icon: <Star />,
        onSelect: () => void updateSavedQuery(q.id, { favorite: !q.favorite }),
      },
      { type: 'separator' },
      { type: 'label', label: 'Move to folder' },
      ...folders
        .filter((f) => f !== q.folder)
        .map(
          (f): MenuEntry => ({
            type: 'item',
            label: f,
            icon: <FolderInput />,
            onSelect: () => void updateSavedQuery(q.id, { folder: f }),
          }),
        ),
      {
        type: 'item',
        label: 'New folder…',
        icon: <FolderPlus />,
        onSelect: () => setEditing({ id: q.id, mode: 'folder', draft: '' }),
      },
    ];
    if (q.folder) {
      entries.push({
        type: 'item',
        label: 'Remove from folder',
        icon: <FolderMinus />,
        onSelect: () => void updateSavedQuery(q.id, { folder: null }),
      });
    }
    entries.push(
      { type: 'separator' },
      {
        type: 'item',
        label: 'Delete…',
        icon: <Trash2 />,
        destructive: true,
        onSelect: () => setConfirmDelete(q.id),
      },
    );
    return entries;
  };

  const renderRow = (s: SavedQuery) => (
    <SavedRow
      key={s.id}
      query={s}
      editing={editing?.id === s.id ? editing : null}
      confirming={confirmDelete === s.id}
      linked={linked?.id === s.id}
      onOpen={() => open(s)}
      onEditChange={(d) => setEditing((e) => (e ? { ...e, draft: d } : e))}
      onEditCommit={commitEdit}
      onEditCancel={() => setEditing(null)}
      onAskDelete={() => setConfirmDelete(s.id)}
      onDelete={() => {
        setConfirmDelete(null);
        void deleteSavedQuery(s.id);
      }}
      onKeep={() => setConfirmDelete(null)}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY, entries: menuFor(s) });
      }}
    />
  );

  return (
    <div className="flex h-full flex-col">
      <SidebarSearchRow>
        <SidebarSearch
          value={filter}
          onChange={setFilter}
          placeholder="Search for query…"
          ariaLabel="Search queries"
        />
        <QueryActionsMenu
          align="end"
          canSave={canSave}
          linkedName={linked?.name}
          onSave={startNaming}
          onUpdate={() => linked && void updateSavedQueryFromTab(linked.id)}
          onNewQuery={addTab}
          trigger={
            <IconButton variant="plain" label="Query options" className="[&_svg]:h-4 [&_svg]:w-4">
              <SlidersHorizontal />
            </IconButton>
          }
        />
      </SidebarSearchRow>

      {naming && (
        <div className="flex shrink-0 items-center gap-1.5 px-2.5 pb-2">
          <input
            // biome-ignore lint/a11y/noAutofocus: naming field appears on explicit user action
            autoFocus
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void confirmSave();
              else if (e.key === 'Escape') {
                setNaming(false);
                setDraft('');
              }
            }}
            placeholder="Name this query…"
            aria-label="Saved query name"
            className="h-[26px] min-w-0 flex-1 rounded-[7px] border-0 bg-[var(--wb-field)] px-2.5 text-[13px] text-[var(--wb-text)] outline-none shadow-[0_0_0_2px_color-mix(in_srgb,var(--wb-accent)_55%,transparent)] placeholder:text-[var(--wb-text-3)]"
          />
          <Pill onClick={() => void confirmSave()} disabled={!draft.trim()}>
            Save
          </Pill>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {list.length === 0 ? (
          <SidebarEmpty
            title="No saved queries"
            hint="Write SQL or open a table, then use + below to keep it here."
          />
        ) : visible.length === 0 ? (
          <SidebarEmpty title={`nothing matches "${filter}"`} />
        ) : (
          <>
            {favourites.length > 0 && (
              <Section label="Favourites" count={favourites.length} favourite>
                {favourites.map(renderRow)}
              </Section>
            )}
            {folders.map((f) => {
              const items = visible.filter((s) => s.folder === f && !s.favorite);
              if (items.length === 0) return null;
              return (
                <Section key={`folder:${f}`} label={f} count={items.length}>
                  {items.map(renderRow)}
                </Section>
              );
            })}
            {ungrouped.length > 0 && (
              <Section label="Ungrouped" count={ungrouped.length}>
                {ungrouped.map(renderRow)}
              </Section>
            )}
          </>
        )}
      </div>

      <SnippetsPanel filter={filter} />

      <div className="flex h-9 shrink-0 items-center gap-0.5 border-t border-[var(--wb-separator)] px-2">
        <IconButton
          variant="plain"
          label={canSave ? 'Save current tab' : 'Open a table or write a query first'}
          aria-label="Save current tab"
          onClick={startNaming}
          disabled={!canSave}
          className="[&_svg]:h-4 [&_svg]:w-4"
        >
          <Plus />
        </IconButton>
        <QueryActionsMenu
          align="start"
          canSave={canSave}
          linkedName={linked?.name}
          onSave={startNaming}
          onUpdate={() => linked && void updateSavedQueryFromTab(linked.id)}
          onNewQuery={addTab}
          trigger={
            <IconButton variant="plain" label="More query actions" className="w-5">
              <ChevronDown />
            </IconButton>
          }
        />
      </div>

      <SidebarContextMenu state={menu} onClose={() => setMenu(null)} />
    </div>
  );
}

/** Save / update / new-query actions — opened from the sliders button and the bottom "⌄". */
function QueryActionsMenu({
  trigger,
  align,
  canSave,
  linkedName,
  onSave,
  onUpdate,
  onNewQuery,
}: {
  trigger: React.ReactNode;
  align: 'start' | 'end';
  canSave: boolean;
  /** Name of the saved query the active tab came from, if any. */
  linkedName?: string;
  onSave: () => void;
  onUpdate: () => void;
  onNewQuery: () => void;
}) {
  const [open, setOpen] = useState(false);
  const run = (fn: () => void) => {
    setOpen(false);
    fn();
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align={align} sideOffset={4} className="w-[240px] p-1" role="menu">
        {linkedName && (
          <MenuItem
            icon={<Save />}
            label={`Update “${linkedName}”`}
            disabled={!canSave}
            onClick={() => run(onUpdate)}
          />
        )}
        <MenuItem
          icon={<BookmarkPlus />}
          label={linkedName ? 'Save as new query…' : 'Save current tab…'}
          disabled={!canSave}
          onClick={() => run(onSave)}
        />
        <MenuItem icon={<FilePlus2 />} label="New SQL query" onClick={() => run(onNewQuery)} />
      </PopoverContent>
    </Popover>
  );
}

/** Collapsible folder, TablePlus-style ("Ungrouped" etc.). */
function Section({
  label,
  count,
  favourite,
  children,
}: {
  label: string;
  count: number;
  favourite?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(sidebarRowClass(), 'w-[calc(100%-1rem)] gap-1.5 px-1 text-left')}
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 text-[var(--wb-text-2)] transition-transform',
            open && 'rotate-90',
          )}
        />
        {favourite ? (
          <Star className="h-4 w-4 shrink-0 fill-[var(--icon-star)] text-[var(--icon-star)]" />
        ) : (
          <Folder className="h-4 w-4 shrink-0 fill-[var(--icon-folder)] text-[var(--icon-folder)]" />
        )}
        <span className="flex-1 truncate">{label}</span>
        <span className="text-[11px] tabular-nums text-[var(--wb-text-3)]">{count}</span>
      </button>
      {open && <div className="pl-5">{children}</div>}
    </div>
  );
}

function SavedRow({
  query,
  editing,
  confirming,
  linked,
  onOpen,
  onEditChange,
  onEditCommit,
  onEditCancel,
  onAskDelete,
  onDelete,
  onKeep,
  onContextMenu,
}: {
  query: SavedQuery;
  editing: NonNullable<Editing> | null;
  confirming: boolean;
  linked: boolean;
  onOpen: () => void;
  onEditChange: (draft: string) => void;
  onEditCommit: () => void;
  onEditCancel: () => void;
  onAskDelete: () => void;
  onDelete: () => void;
  onKeep: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const isTable = query.kind === 'table';
  const Icon = isTable ? Table2 : File;
  const detail = isTable
    ? `${query.tableSchema}.${query.tableName}`
    : query.sql.replace(/\s+/g, ' ').trim().slice(0, 80) || '(empty)';

  if (editing) {
    return (
      <div className={cn('gap-1', sidebarRowClass(true))}>
        <Icon className="ml-1 h-4 w-4 shrink-0 text-[var(--wb-text-2)]" />
        <input
          // biome-ignore lint/a11y/noAutofocus: inline edit opens on explicit user action
          autoFocus
          type="text"
          value={editing.draft}
          onChange={(e) => onEditChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onEditCommit();
            else if (e.key === 'Escape') onEditCancel();
          }}
          onBlur={onEditCommit}
          placeholder={editing.mode === 'rename' ? 'Query name…' : 'Folder name…'}
          aria-label={editing.mode === 'rename' ? `Rename ${query.name}` : 'New folder name'}
          className="h-5 min-w-0 flex-1 rounded-[4px] border-0 bg-[var(--wb-field)] px-1.5 text-[13px] text-[var(--wb-text)] outline-none shadow-[0_0_0_2px_color-mix(in_srgb,var(--wb-accent)_55%,transparent)]"
        />
      </div>
    );
  }

  return (
    <div
      className={cn('group/saved gap-1', sidebarRowClass(confirming))}
      onContextMenu={onContextMenu}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-1 text-left"
        title={isTable ? `${query.name}\n${detail}` : `${query.name}\n\n${query.sql}`}
      >
        <Icon className="h-4 w-4 shrink-0 text-[var(--wb-text-2)]" />
        <span className="min-w-0 flex-1 truncate">{query.name}</span>
        {linked && (
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--wb-text-3)]"
            title="Open in the current tab"
            aria-label="Open in the current tab"
          />
        )}
      </button>
      {confirming ? (
        <div className="flex shrink-0 items-center gap-0.5 pr-1">
          <Button variant="destructive" size="xs" className="h-5 px-1.5" onClick={onDelete}>
            Delete
          </Button>
          <Button variant="ghost" size="xs" className="h-5 px-1.5" onClick={onKeep}>
            Keep
          </Button>
        </div>
      ) : (
        <IconButton
          variant="plain"
          label={`Delete ${query.name}`}
          title="Delete"
          onClick={onAskDelete}
          className="mr-0.5 h-5 w-5 opacity-0 transition-opacity group-hover/saved:opacity-100 focus-visible:opacity-100"
        >
          <Trash2 />
        </IconButton>
      )}
    </div>
  );
}
