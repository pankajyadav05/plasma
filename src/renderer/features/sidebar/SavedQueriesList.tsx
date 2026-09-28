import { Button } from '@/components/ui/button';
import {
  SnippetVarsDialog,
  applySnippetVars,
  extractSnippetVars,
} from '@/features/right-rail/SnippetVarsDialog';
import { cn } from '@/lib/cn';
import { useActiveTab, useSession } from '@/stores/session';
import type { SavedQuery } from '@shared/protocol';
import { BookmarkPlus, FileCode, Table2, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { SidebarEmpty, SidebarSearch } from './sidebar-parts';

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
      <div className="flex items-center gap-1 border-b border-sidebar-border px-3 py-2">
        <SidebarSearch value={filter} onChange={setFilter} placeholder="Search queries…" />
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => {
            if (!canSave) return;
            setDraft(defaultName);
            setNaming(true);
          }}
          disabled={!canSave}
          aria-label="Save current tab"
          title={canSave ? 'Save current tab' : 'Open a table or write a query first'}
        >
          <BookmarkPlus />
        </Button>
      </div>

      {naming && (
        <div className="flex shrink-0 items-center gap-1 border-b border-sidebar-border px-3 py-2">
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
            className="h-8 min-w-0 flex-1 rounded-md border border-sidebar-border bg-background px-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
          />
          <Button
            variant="primary"
            size="sm"
            onClick={() => void confirmSave()}
            disabled={!draft.trim()}
          >
            Save
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {list.length === 0 ? (
          <SidebarEmpty
            title="No saved queries"
            hint="Write SQL or open a table, then use the bookmark button to keep it here."
          />
        ) : visible.length === 0 ? (
          <SidebarEmpty title={`nothing matches "${filter}"`} />
        ) : (
          <>
            {sqlQueries.length > 0 && (
              <Section label="SQL" count={sqlQueries.length}>
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

function Section({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-1">
      <div className="flex items-baseline gap-2 px-4 pb-0.5 pt-2">
        <span className="font-display text-xs italic text-muted-foreground">{label}</span>
        <span className="font-mono text-[10px] text-muted-foreground/70">{count}</span>
      </div>
      {children}
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
  const Icon = isTable ? Table2 : FileCode;
  const detail = isTable
    ? `${query.tableSchema}.${query.tableName}`
    : query.sql.replace(/\s+/g, ' ').trim().slice(0, 80) || '(empty)';

  return (
    <div
      className={cn(
        'group/saved mx-2 flex items-center gap-1 rounded-md transition-colors hover:bg-sidebar-accent',
        confirming && 'bg-sidebar-accent',
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-start gap-2 px-2 py-1.5 text-left"
        title={isTable ? detail : query.sql}
      >
        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-foreground">{query.name}</span>
          <span className="block truncate font-mono text-[11px] text-muted-foreground">
            {detail}
          </span>
        </span>
      </button>
      {confirming ? (
        <div className="flex shrink-0 items-center gap-0.5 pr-1">
          <Button variant="destructive" size="xs" onClick={onDelete}>
            Delete
          </Button>
          <Button variant="ghost" size="xs" onClick={() => setConfirming(false)}>
            Keep
          </Button>
        </div>
      ) : (
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setConfirming(true)}
          aria-label={`Delete ${query.name}`}
          title="Delete"
          className="mr-1 opacity-0 transition-opacity group-hover/saved:opacity-100 focus-visible:opacity-100"
        >
          <Trash2 />
        </Button>
      )}
    </div>
  );
}
