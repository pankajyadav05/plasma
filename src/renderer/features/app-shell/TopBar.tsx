import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ToolbarButton, ToolbarDivider, ToolbarGroup } from '@/components/ui/workbench';
import { PendingEditsTable } from '@/features/result-grid/PendingEditsTable';
import { cn } from '@/lib/cn';
import { kbd } from '@/lib/platform';
import { useActiveTab, useSession } from '@/stores/session';
import type { ConnectionEngine, SavedConnection } from '@shared/protocol';
import {
  Activity,
  Boxes,
  Check,
  ChevronsUpDown,
  Command,
  Database,
  Eye,
  Layers,
  Loader2,
  Lock,
  PanelLeft,
  PanelRight,
  Pencil,
  Plus,
  RefreshCw,
  Undo2,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { BrandMark } from './BrandMark';
import { UpdateBadge } from './UpdateBadge';
import { WindowControls } from './WindowControls';

const isMac = window.plasma?.platform === 'darwin';

const ENGINE_ICON: Record<ConnectionEngine, typeof Database> = {
  postgres: Database,
  redis: Layers,
  opensearch: Boxes,
};

const ENGINE_LABEL: Record<ConnectionEngine, string> = {
  postgres: 'PostgreSQL',
  redis: 'Redis',
  opensearch: 'OpenSearch',
};

/** Native-looking graphite popover surface for the toolbar switchers. */
const POPOVER =
  'rounded-[10px] border-[var(--wb-toolbar-group-edge)] bg-[var(--wb-toolbar-group)] text-[13px] text-[var(--wb-text)] shadow-[0_10px_30px_rgb(0_0_0/0.35)]';

/** Hover row in a switcher popover (macOS menu highlight). */
const MENU_ROW =
  'flex w-full items-center gap-2 rounded-[5px] px-2 py-1 text-[13px] text-[var(--wb-text)] transition-none hover:bg-[var(--wb-accent)] hover:text-white';

/** Environment tag → capsule fill (TablePlus colours the whole capsule). */
const TAG_FILL: Record<string, string> = {
  local: 'var(--status-local)',
  dev: 'var(--status-dev)',
  staging: 'var(--status-staging)',
  prod: 'var(--status-prod)',
};

/**
 * Main toolbar — TablePlus anatomy on glass:
 *
 *   ●●●  [⊟]  [✕ 👁 ✓]  [🔒 ⛁ SQL]  ▐ PostgreSQL 16 : TLS : conn : db : schema / object ▌  [↻ ∿ ⌘]  [⊡]
 *
 * Left clusters: sidebar, pending-change review (discard / preview /
 * commit), and safety · database · new SQL. The capsule in the middle is
 * filled with the connection's environment colour. Right clusters:
 * reload, activity monitor, command palette, and the right sidebar.
 */
export function TopBar() {
  const connected = useSession((s) => s.connectionState === 'connected');
  const engine = useSession((s) => s.activeConfig?.engine ?? 'postgres');
  const overlayOpen = useSession(
    (s) =>
      s.dialogOpen ||
      s.paletteOpen ||
      s.settingsOpen ||
      s.historyOpen ||
      s.deleteConfirmConnectionId !== null,
  );

  return (
    <header
      className={cn(
        'topbar-pad relative z-20 flex h-[52px] shrink-0 items-center gap-2.5 border-b border-[var(--wb-separator)] bg-[var(--wb-window)]',
        overlayOpen ? 'pointer-events-none' : 'drag',
      )}
    >
      {!isMac && <BrandMark className="no-drag mx-1 h-5 w-5 shrink-0 text-foreground" />}

      {connected && <LeftClusters postgres={engine === 'postgres'} />}

      <StatusCapsule />

      <RightClusters connected={connected} />

      {!isMac && <WindowControls />}
    </header>
  );
}

// ───────────────────────── Left clusters ─────────────────────────

function LeftClusters({ postgres }: { postgres: boolean }) {
  const sidebarCollapsed = useSession((s) => s.settings.sidebarCollapsed);
  const toggleSidebar = useSession((s) => s.toggleSidebar);
  const txnState = useSession((s) => s.txnState);

  return (
    <>
      <ToolbarGroup>
        <ToolbarButton
          label={`${sidebarCollapsed ? 'Show' : 'Hide'} left sidebar (${kbd('B')})`}
          active={!sidebarCollapsed}
          onClick={() => void toggleSidebar()}
        >
          <PanelLeft />
        </ToolbarButton>
      </ToolbarGroup>

      {postgres && <ChangesCluster />}
      {postgres && txnState === 'active' && <TxnCluster />}
      <SessionCluster postgres={postgres} />
    </>
  );
}

/** Discard · Preview · Commit for buffered grid edits. */
function ChangesCluster() {
  const edits = useSession((s) => s.pendingEdits);
  const busy = useSession((s) => s.pendingEditsBusy);
  const commit = useSession((s) => s.commitPendingEdits);
  const revert = useSession((s) => s.revertPendingEdits);
  const [error, setError] = useState<string | null>(null);
  const has = edits.length > 0;

  const onCommit = async () => {
    setError(null);
    try {
      await commit();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <ToolbarGroup className={cn(has && 'ring-1 ring-[var(--wb-accent)]/50')}>
      <ToolbarButton
        label="Discard pending changes"
        disabled={!has || busy}
        onClick={() => {
          setError(null);
          void revert();
        }}
      >
        <X />
      </ToolbarButton>
      <Popover>
        <PopoverTrigger asChild>
          <ToolbarButton label="Preview pending changes" disabled={!has}>
            <Eye />
          </ToolbarButton>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={8}
          className={cn(POPOVER, 'w-[560px] max-w-[90vw] overflow-hidden p-0')}
        >
          <div className="border-b border-[var(--wb-separator)] px-3 py-2 text-[12px] text-[var(--wb-text-2)]">
            {edits.length} pending UPDATE{edits.length === 1 ? '' : 's'} — commits as one
            transaction
          </div>
          <PendingEditsTable edits={edits} />
        </PopoverContent>
      </Popover>
      <ToolbarButton
        label={has ? `Commit ${edits.length} change${edits.length === 1 ? '' : 's'}` : 'Commit'}
        disabled={!has || busy}
        tone={has ? 'accent' : 'default'}
        onClick={() => void onCommit()}
        data-testid="toolbar-commit"
      >
        {busy ? <Loader2 className="animate-spin" /> : <Check />}
      </ToolbarButton>
      {has && (
        <span className="px-1.5 font-mono text-[11px] font-semibold tabular-nums text-[var(--wb-accent)]">
          {edits.length}
        </span>
      )}
      {error && (
        <span
          className="px-1 text-[11px] font-medium text-destructive"
          title={`Commit failed: ${error}`}
          role="alert"
        >
          failed
        </span>
      )}
    </ToolbarGroup>
  );
}

function TxnCluster() {
  const commitTxn = useSession((s) => s.commitTxn);
  const rollbackTxn = useSession((s) => s.rollbackTxn);
  return (
    <ToolbarGroup className="ring-1 ring-[var(--status-staging)]">
      <span className="px-2 text-[12px] font-medium text-[var(--wb-text)]" data-testid="status-txn">
        Transaction open
      </span>
      <ToolbarDivider />
      <ToolbarButton label="Commit transaction" tone="accent" onClick={() => void commitTxn()}>
        <Check />
      </ToolbarButton>
      <ToolbarButton label="Roll back transaction" onClick={() => void rollbackTxn()}>
        <Undo2 />
      </ToolbarButton>
    </ToolbarGroup>
  );
}

/** Safety (read-only / edit) · database switcher · new SQL tab. */
function SessionCluster({ postgres }: { postgres: boolean }) {
  const activeConfig = useSession((s) => s.activeConfig);
  const editMode = useSession((s) => s.editMode);
  const toggleEditMode = useSession((s) => s.toggleEditMode);
  const addTab = useSession((s) => s.addTab);
  const canvasMode = useSession((s) => s.canvasMode);
  const setCanvasMode = useSession((s) => s.setCanvasMode);
  const readOnlyConn = Boolean(activeConfig?.readOnly);

  return (
    <ToolbarGroup>
      <ToolbarButton
        label={
          readOnlyConn
            ? 'Read-only connection — writes are disabled'
            : editMode
              ? 'Edit mode — writes enabled. Click to lock.'
              : 'Safe mode — read only. Click to allow edits.'
        }
        disabled={readOnlyConn}
        active={editMode && !readOnlyConn}
        tone={editMode && !readOnlyConn ? 'accent' : 'default'}
        onClick={toggleEditMode}
        data-testid="toolbar-safety"
      >
        {editMode && !readOnlyConn ? <Pencil /> : <Lock />}
      </ToolbarButton>
      <ConnectionSwitcher
        trigger={
          <ToolbarButton label="Switch connection or database">
            <Database />
          </ToolbarButton>
        }
      />
      {postgres && (
        <ToolbarButton
          label={`New SQL query (${kbd('T')})`}
          onClick={() => {
            if (canvasMode !== 'database') setCanvasMode('database');
            addTab();
          }}
        >
          <span className="text-[10px] font-semibold tracking-wide">SQL</span>
        </ToolbarButton>
      )}
    </ToolbarGroup>
  );
}

// ───────────────────────── Right clusters ─────────────────────────

function RightClusters({ connected }: { connected: boolean }) {
  const togglePalette = useSession((s) => s.togglePalette);
  const refreshSchema = useSession((s) => s.refreshSchema);
  const refreshTable = useSession((s) => s.refreshTable);
  const schemaLoading = useSession((s) => s.schemaLoading);
  const canvasMode = useSession((s) => s.canvasMode);
  const setCanvasMode = useSession((s) => s.setCanvasMode);
  const rightPanelMode = useSession((s) => s.rightPanelMode);
  const setRightPanelMode = useSession((s) => s.setRightPanelMode);
  const engine = useSession((s) => s.activeConfig?.engine ?? 'postgres');
  const tab = useActiveTab();
  const postgres = engine === 'postgres';

  return (
    <>
      <ToolbarGroup>
        {connected && (
          <ToolbarButton
            label="Reload schema and current table"
            disabled={schemaLoading}
            onClick={() => {
              void refreshSchema();
              if (tab?.kind === 'table') void refreshTable();
            }}
          >
            <RefreshCw className={schemaLoading ? 'animate-spin' : ''} />
          </ToolbarButton>
        )}
        {connected && postgres && (
          <ToolbarButton
            label="Live activity (pg_stat_activity)"
            active={canvasMode === 'monitor'}
            onClick={() => setCanvasMode(canvasMode === 'monitor' ? 'database' : 'monitor')}
          >
            <Activity />
          </ToolbarButton>
        )}
        <ToolbarButton label={`Open anything (${kbd('K')})`} onClick={togglePalette}>
          <Command />
        </ToolbarButton>
      </ToolbarGroup>

      <UpdateBadge />

      {connected && canvasMode === 'database' && (
        <ToolbarGroup>
          <ToolbarButton
            label={`${rightPanelMode ? 'Hide' : 'Show'} right sidebar (${kbd('⇧B')})`}
            active={Boolean(rightPanelMode)}
            onClick={() => setRightPanelMode(rightPanelMode ? null : postgres ? 'details' : 'ai')}
          >
            <PanelRight />
          </ToolbarButton>
        </ToolbarGroup>
      )}
    </>
  );
}

// ───────────────────────── Status capsule ─────────────────────────

function StatusCapsule() {
  const activeConfig = useSession((s) => s.activeConfig);
  const connectionState = useSession((s) => s.connectionState);
  const serverVersion = useSession((s) => s.serverVersion);
  const tag = useSession((s) =>
    activeConfig?.id ? s.settings.connectionTags?.[activeConfig.id] : undefined,
  );
  const viaSsh = useSession((s) =>
    Boolean(activeConfig?.id && s.settings.connectionSsh?.[activeConfig.id]),
  );
  const tab = useActiveTab();
  const canvasMode = useSession((s) => s.canvasMode);

  const engine = activeConfig?.engine ?? 'postgres';
  const connected = connectionState === 'connected';
  // Connected = TablePlus green, whatever the env tag (the tag still
  // shows as a chip). Prod keeps its red fill so a production session is
  // never mistaken for a safe one. Disconnected/connecting stay neutral.
  const fill = connected
    ? tag === 'prod'
      ? 'var(--status-prod)'
      : 'var(--status-local)'
    : undefined;
  const surface = fill ?? 'var(--status-none)';
  const stateLabel =
    connectionState === 'connected'
      ? 'connected'
      : connectionState === 'connecting'
        ? 'connecting'
        : connectionState === 'error'
          ? 'error'
          : 'disconnected';

  const transport = activeConfig?.ssl
    ? `TLS${activeConfig.tls?.mode === 'insecure' ? ' (unverified)' : ''}`
    : viaSsh
      ? 'SSH'
      : 'No TLS';

  const object =
    canvasMode !== 'database'
      ? canvasMode === 'monitor'
        ? 'Activity'
        : canvasMode === 'history'
          ? 'History'
          : canvasMode === 'settings'
            ? 'Settings'
            : null
      : tab
        ? tab.kind === 'table' && tab.tableName
          ? tab.tableName
          : tab.title
        : null;

  return (
    <div
      className={cn(
        'no-drag flex h-9 min-w-0 flex-1 items-center overflow-hidden rounded-full px-4 font-mono text-[13px] font-semibold leading-none',
        'shadow-[inset_0_1px_0_rgb(255_255_255/0.08)]',
        fill ? 'text-white' : 'text-[var(--wb-text)]',
      )}
      style={{ backgroundColor: surface }}
      data-testid="status-capsule"
    >
      <span className="sr-only" data-testid="status-connection">
        {stateLabel}
      </span>

      {!connected && (
        <span
          className={cn(
            'mr-2 inline-block h-2 w-2 shrink-0 rounded-full',
            connectionState === 'connecting'
              ? 'animate-pulse bg-[var(--wb-accent)]'
              : connectionState === 'error'
                ? 'bg-destructive'
                : 'bg-muted-foreground',
          )}
          aria-hidden
        />
      )}

      {activeConfig && connected ? (
        <span className="flex min-w-0 items-center">
          <Seg>{shortVersion(serverVersion, engine)}</Seg>
          <Sep />
          <Seg
            title={
              activeConfig.ssl
                ? 'Encrypted with TLS'
                : viaSsh
                  ? 'Tunnelled over SSH'
                  : 'Unencrypted connection'
            }
          >
            {transport}
          </Seg>
          <Sep />
          <ConnectionSwitcher
            trigger={
              <CapsuleButton title="Switch connection">
                <span className="truncate">{activeConfig.name}</span>
              </CapsuleButton>
            }
          />
          {activeConfig.database && (
            <>
              <Sep />
              <Seg>{activeConfig.database}</Seg>
            </>
          )}
          {engine === 'postgres' && <SchemaSwitcher />}
          {object && (
            <>
              <span className="shrink-0 whitespace-pre opacity-60" aria-hidden>
                {' / '}
              </span>
              <Seg>{object}</Seg>
              {tab?.queryRunState === 'running' && canvasMode === 'database' && (
                <Loader2 className="ml-1.5 h-3 w-3 shrink-0 animate-spin opacity-80" />
              )}
            </>
          )}
          {tag && (
            <span className="ml-2.5 shrink-0 rounded-[4px] bg-black/20 px-1.5 py-[3px] font-sans text-[10px] font-semibold uppercase tracking-wider">
              {tag}
            </span>
          )}
        </span>
      ) : (
        <ConnectionSwitcher
          trigger={
            <CapsuleButton title="Connect to a database">
              <span className="truncate">
                {connectionState === 'connecting'
                  ? `Connecting to ${activeConfig?.name ?? 'database'}…`
                  : 'Not connected — open a connection'}
              </span>
            </CapsuleButton>
          }
        />
      )}
    </div>
  );
}

function Seg({
  children,
  title,
  className,
}: {
  children: React.ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <span className={cn('min-w-0 shrink truncate whitespace-nowrap', className)} title={title}>
      {children}
    </span>
  );
}

function Sep() {
  return (
    <span className="shrink-0 whitespace-pre opacity-60" aria-hidden>
      {' : '}
    </span>
  );
}

function CapsuleButton({
  children,
  title,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      title={title}
      className="group/cap -mx-1 flex min-w-0 shrink items-center gap-0.5 rounded-[5px] px-1 py-1 font-semibold transition-colors hover:bg-black/15"
      {...props}
    >
      {children}
      <ChevronsUpDown className="hidden h-3 w-3 shrink-0 opacity-70 group-hover/cap:inline-block group-focus-visible/cap:inline-block" />
    </button>
  );
}

function ConnectionSwitcher({ trigger }: { trigger: React.ReactElement }) {
  const activeConfig = useSession((s) => s.activeConfig);
  const savedConnections = useSession((s) => s.savedConnections);
  const connectionState = useSession((s) => s.connectionState);
  const openDialog = useSession((s) => s.openDialog);
  const [filter, setFilter] = useState('');

  const q = filter.trim().toLowerCase();
  const list = q
    ? savedConnections.filter(
        (c) => c.name.toLowerCase().includes(q) || c.host.toLowerCase().includes(q),
      )
    : savedConnections;

  return (
    <Popover onOpenChange={(o) => !o && setFilter('')}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="start" sideOffset={8} className={cn(POPOVER, 'w-[360px] p-1.5')}>
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search connections…"
          aria-label="Search connections"
          className="mb-1 h-[26px] w-full rounded-[7px] border-0 bg-[var(--wb-field)] px-2.5 text-[13px] text-[var(--wb-text)] outline-none ring-1 ring-[var(--wb-toolbar-group-edge)] placeholder:text-[var(--wb-text-3)] focus:ring-[var(--wb-accent)]"
        />
        <div className="max-h-[340px] overflow-y-auto">
          {list.length === 0 && (
            <div className="px-2 py-2 text-[13px] text-[var(--wb-text-2)]">
              {savedConnections.length === 0 ? 'No saved connections yet' : 'No matches'}
            </div>
          )}
          {list.map((c) => (
            <ConnectionRow
              key={c.id}
              c={c}
              active={activeConfig?.id === c.id}
              disabled={connectionState === 'connecting'}
            />
          ))}
        </div>
        <div className="my-1 h-px bg-[var(--wb-toolbar-group-edge)]" />
        <button type="button" onClick={() => openDialog()} className={MENU_ROW}>
          <Plus className="h-3.5 w-3.5" />
          New connection…
        </button>
      </PopoverContent>
    </Popover>
  );
}

function ConnectionRow({
  c,
  active,
  disabled,
}: {
  c: SavedConnection;
  active: boolean;
  disabled: boolean;
}) {
  const connectSaved = useSession((s) => s.connectSaved);
  const editConnection = useSession((s) => s.editConnection);
  const tag = useSession((s) => s.settings.connectionTags?.[c.id]);
  const Icon = ENGINE_ICON[c.engine ?? 'postgres'];

  return (
    <div
      className={cn(
        'group/row flex items-center rounded-[5px] transition-colors hover:bg-[var(--wb-control-hover)]',
        active && 'bg-[var(--wb-control)]',
        disabled && 'opacity-50',
      )}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          if (!active && !disabled) void connectSaved(c.id);
        }}
        title={active ? 'Connected' : `Connect to ${c.name}`}
        className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1.5 text-left"
      >
        <span
          className="grid h-7 w-7 shrink-0 place-items-center rounded-[7px] text-white"
          style={{ backgroundColor: (tag && TAG_FILL[tag]) || 'var(--status-none)' }}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-[var(--wb-text)]">
            {c.name}
          </span>
          <span className="block truncate font-mono text-[11px] text-[var(--wb-text-2)]">
            {c.host}:{c.port}
            {c.database ? ` / ${c.database}` : ''}
          </span>
        </span>
        {active && <Check className="h-3.5 w-3.5 shrink-0 text-[var(--wb-accent)]" />}
      </button>
      <button
        type="button"
        onClick={() => void editConnection(c.id)}
        aria-label={`Edit ${c.name}`}
        title="Edit connection"
        className="mr-1 grid h-6 w-6 shrink-0 place-items-center rounded-[5px] text-[var(--wb-text-2)] opacity-0 transition-opacity hover:text-[var(--wb-text)] focus-visible:opacity-100 group-hover/row:opacity-100"
      >
        <Pencil className="h-3 w-3" />
      </button>
    </div>
  );
}

function SchemaSwitcher() {
  const schema = useSession((s) => s.schema);
  const currentSchema = useSession((s) => s.currentSchema);
  const setCurrentSchema = useSession((s) => s.setCurrentSchema);
  const list = schema?.schemas ?? [];
  const value = currentSchema ?? list[0]?.name ?? null;
  if (!value) return null;
  return (
    <>
      <Sep />
      <Popover>
        <PopoverTrigger asChild>
          <CapsuleButton title="Switch schema">
            <span className="truncate">{value}</span>
          </CapsuleButton>
        </PopoverTrigger>
        <PopoverContent align="start" sideOffset={8} className={cn(POPOVER, 'w-[240px] p-1.5')}>
          <div className="px-2 pb-1 text-[11px] font-medium text-[var(--wb-text-2)]">Schemas</div>
          <div className="max-h-[300px] overflow-y-auto">
            {list.map((s) => (
              <button
                key={s.name}
                type="button"
                onClick={() => setCurrentSchema(s.name)}
                className={cn(MENU_ROW, 'font-mono')}
              >
                <span className="grid w-3 place-items-center">
                  {s.name === value && <Check className="h-3 w-3" />}
                </span>
                <span className="truncate">{s.name}</span>
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}

function shortVersion(full: string | null, engine: ConnectionEngine): string {
  if (!full) return ENGINE_LABEL[engine];
  const m = full.match(/^(PostgreSQL\s+[\d.]+)/);
  if (m) return m[1];
  // Redis / OpenSearch report bare versions ("7.2.4") — prefix the engine.
  if (/^\d/.test(full)) return `${ENGINE_LABEL[engine]} ${full.split(/\s/)[0]}`;
  return full.length > 32 ? `${full.slice(0, 32)}…` : full;
}
