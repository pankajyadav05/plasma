import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { AiPanel } from '@/features/ai/AiPanel';
import { MonacoEditor } from '@/features/editor/MonacoEditor';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { IconButton, MenuItem, Pill, Segmented } from '@/components/ui/workbench';
import { cn } from '@/lib/cn';
import { ipc } from '@/lib/ipc';
import { kbd } from '@/lib/platform';
import { buildRlsPoliciesSql } from '@/lib/table-query';
import { type RightPanelMode, useActiveTab, useSession } from '@/stores/session';
import { useWorkbench } from '@/stores/workbench';
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
  UserCircle,
  Wand2,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { SidebarSearch } from '@/features/sidebar/sidebar-parts';
import { DetailsPanel } from './DetailsPanel';

const PANEL_WIDTH = 260;

const NOOP = () => {};

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
  const setMode = useSession((s) => s.setRightPanelMode);
  const engine = useSession((s) => s.activeConfig?.engine ?? 'postgres');
  const tab = useActiveTab();
  const isTable = tab?.kind === 'table';
  const postgres = engine === 'postgres';
  const effective = mode === null ? null : postgres ? mode : 'ai';

  // RLS / compiled SQL are table-scoped — fall back to Details elsewhere.
  useEffect(() => {
    if ((mode === 'rls' || mode === 'query') && !isTable) setMode('details');
  }, [mode, isTable, setMode]);

  if (!effective) return null;

  const primary: PrimaryPane =
    effective === 'details' ? 'details' : effective === 'ai' ? 'ai' : 'none';

  return (
    <aside
      className="flex shrink-0 flex-col self-stretch border-l border-[var(--wb-separator)] bg-[var(--wb-sidebar)] text-[var(--wb-text)]"
      style={{ width: PANEL_WIDTH }}
      aria-label="Right sidebar"
    >
      <div className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-1.5 px-2.5 pb-2 pt-2">
        <span aria-hidden />
        {postgres ? (
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
        ) : (
          <span className="flex h-[26px] items-center rounded-[6px] bg-[var(--wb-segment-active)] px-3 text-[13px] font-medium text-[var(--wb-text)]">
            Assistant
          </span>
        )}
        <div className="flex justify-end">
          {postgres && (
            <SessionToolsMenu isTable={isTable} rlsCount={isTable ? tab.rlsPolicyCount : null} />
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {effective === 'query' && <QueryPanel />}
        {effective === 'ai' && <AiPanel />}
        {effective === 'details' && <DetailsPanel />}
        {effective === 'role' && <RolePanel />}
        {effective === 'rls' && <RlsPanel />}
      </div>
    </aside>
  );
}

function SessionToolsMenu({ isTable, rlsCount }: { isTable: boolean; rlsCount: number | null }) {
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
          label="Session tools — compiled SQL, role, row-level security"
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
        <MenuItem
          icon={<UserCircle />}
          label="Session role"
          hint={activeRole ?? 'default'}
          checked={mode === 'role' ? true : undefined}
          onClick={() => pick('role')}
        />
        <MenuItem
          icon={rlsCount === 0 ? <ShieldOff /> : rlsCount ? <ShieldCheck /> : <Shield />}
          label="Row-level security"
          hint={rlsCount === null ? undefined : `${rlsCount} polic${rlsCount === 1 ? 'y' : 'ies'}`}
          disabled={!isTable}
          checked={mode === 'rls' ? true : undefined}
          onClick={() => pick('rls')}
        />
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
  const hasApiKey = useSession((s) =>
    Boolean(
      s.settings.hasOpenrouterApiKey ||
        s.settings.hasClaudeApiKey ||
        s.settings.openrouterApiKey ||
        s.settings.claudeApiKey,
    ),
  );

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
      <PanelHeader title={tab.title} hint={isTable ? 'table' : undefined} onClose={close}>
        {!isTable && hasApiKey && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[13px] text-[var(--wb-text-2)]"
            title={`Open AI assistant (${kbd('L')})`}
            onClick={() => setMode('ai')}
          >
            <Sparkles className="h-3.5 w-3.5" />
            ask
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
          <Button variant="destructive" size="xs" className="h-6" onClick={handleAction}>
            <Square className="fill-current" />
            Cancel
            <Kbd className="border-0 bg-transparent text-destructive-foreground/80">{kbd('.')}</Kbd>
          </Button>
        ) : isTable ? (
          <Pill onClick={handleAction} disabled={!canRun}>
            <RefreshCw />
            Refresh
          </Pill>
        ) : (
          <Pill onClick={handleAction} disabled={!canRun}>
            <Play className="fill-current" />
            Run
            <Kbd className="border-0 bg-transparent text-[var(--wb-text-2)]">{kbd('⏎')}</Kbd>
          </Pill>
        )}
      </PanelHeader>

      <div className="relative min-h-0 flex-1 overflow-hidden pt-3">
        {isTable && (
          <div className="absolute left-4 top-1 z-10 text-[11px] text-[var(--wb-text-3)]">
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
        <span className="rounded-[4px] bg-[var(--wb-control)] px-1 py-0.5 font-mono text-[9px] uppercase text-[var(--wb-text-2)]">
          {p.cmd || 'ALL'}
        </span>
        {p.permissive === 'PERMISSIVE' && (
          <span className="rounded-[4px] bg-[var(--wb-control)] px-1 py-0.5 font-mono text-[9px] uppercase text-[var(--wb-text-2)]">
            permissive
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
  onClose,
  children,
}: {
  title: string;
  hint?: string;
  onClose?: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-[var(--wb-separator)] pl-3 pr-2">
      <span className="truncate text-[13px] font-semibold text-[var(--wb-text)]">{title}</span>
      {hint && (
        <span className="truncate rounded-[4px] bg-[var(--wb-control)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--wb-text-2)]">
          {hint}
        </span>
      )}
      <div className="flex-1" />
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
      <div className="text-[16px] text-[var(--wb-text-2)]">{title}</div>
      {hint && <div className="text-[12px] text-[var(--wb-text-3)]">{hint}</div>}
    </div>
  );
}
