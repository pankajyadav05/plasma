import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { IconButton, MenuItem, Pill, Segmented } from '@/components/ui/workbench';
import { SidebarResizer } from '@/features/app-shell/SidebarResizer';
import { MonacoEditor } from '@/features/editor/MonacoEditor';
import { SidebarSearch } from '@/features/sidebar/sidebar-parts';
import { aiConfigured } from '@/lib/ai-config';
import { cn } from '@/lib/cn';
import { ipc } from '@/lib/ipc';
import { lazyNamed } from '@/lib/lazy';
import { kbd } from '@/lib/platform';
import { buildRlsPoliciesSql } from '@/lib/table-query';
import { type RightPanelMode, useActiveTab, useSession } from '@/stores/session';
import { useWorkbench } from '@/stores/workbench';
import { engineCaps } from '@shared/sql-dialect';
import {
  Bookmark,
  Check,
  Code2,
  Loader2,
  MoreHorizontal,
  Play,
  RefreshCw,
  Shield,
  ShieldCheck,
  ShieldOff,
  Sparkles,
  Square,
  Table2,
  UserCircle,
  Wand2,
  X,
} from 'lucide-react';
import { Suspense, useEffect, useState } from 'react';
import { DetailsPanel } from './DetailsPanel';

const AiPanel = lazyNamed(() => import('@/features/ai/AiPanel'), 'AiPanel');

const NOOP = () => {};

/** Below this window width the right sidebar starts collapsed (VF19). */
export const NARROW_WINDOW_PX = 1200;
/** Width the right sidebar is held to while the window is narrow. */
const NARROW_RIGHT_WIDTH = 260;

/**
 * Tracks whether the window is narrow and auto-hides the right sidebar
 * once each time the window becomes narrow (or starts narrow). Reopening
 * it with ⇧⌘B while narrow sticks — the collapse only fires on the
 * wide → narrow transition.
 */
let narrowCollapseDone = false;
function useNarrowWindow(): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth < NARROW_WINDOW_PX);
  useEffect(() => {
    const check = () => {
      const isNarrow = window.innerWidth < NARROW_WINDOW_PX;
      setNarrow(isNarrow);
      if (!isNarrow) {
        narrowCollapseDone = false;
        return;
      }
      if (narrowCollapseDone) return;
      narrowCollapseDone = true;
      const st = useSession.getState();
      if (st.rightPanelMode) st.setRightPanelMode(null);
    };
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);
  return narrow;
}

type PrimaryPane = 'details' | 'ai' | 'none';

/**
 * Right sidebar, TablePlus layout: a Details | Assistant segmented header
 * over the pane. Postgres session tools (compiled SQL, session role, RLS
 * policies) live in the header's ⋯ menu rather than a second icon rail.
 * Shown/hidden from the toolbar (⇧⌘B); Redis / OpenSearch only get the
 * Assistant.
 */
export function RightRail() {
  const mode = useSession((s) => s.rightPanelMode);
  const width = useSession((s) => s.settings.rightSidebarWidth);
  const setMode = useSession((s) => s.setRightPanelMode);
  const engine = useSession((s) => s.activeConfig?.engine ?? 'postgres');
  const tab = useActiveTab();
  const isTable = tab?.kind === 'table';
  const caps = engineCaps(engine);
  const postgres = caps.sql;
  const narrow = useNarrowWindow();
  // Details + Assistant exist for every engine (Redis elements and
  // OpenSearch documents publish into Details too); the Postgres session
  // tools (compiled SQL, role, RLS) fall back to Details elsewhere.
  const effective =
    mode === null
      ? null
      : mode === 'details' || mode === 'ai' || (postgres && mode === 'query')
        ? mode
        : (mode === 'role' && caps.roles) || (mode === 'rls' && caps.pgExtras)
          ? mode
          : 'details';

  // RLS / compiled SQL are table-scoped — fall back to Details elsewhere.
  useEffect(() => {
    if ((mode === 'rls' || mode === 'query') && !isTable) setMode('details');
  }, [mode, isTable, setMode]);

  if (!effective) return null;

  const primary: PrimaryPane =
    effective === 'details' ? 'details' : effective === 'ai' ? 'ai' : 'none';

  return (
    <>
      {/* Drag handle over the sidebar's left border (width persisted). */}
      <SidebarResizer side="right" />
      <aside
        className="flex shrink-0 flex-col self-stretch border-l border-[var(--wb-separator)] bg-[var(--wb-sidebar)] text-[var(--wb-text)]"
        style={{ width: narrow ? Math.min(width, NARROW_RIGHT_WIDTH) : width }}
        aria-label="Right sidebar"
      >
        <div className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-1.5 px-2.5 pb-2 pt-2">
          <span aria-hidden />
          <Segmented<PrimaryPane>
            ariaLabel="Right sidebar pane"
            variant="plain"
            value={primary}
            onChange={(v) => setMode(v === 'none' ? 'details' : v)}
            options={[
              { value: 'details', label: 'Details' },
              { value: 'ai', label: 'Assistant', title: `Assistant (${kbd('L')})` },
            ]}
          />
          <div className="flex justify-end">
            {postgres && (
              <SessionToolsMenu
                isTable={isTable}
                rlsCount={isTable ? tab.rlsPolicyCount : null}
                roles={caps.roles}
                rls={caps.pgExtras}
              />
            )}
          </div>
        </div>
        <div className="min-h-0 flex-1">
          {effective === 'query' && <QueryPanel />}
          {effective === 'ai' && (
            <Suspense fallback={null}>
              <AiPanel />
            </Suspense>
          )}
          {effective === 'details' && <DetailsPanel />}
          {effective === 'role' && <RolePanel />}
          {effective === 'rls' && <RlsPanel />}
        </div>
      </aside>
    </>
  );
}

function SessionToolsMenu({
  isTable,
  rlsCount,
  roles,
  rls,
}: {
  isTable: boolean;
  rlsCount: number | null;
  roles: boolean;
  rls: boolean;
}) {
  const mode = useSession((s) => s.rightPanelMode);
  const setMode = useSession((s) => s.setRightPanelMode);
  const activeRole = useSession((s) => s.activeRole);
  const [open, setOpen] = useState(false);
  const pick = (m: NonNullable<RightPanelMode>) => {
    setOpen(false);
    setMode(m);
  };
  const secondary = mode === 'query' || mode === 'role' || mode === 'rls';
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton
          variant="plain"
          label={
            roles
              ? 'Session tools — compiled SQL, role, row-level security'
              : 'Session tools — compiled SQL'
          }
          active={secondary}
          className="[&_svg]:h-4 [&_svg]:w-4"
        >
          <MoreHorizontal />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-[240px] p-1" role="menu">
        <MenuItem
          icon={<Code2 />}
          label="Compiled SQL"
          disabled={!isTable}
          checked={mode === 'query' ? true : undefined}
          onClick={() => pick('query')}
        />
        {roles && (
          <MenuItem
            icon={<UserCircle />}
            label="Session role"
            hint={activeRole ?? 'default'}
            checked={mode === 'role' ? true : undefined}
            onClick={() => pick('role')}
          />
        )}
        {rls && (
          <MenuItem
            icon={rlsCount === 0 ? <ShieldOff /> : rlsCount ? <ShieldCheck /> : <Shield />}
            label="Row-level security"
            hint={
              rlsCount === null ? undefined : `${rlsCount} polic${rlsCount === 1 ? 'y' : 'ies'}`
            }
            disabled={!isTable}
            checked={mode === 'rls' ? true : undefined}
            onClick={() => pick('rls')}
          />
        )}
      </PopoverContent>
    </Popover>
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
  const setSidebarMode = useWorkbench((s) => s.setSidebarMode);
  const formatActiveSql = useSession((s) => s.formatActiveSql);
  const theme = useSession((s) => s.settings.theme);
  const fontSize = useSession((s) => s.settings.editorFontSize);
  const hasApiKey = useSession((s) => aiConfigured(s.settings));

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

  const close = () => setMode('details');

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title={tab.title}
        icon={
          isTable ? <Table2 className="h-3.5 w-3.5" aria-label="Table" role="img" /> : undefined
        }
        onClose={close}
      >
        {!isTable && hasApiKey && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[13px] text-[var(--wb-text-2)]"
            title={`Open AI assistant (${kbd('L')})`}
            onClick={() => setMode('ai')}
          >
            <Sparkles className="h-3.5 w-3.5" />
            Ask
          </Button>
        )}
        {!isTable && (
          <IconButton
            variant="plain"
            label="Format SQL"
            title={`Format SQL (${kbd('⇧F')})`}
            onClick={() => void formatActiveSql()}
          >
            <Wand2 />
          </IconButton>
        )}
        <IconButton
          variant="plain"
          label="Show saved queries"
          title="Saved queries (left sidebar)"
          onClick={() => setSidebarMode('queries')}
        >
          <Bookmark />
        </IconButton>
        {running ? (
          <Pill onClick={handleAction}>
            <Square className="fill-current" />
            Cancel
            <Kbd className="bg-transparent">{kbd('.')}</Kbd>
          </Pill>
        ) : isTable ? (
          <Pill onClick={handleAction} disabled={!canRun}>
            <RefreshCw />
            Refresh
          </Pill>
        ) : (
          <Pill onClick={handleAction} disabled={!canRun}>
            <Play className="fill-current" />
            Run
            <Kbd className="bg-transparent">{kbd('⏎')}</Kbd>
          </Pill>
        )}
      </PanelHeader>

      <div className="relative min-h-0 flex-1 overflow-hidden pt-3">
        {isTable && (
          <div className="absolute left-4 top-1 z-10 text-[11px] text-[var(--wb-text-3)]">
            Compiled from the table browser — read-only
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
          hideOverviewRuler
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
  const roleError = useSession((s) => s.roleError);
  const setMode = useSession((s) => s.setRightPanelMode);
  const [filter, setFilter] = useState('');

  const list = availableRoles.filter((r) => r.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Session role"
        hint={activeRole ? `SET ROLE ${activeRole}` : 'default'}
        onClose={() => setMode('details')}
      />

      <div className="flex px-2.5 py-2">
        <SidebarSearch
          value={filter}
          onChange={setFilter}
          placeholder="Filter roles…"
          ariaLabel="Filter roles"
        />
      </div>

      {roleError && (
        <div
          role="alert"
          data-testid="role-error"
          className="mx-2.5 mb-1 rounded-[6px] bg-[color-mix(in_srgb,var(--destructive)_14%,transparent)] px-2.5 py-1.5 text-[12px] leading-snug text-[var(--wb-text)]"
        >
          {roleError}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        <RoleRow
          label="default"
          note="reset"
          active={activeRole === null}
          onClick={() => void setActiveRole(null)}
        />
        {list.length === 0 && availableRoles.length > 0 && (
          <div className="px-3 py-3 text-[13px] text-[var(--wb-text-2)]">no matches</div>
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
          <div className="px-3 py-3 text-[13px] text-[var(--wb-text-2)]">no roles loaded</div>
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
        'flex h-6 w-full cursor-pointer items-center gap-2 rounded-[5px] px-2 text-left text-[13px] text-[var(--wb-text)] transition-colors duration-150',
        active
          ? 'bg-[var(--wb-selected)]'
          : 'hover:bg-[color-mix(in_srgb,var(--wb-text)_6%,transparent)]',
      )}
    >
      {active ? (
        <Check className="h-3 w-3 text-[var(--wb-text)]" />
      ) : (
        <span className="h-3 w-3" aria-hidden />
      )}
      <span className="font-mono text-[12px]">{label}</span>
      {note && <span className="ml-auto text-[11px] text-[var(--wb-text-3)]">{note}</span>}
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
        <PanelHeader title="Row-level security" onClose={() => setMode('details')} />
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
        onClose={() => setMode('details')}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && (
          <div className="flex h-full items-center justify-center text-[var(--wb-text-2)]">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="ml-2 text-[13px]">loading policies…</span>
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
    <div className="border-b border-[var(--wb-separator)] px-3 py-2 last:border-b-0">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[12px] font-semibold text-[var(--wb-text)]">{p.name}</span>
        <span className="rounded-[4px] bg-[var(--wb-control)] px-1 py-0.5 font-mono text-[10px] text-[var(--wb-text-2)]">
          {p.cmd || 'ALL'}
        </span>
        {p.permissive === 'PERMISSIVE' && (
          <span className="rounded-[4px] bg-[var(--wb-control)] px-1 py-0.5 font-mono text-[10px] text-[var(--wb-text-2)]">
            Permissive
          </span>
        )}
        <span className="ml-auto font-mono text-[10px] text-[var(--wb-text-3)]">{p.roles}</span>
      </div>
      {p.qual && (
        <div className="mt-1">
          <div className="text-[11px] font-semibold text-[var(--wb-text-2)]">USING</div>
          <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[12px] text-[var(--wb-text)]">
            {p.qual}
          </pre>
        </div>
      )}
      {p.withCheck && (
        <div className="mt-1">
          <div className="text-[11px] font-semibold text-[var(--wb-text-2)]">WITH CHECK</div>
          <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[12px] text-[var(--wb-text)]">
            {p.withCheck}
          </pre>
        </div>
      )}
    </div>
  );
}

// ───────────────────────── Shared bits ─────────────────────────

function PanelHeader({
  title,
  hint,
  icon,
  onClose,
  children,
}: {
  title: string;
  hint?: string;
  /** Small kind glyph after the title (VF27: an icon instead of a pill). */
  icon?: React.ReactNode;
  onClose?: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-[var(--wb-separator)] pl-3 pr-2">
      {/* VF27: the title block takes the free space and truncates last. */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <span
          className="min-w-0 truncate text-[13px] font-semibold text-[var(--wb-text)]"
          title={title}
        >
          {title}
        </span>
        {icon && (
          <span className="grid shrink-0 place-items-center text-[var(--wb-text-3)]">{icon}</span>
        )}
        {hint && (
          <span
            className="min-w-0 truncate rounded-[4px] bg-[var(--wb-control)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--wb-text-2)]"
            title={hint}
          >
            {hint}
          </span>
        )}
      </div>
      {children}
      {onClose && (
        <IconButton variant="plain" label="Close panel" title="Close" onClick={onClose}>
          <X />
        </IconButton>
      )}
    </div>
  );
}

function PanelFooter({ children }: { children: React.ReactNode }) {
  return (
    <div className="shrink-0 border-t border-[var(--wb-separator)] px-3 py-2 text-[11px] text-[var(--wb-text-3)]">
      {children}
    </div>
  );
}

function PanelEmpty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
      <div className="text-[15px] text-[var(--wb-text-2)]">{title}</div>
      {hint && <div className="text-[12px] text-[var(--wb-text-3)]">{hint}</div>}
    </div>
  );
}
