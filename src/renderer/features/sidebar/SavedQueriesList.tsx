import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { IconButton, MenuItem, Pill } from '@/components/ui/workbench';
import {
  SnippetVarsDialog,
  applySnippetVars,
  extractSnippetVars,
} from '@/features/right-rail/SnippetVarsDialog';
import { cn } from '@/lib/cn';
import { useActiveTab, useSession } from '@/stores/session';
import type { SavedQuery } from '@shared/protocol';
import {
  BookmarkPlus,
  ChevronDown,
  ChevronRight,
  File,
  FilePlus2,
  Folder,
  Plus,
  SlidersHorizontal,
  Table2,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { SidebarEmpty, SidebarSearch, SidebarSearchRow, sidebarRowClass } from './sidebar-parts';

/**
 * Sidebar "Queries" mode — saved SQL snippets and saved table views for
 * the active connection. Grouped into SQL / Table views sections, with
 * a save-current-tab action at the top (TablePlus keeps its query
 * library in the left sidebar next to Items and History).
 */
export function SavedQueriesList() {
  const tab = useActiveTab();
  const connId = useSession((s) => s.activeConfig?.id);
  const savedMap = useSession((s) => s.settings.savedQueries);
  const saveCurrentTab = useSession((s) => s.saveCurrentTab);
  const deleteSavedQuery = useSession((s) => s.deleteSavedQuery);
  const openSavedQuery = useSession((s) => s.openSavedQuery);
  const addTab = useSession((s) => s.addTab);
  const setSql = useSession((s) => s.setSql);
  const runQuery = useSession((s) => s.runQuery);

  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState('');
  const [filter, setFilter] = useState('');
  const [varPrompt, setVarPrompt] = useState<{ sql: string; vars: string[] } | null>(null);

  const list = (connId && savedMap?.[connId]) || [];
  const q = filter.trim().toLowerCase();
  const visible = q
    ? list.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          (s.kind === 'sql' ? s.sql : `${s.tableSchema}.${s.tableName}`).toLowerCase().includes(q),
      )
    : list;
  const sqlQueries = visible.filter((s) => s.kind === 'sql');
  const tableViews = visible.filter((s) => s.kind === 'table');

  const canSave = !!tab && !!connId && (tab.kind === 'table' ? true : tab.sql.trim().length > 0);

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

  const open = (s: SavedQuery) => {
    if (s.kind === 'sql') {
      const vars = extractSnippetVars(s.sql);
      if (vars.length > 0) {
        setVarPrompt({ sql: s.sql, vars });
        return;
      }
    }
    openSavedQuery(s.id);
  };

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
          onSave={startNaming}
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
            {sqlQueries.length > 0 && (
              <Section label="SQL queries" count={sqlQueries.length}>
                {sqlQueries.map((s) => (
                  <SavedRow
                    key={s.id}
                    query={s}
                    onOpen={() => open(s)}
                    onDelete={() => void deleteSavedQuery(s.id)}
                  />
                ))}
              </Section>
            )}
            {tableViews.length > 0 && (
              <Section label="Table views" count={tableViews.length}>
                {tableViews.map((s) => (
                  <SavedRow
                    key={s.id}
                    query={s}
                    onOpen={() => open(s)}
                    onDelete={() => void deleteSavedQuery(s.id)}
                  />
                ))}
              </Section>
            )}
          </>
        )}
      </div>

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
          onSave={startNaming}
          onNewQuery={addTab}
          trigger={
            <IconButton variant="plain" label="More query actions" className="w-5">
              <ChevronDown />
            </IconButton>
          }
        />
      </div>

      <SnippetVarsDialog
        open={Boolean(varPrompt)}
        varNames={varPrompt?.vars ?? []}
        onCancel={() => setVarPrompt(null)}
        onConfirm={(values) => {
          if (!varPrompt) return;
          const filled = applySnippetVars(varPrompt.sql, values);
          // Open as a fresh SQL tab and run it; the saved snippet stays
          // parametric for next time.
          addTab();
          queueMicrotask(() => {
            setSql(filled);
            void runQuery();
          });
          setVarPrompt(null);
        }}
      />
    </div>
  );
}

/** Save / new-query actions — opened from the sliders button and the bottom "⌄". */
function QueryActionsMenu({
  trigger,
  align,
  canSave,
  onSave,
  onNewQuery,
}: {
  trigger: React.ReactNode;
  align: 'start' | 'end';
  canSave: boolean;
  onSave: () => void;
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
      <PopoverContent align={align} sideOffset={4} className="w-[220px] p-1" role="menu">
        <MenuItem
          icon={<BookmarkPlus />}
          label="Save current tab…"
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
  children,
}: {
  label: string;
  count: number;
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
        <Folder className="h-4 w-4 shrink-0 fill-[var(--icon-folder)] text-[var(--icon-folder)]" />
        <span className="flex-1 truncate">{label}</span>
        <span className="text-[11px] tabular-nums text-[var(--wb-text-3)]">{count}</span>
      </button>
      {open && <div className="pl-5">{children}</div>}
    </div>
  );
}

function SavedRow({
  query,
  onOpen,
  onDelete,
}: {
  query: SavedQuery;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const isTable = query.kind === 'table';
  const Icon = isTable ? Table2 : File;
  const detail = isTable
    ? `${query.tableSchema}.${query.tableName}`
    : query.sql.replace(/\s+/g, ' ').trim().slice(0, 80) || '(empty)';

  return (
    <div className={cn('group/saved gap-1', sidebarRowClass(confirming))}>
      <button
        type="button"
        onClick={onOpen}
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-1 text-left"
        title={isTable ? `${query.name}\n${detail}` : `${query.name}\n\n${query.sql}`}
      >
        <Icon className="h-4 w-4 shrink-0 text-[var(--wb-text-2)]" />
        <span className="min-w-0 flex-1 truncate">{query.name}</span>
      </button>
      {confirming ? (
        <div className="flex shrink-0 items-center gap-0.5 pr-1">
          <Button variant="destructive" size="xs" className="h-5 px-1.5" onClick={onDelete}>
            Delete
          </Button>
          <Button
            variant="ghost"
            size="xs"
            className="h-5 px-1.5"
            onClick={() => setConfirming(false)}
          >
            Keep
          </Button>
        </div>
      ) : (
        <IconButton
          variant="plain"
          label={`Delete ${query.name}`}
          title="Delete"
          onClick={() => setConfirming(true)}
          className="mr-0.5 h-5 w-5 opacity-0 transition-opacity group-hover/saved:opacity-100 focus-visible:opacity-100"
        >
          <Trash2 />
        </IconButton>
      )}
    </div>
  );
}
