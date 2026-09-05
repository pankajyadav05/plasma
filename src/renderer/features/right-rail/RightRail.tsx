import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { AiPanel } from '@/features/ai/AiPanel';
import { MonacoEditor } from '@/features/editor/MonacoEditor';
import { cn } from '@/lib/cn';
import { ipc } from '@/lib/ipc';
import { kbd } from '@/lib/platform';
import { buildRlsPoliciesSql } from '@/lib/table-query';
import { type RightPanelMode, useActiveTab, useSession } from '@/stores/session';
import type { SavedQuery } from '@shared/protocol';
import {
  Bookmark,
  BookmarkPlus,
  Check,
  Code2,
  Database,
  FileCode,
  Loader2,
  Play,
  RefreshCw,
  Shield,
  ShieldCheck,
  ShieldOff,
  Sparkles,
  Square,
  Trash2,
  UserCircle,
  Wand2,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { SnippetVarsDialog, applySnippetVars, extractSnippetVars } from './SnippetVarsDialog';

const RAIL_WIDTH = 48;
const PANEL_WIDTH = 460;

const NOOP = () => {};

interface RailItem {
  mode: NonNullable<RightPanelMode>;
  icon: React.ReactNode;
  label: string;
  /** Optional icon override that conveys state (e.g. ShieldOff vs ShieldCheck). */
  stateIcon?: React.ReactNode;
}

/**
 * Right-side activity bar — three icons (Query, Role, RLS) that each
 * open a panel which slides in to the *left* of the rail. The rail is
 * always visible while connected; the panel only renders when a mode
 * is selected. Clicking the active icon closes the panel.
 *
 * Replaces the old EditorPane (collapsed strip / expanded drawer)
 * pattern. The query slot still owns Monaco; the role and RLS slots
 * subsume what used to be popovers in the toolbar.
 */
export function RightRail() {
  const mode = useSession((s) => s.rightPanelMode);
  const setMode = useSession((s) => s.setRightPanelMode);
  const engine = useSession((s) => s.activeConfig?.engine ?? 'postgres');
  const tab = useActiveTab();
  const rlsCount = tab?.kind === 'table' ? tab.rlsPolicyCount : null;

  const isTable = tab?.kind === 'table';
  const isPostgres = engine === 'postgres';
  // SQL tabs get the Monaco editor inline in the main canvas now, so
  // the right-rail Query icon would be a duplicate. Show it only for
  // table tabs (where it surfaces the compiled, read-only SQL). The
  // RLS / Role / Saved-queries panels are SQL-specific — hidden when
  // connected to redis / opensearch.
  const items: RailItem[] = [
    ...(isPostgres && isTable
      ? [
          {
            mode: 'query' as const,
            icon: <Code2 className="h-[18px] w-[18px]" />,
            label: 'Compiled SQL',
          },
        ]
      : []),
    {
      mode: 'ai',
      icon: <Wand2 className="h-[18px] w-[18px]" />,
      label: 'AI assistant',
    },
    ...(isPostgres
      ? ([
          {
            mode: 'saved',
            icon: <Bookmark className="h-[18px] w-[18px]" />,
            label: 'Saved queries',
          },
          {
            mode: 'role',
            icon: <UserCircle className="h-[18px] w-[18px]" />,
            label: 'Session role',
          },
          {
            mode: 'rls',
            icon: <Shield className="h-[18px] w-[18px]" />,
            stateIcon:
              rlsCount === null ? (
                <Shield className="h-[18px] w-[18px]" />
              ) : rlsCount === 0 ? (
                <ShieldOff className="h-[18px] w-[18px]" />
              ) : (
                <ShieldCheck className="h-[18px] w-[18px]" />
              ),
            label: 'Row-level security',
          },
        ] as RailItem[])
      : []),
  ];

  // Auto-collapse RLS slot when there's no table tab — it has nothing
  // meaningful to show. Switch to query if user was on rls.
  useEffect(() => {
    if (mode === 'rls' && !isTable) setMode('query');
  }, [mode, isTable, setMode]);

  const handleClick = (next: NonNullable<RightPanelMode>) => {
    setMode(mode === next ? null : next);
  };

  return (
    <section
      className="flex shrink-0 self-stretch border-l border-border bg-background"
      aria-label="Right-side panels"
    >
      <div
        className="overflow-hidden transition-[width] duration-base ease-out"
        style={{ width: mode ? PANEL_WIDTH : 0 }}
      >
        <div style={{ width: PANEL_WIDTH }} className="h-full">
          {mode === 'query' && <QueryPanel />}
          {mode === 'ai' && <AiPanel />}
          {mode === 'saved' && <SavedQueriesPanel />}
          {mode === 'role' && <RolePanel />}
          {mode === 'rls' && <RlsPanel />}
        </div>
      </div>

      <nav
        className="flex shrink-0 flex-col items-center gap-0.5 border-l border-border bg-sidebar py-2"
        style={{ width: RAIL_WIDTH }}
        aria-label="Right rail"
      >
        {items.map((it) => {
          const isActive = mode === it.mode;
          const disabled = it.mode === 'rls' && !isTable;
          return (
            <button
              key={it.mode}
              type="button"
              disabled={disabled}
              onClick={() => handleClick(it.mode)}
              aria-label={it.label}
              aria-current={isActive}
              title={
                disabled
                  ? `${it.label} — open a table tab first`
                  : `${it.label} (${it.mode === 'query' ? kbd('J') : it.mode === 'ai' ? kbd('L') : 'click'})`
              }
              className={cn(
                'relative grid h-9 w-9 cursor-pointer place-items-center rounded-md transition-colors duration-150',
                isActive
                  ? 'bg-accent text-primary'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent',
              )}
            >
              {it.stateIcon ?? it.icon}
              {isActive && (
                <span
                  className="absolute -left-px top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-r-full bg-primary"
                  aria-hidden
                />
              )}
            </button>
          );
        })}
      </nav>
    </section>
  );
}

// ───────────────────────── Query panel ─────────────────────────

function QueryPanel() {
  const tab = useActiveTab();
  const setSql = useSession((s) => s.setSql);
  const runQuery = useSession((s) => s.runQuery);
  const cancelQuery = useSession((s) => s.cancelQuery);
  const refreshTable = useSession((s) => s.refreshTable);
  const connectionState = useSession((s) => s.connectionState);
  const setMode = useSession((s) => s.setRightPanelMode);
  const formatActiveSql = useSession((s) => s.formatActiveSql);
  const theme = useSession((s) => s.settings.theme);
  const fontSize = useSession((s) => s.settings.editorFontSize);
  const apiKey = useSession((s) => s.settings.openrouterApiKey || s.settings.claudeApiKey);

  if (!tab) {
    return <PanelEmpty title="No active tab" hint="Open a table or write a query." />;
  }

  const isTable = tab.kind === 'table';
  const canRun = connectionState === 'connected' && (isTable || tab.sql.trim().length > 0);
  const running = tab.queryRunState === 'running';

  const handleAction = () => {
    if (running) void cancelQuery();
    else if (isTable) void refreshTable();
    else void runQuery();
  };

  const handleRunAll = () => {
    if (running || isTable) return;
    void runQuery({ all: true });
  };

  const close = () => setMode(null);

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title={tab.title} hint={isTable ? 'table' : undefined} onClose={close}>
        {!isTable && apiKey.trim().length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="font-display italic text-muted-foreground"
            title={`Open AI assistant (${kbd('L')})`}
            onClick={() => setMode('ai')}
          >
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            ask
          </Button>
        )}
        {!isTable && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => void formatActiveSql()}
            title={`Format SQL (${kbd('⇧F')})`}
            aria-label="Format SQL"
          >
            <Wand2 />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setMode('saved')}
          title="Save / open saved queries"
          aria-label="Save current query"
        >
          <Bookmark />
        </Button>
        {running ? (
          <Button variant="destructive" size="sm" onClick={handleAction}>
            <Square className="fill-current" />
            Cancel
            <Kbd className="border-0 bg-transparent text-destructive-foreground/80">{kbd('.')}</Kbd>
          </Button>
        ) : isTable ? (
          <Button variant="secondary" size="sm" onClick={handleAction} disabled={!canRun}>
            <RefreshCw />
            Refresh
          </Button>
        ) : (
          <Button variant="primary" size="sm" onClick={handleAction} disabled={!canRun}>
            <Play className="fill-current" />
            Run
            <Kbd className="border-0 bg-transparent text-primary-foreground/80">{kbd('⏎')}</Kbd>
          </Button>
        )}
      </PanelHeader>

      <div className="relative min-h-0 flex-1 overflow-hidden pt-3">
        {isTable && (
          <div className="absolute left-4 top-1 z-10 font-display text-xs italic text-muted-foreground">
            compiled from table browser — read-only
          </div>
        )}
        <MonacoEditor
          value={tab.sql}
          onChange={isTable ? NOOP : setSql}
          onRun={handleAction}
          onRunAll={handleRunAll}
          onToggle={close}
          runningRange={tab.queryRunningRange}
          errorRange={tab.queryErrorRange}
          errorMessage={tab.queryError}
          theme={theme}
          fontSize={fontSize}
          readOnly={isTable}
          onFormat={isTable ? undefined : () => void formatActiveSql()}
          onAskAi={
            isTable
              ? undefined
              : (text) => {
                  setMode('ai');
                  const seed = text.trim()
                    ? `Explain or improve this SQL:\n\n\`\`\`sql\n${text}\n\`\`\``
                    : '';
                  if (seed) {
                    void useSession.getState().aiAsk(seed);
                  }
                }
          }
        />
      </div>
    </div>
  );
}

// ───────────────────────── Role panel ─────────────────────────

function RolePanel() {
  const activeRole = useSession((s) => s.activeRole);
  const availableRoles = useSession((s) => s.availableRoles);
  const setActiveRole = useSession((s) => s.setActiveRole);
  const setMode = useSession((s) => s.setRightPanelMode);
  const [filter, setFilter] = useState('');

  const list = availableRoles.filter((r) => r.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Session role"
        hint={activeRole ? `SET ROLE ${activeRole}` : 'default'}
        onClose={() => setMode(null)}
      />

      <div className="border-b border-border px-3 py-2">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter roles…"
          className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
          aria-label="Filter roles"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        <RoleRow
          label="default"
          note="reset"
          active={activeRole === null}
          onClick={() => void setActiveRole(null)}
        />
        {list.length === 0 && availableRoles.length > 0 && (
          <div className="px-3 py-3 font-display text-xs italic text-muted-foreground">
            no matches
          </div>
        )}
        {list.map((r) => (
          <RoleRow
            key={r}
            label={r}
            active={activeRole === r}
            onClick={() => void setActiveRole(r)}
          />
        ))}
        {availableRoles.length === 0 && (
          <div className="px-3 py-3 font-display text-xs italic text-muted-foreground">
            no roles loaded
          </div>
        )}
      </div>

      <PanelFooter>Affects every query on this connection until you reset to default.</PanelFooter>
    </div>
  );
}

function RoleRow({
  label,
  note,
  active,
  onClick,
}: {
  label: string;
  note?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors duration-150',
        active
          ? 'bg-accent text-accent-foreground'
          : 'text-foreground hover:bg-accent hover:text-accent-foreground',
      )}
    >
      {active ? (
        <Check className="h-3 w-3 text-primary" />
      ) : (
        <span className="h-3 w-3" aria-hidden />
      )}
      <span className="font-mono">{label}</span>
      {note && <span className="ml-auto text-muted-foreground">{note}</span>}
    </button>
  );
}

// ───────────────────────── RLS panel ─────────────────────────

interface PolicyRow {
  name: string;
  cmd: string;
  roles: string;
  qual: string;
  withCheck: string;
  permissive: string;
}

function RlsPanel() {
  const tab = useActiveTab();
  const setMode = useSession((s) => s.setRightPanelMode);
  const [policies, setPolicies] = useState<PolicyRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  // Keyed off the active table so switching tabs reloads the list.
  // We pin to scalar fields (kind/schema/name) rather than the whole
  // tab object — otherwise unrelated tab mutations (run state, page
  // change) would refire the policies query.
  const tabKind = tab?.kind;
  const tabSchema = tab?.kind === 'table' ? tab.tableSchema : undefined;
  const tabName = tab?.kind === 'table' ? tab.tableName : undefined;
  useEffect(() => {
    if (tabKind !== 'table' || !tabSchema || !tabName) {
      setPolicies(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const { sql, params } = buildRlsPoliciesSql(tabSchema, tabName);
        const res = await ipc.query.run(sql, params, { internal: true });
        if (cancelled) return;
        setPolicies(
          res.rows.map((r) => ({
            name: String(r[0] ?? ''),
            cmd: String(r[1] ?? ''),
            roles: String(r[2] ?? ''),
            qual: String(r[3] ?? ''),
            withCheck: String(r[4] ?? ''),
            permissive: String(r[5] ?? ''),
          })),
        );
      } catch {
        if (!cancelled) setPolicies([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tabKind, tabSchema, tabName]);

  if (!tab || tab.kind !== 'table') {
    return (
      <div className="flex h-full flex-col">
        <PanelHeader title="Row-level security" onClose={() => setMode(null)} />
        <PanelEmpty
          title="No table selected"
          hint="Open a table tab to inspect its RLS policies."
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Row-level security"
        hint={`${tab.tableSchema}.${tab.tableName}`}
        onClose={() => setMode(null)}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="ml-2 font-display text-sm italic">loading policies…</span>
          </div>
        )}
        {!loading && policies && policies.length === 0 && (
          <PanelEmpty
            title="No RLS policies"
            hint="This table is unrestricted by RLS for the current role."
          />
        )}
        {!loading && policies?.map((p) => <PolicyItem key={p.name} p={p} />)}
      </div>
    </div>
  );
}

function PolicyItem({ p }: { p: PolicyRow }) {
  return (
    <div className="border-b border-border px-3 py-2 last:border-b-0">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs font-medium text-foreground">{p.name}</span>
        <span className="rounded-sm border border-border px-1 py-0.5 font-mono text-[9px] uppercase text-muted-foreground">
          {p.cmd || 'ALL'}
        </span>
        {p.permissive === 'PERMISSIVE' && (
          <span className="rounded-sm border border-border px-1 py-0.5 font-mono text-[9px] uppercase text-muted-foreground">
            permissive
          </span>
        )}
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">{p.roles}</span>
      </div>
      {p.qual && (
        <div className="mt-1">
          <div className="font-display text-[10px] italic text-muted-foreground">USING</div>
          <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[11px] text-foreground">
            {p.qual}
          </pre>
        </div>
      )}
      {p.withCheck && (
        <div className="mt-1">
          <div className="font-display text-[10px] italic text-muted-foreground">WITH CHECK</div>
          <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[11px] text-foreground">
            {p.withCheck}
          </pre>
        </div>
      )}
    </div>
  );
}

// ───────────────────────── Saved queries panel ─────────────────────────

function SavedQueriesPanel() {
  const setMode = useSession((s) => s.setRightPanelMode);
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
  const [varPrompt, setVarPrompt] = useState<{
    name: string;
    sql: string;
    vars: string[];
  } | null>(null);

  const list = (connId && savedMap?.[connId]) || [];
  const visible = list.filter((q) => q.name.toLowerCase().includes(filter.toLowerCase()));

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

  const startSave = () => {
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

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Saved queries"
        hint={list.length ? `${list.length}` : undefined}
        onClose={() => setMode(null)}
      >
        {!naming && (
          <Button
            variant="primary"
            size="sm"
            onClick={startSave}
            disabled={!canSave}
            title={
              !connId
                ? 'Connect to a database first'
                : !canSave
                  ? 'Open a table or write a query first'
                  : 'Save current tab'
            }
          >
            <BookmarkPlus />
            Save
          </Button>
        )}
      </PanelHeader>

      {naming && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <input
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
            className="h-8 flex-1 rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
          />
          <Button
            variant="primary"
            size="sm"
            onClick={() => void confirmSave()}
            disabled={!draft.trim()}
          >
            Save
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setNaming(false);
              setDraft('');
            }}
          >
            Cancel
          </Button>
        </div>
      )}

      {list.length > 4 && (
        <div className="border-b border-border px-3 py-2">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter saved…"
            className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
            aria-label="Filter saved queries"
          />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!connId && (
          <PanelEmpty
            title="Not connected"
            hint="Connect to a database to see its saved queries."
          />
        )}
        {connId && list.length === 0 && (
          <PanelEmpty
            title="No saved queries"
            hint="Open a table or write SQL, then click Save to capture it here."
          />
        )}
        {connId && list.length > 0 && visible.length === 0 && (
          <div className="px-3 py-3 font-display text-xs italic text-muted-foreground">
            no matches
          </div>
        )}
        {visible.map((q) => (
          <SavedQueryRow
            key={q.id}
            query={q}
            onOpen={() => {
              if (q.kind === 'sql') {
                const vars = extractSnippetVars(q.sql);
                if (vars.length > 0) {
                  setVarPrompt({ name: q.name, sql: q.sql, vars });
                  return;
                }
              }
              openSavedQuery(q.id);
            }}
            onDelete={() => void deleteSavedQuery(q.id)}
          />
        ))}
      </div>

      <PanelFooter>
        Saved queries are scoped to this connection and persist across restarts.
      </PanelFooter>

      <SnippetVarsDialog
        open={Boolean(varPrompt)}
        varNames={varPrompt?.vars ?? []}
        onCancel={() => setVarPrompt(null)}
        onConfirm={(values) => {
          if (!varPrompt) return;
          const filled = applySnippetVars(varPrompt.sql, values);
          // Open as a fresh SQL tab and run it. We don't mutate the saved
          // query — the snippet stays parametric for the next call.
          addTab();
          // After addTab the new tab is active; setSql + runQuery target it.
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

function SavedQueryRow({
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

  return (
    <div className="group/saved flex items-start gap-2 border-b border-border px-3 py-2 last:border-b-0 hover:bg-accent/30">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-start gap-2 text-left"
        title={isTable ? `${query.tableSchema}.${query.tableName}` : query.sql}
      >
        {isTable ? (
          <Database className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <FileCode className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">{query.name}</div>
          {isTable ? (
            <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
              <span className="font-mono">
                {query.tableSchema}.{query.tableName}
              </span>
              {query.filters.length > 0 && (
                <Pill>
                  {query.filters.length} filter{query.filters.length === 1 ? '' : 's'}
                </Pill>
              )}
              {query.sort.length > 0 && <Pill>sorted</Pill>}
              {query.hidden.length > 0 && <Pill>{query.hidden.length} hidden</Pill>}
              {query.sticky.length > 0 && <Pill>{query.sticky.length} pinned</Pill>}
            </div>
          ) : (
            <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
              {query.sql.replace(/\s+/g, ' ').trim().slice(0, 80) || '(empty)'}
            </div>
          )}
        </div>
      </button>
      {confirming ? (
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="destructive" size="sm" onClick={onDelete}>
            Delete
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setConfirming(true)}
          title="Delete"
          aria-label={`Delete ${query.name}`}
          className="opacity-0 transition-opacity group-hover/saved:opacity-100"
        >
          <Trash2 />
        </Button>
      )}
    </div>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-sm border border-border px-1 py-0.5 font-mono text-[9px] uppercase text-muted-foreground">
      {children}
    </span>
  );
}

// ───────────────────────── Shared bits ─────────────────────────

function PanelHeader({
  title,
  hint,
  onClose,
  children,
}: {
  title: string;
  hint?: string;
  onClose?: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-background pl-3 pr-2">
      <span className="truncate text-sm font-medium text-foreground">{title}</span>
      {hint && (
        <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
          {hint}
        </span>
      )}
      <div className="flex-1" />
      {children}
      {onClose && (
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onClose}
          aria-label="Close panel"
          title="Close"
        >
          <X />
        </Button>
      )}
    </div>
  );
}

function PanelFooter({ children }: { children: React.ReactNode }) {
  return (
    <div className="shrink-0 border-t border-border px-3 py-2 font-display text-[11px] italic text-muted-foreground">
      {children}
    </div>
  );
}

function PanelEmpty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
      <div className="font-display text-base italic text-foreground">{title}</div>
      {hint && <div className="font-display text-xs italic text-muted-foreground">{hint}</div>}
    </div>
  );
}
