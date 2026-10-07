import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ToolbarButton, ToolbarDivider, ToolbarGroup } from '@/components/ui/workbench';
import {
  hostLabel,
  usePresentationWindowTitle,
  usePresenting,
} from '@/features/presentation/presentation';
import { PendingEditsTable } from '@/features/result-grid/PendingEditsTable';
import { cn } from '@/lib/cn';
import { ENGINE_ICON, databaseLabel, shortServerVersion } from '@/lib/engine-meta';
import { kbd } from '@/lib/platform';
import { useReconnect } from '@/stores/reconnect';
import { useActiveTabSelect, useSession } from '@/stores/session';
import { editsOf, summarizeEdits } from '@/stores/session-pending-edits';
import type { SavedConnection } from '@shared/protocol';
import { engineCaps } from '@shared/sql-dialect';
import {
  Activity,
  Check,
  ChevronsUpDown,
  Command,
  Database,
  Eye,
  Loader2,
  Lock,
  PanelLeft,
  PanelRight,
  Pencil,
  Plus,
  RefreshCw,
  RotateCw,
  ShieldCheck,
  Undo2,
  Unplug,
  X,
} from 'lucide-react';
import { forwardRef, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BrandMark } from './BrandMark';
import { LiveAnnouncer } from './LiveAnnouncer';
import { UpdateBadge } from './UpdateBadge';
import { UpdateToasts } from './UpdateToasts';
import { WindowControls } from './WindowControls';

const isMac = window.plasma?.platform === 'darwin';

/** Native-looking graphite popover surface for the toolbar switchers. */
const POPOVER =
  'rounded-[10px] border-[var(--wb-toolbar-group-edge)] bg-[var(--wb-toolbar-group)] text-[13px] text-[var(--wb-text)] shadow-[0_10px_30px_rgb(0_0_0/0.35)]';

/** Hover row in a switcher popover (macOS menu highlight, AA white text). */
const MENU_ROW =
  'flex w-full items-center gap-2 rounded-[5px] px-2 py-1 text-[13px] text-[var(--wb-text)] transition-none hover:bg-[var(--wb-accent-fill)] hover:text-white focus-visible:bg-[var(--wb-accent-fill)] focus-visible:text-white focus-visible:outline-none';

/** Environment tag → chip / connection-icon fill. */
const TAG_FILL: Record<string, string> = {
  local: 'var(--status-local)',
  dev: 'var(--status-dev)',
  staging: 'var(--status-staging)',
  prod: 'var(--status-prod)',
};

const TAG_LABEL: Record<string, string> = {
  local: 'Local',
  dev: 'Dev',
  staging: 'Staging',
  prod: 'PROD',
};

/**
 * How many low-priority capsule segments to hide when the capsule is too
 * narrow: 1 = transport (TLS/SSH), 2 = + server version, 3 = + schema.
 * Only after all three are gone do the remaining segments truncate (F8).
 */
const MAX_CAPSULE_DROP = 3;

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
    (s) => s.paletteOpen || s.settingsOpen || s.historyOpen || s.deleteConfirmConnectionId !== null,
  );

  return (
    <header
      className={cn(
        'topbar-pad relative z-20 flex h-[52px] shrink-0 items-center gap-2.5 border-b border-[var(--wb-separator)] bg-[var(--wb-window)]',
        overlayOpen ? 'pointer-events-none' : 'drag',
      )}
    >
      {!isMac && <BrandMark className="no-drag mx-1 h-5 w-5 shrink-0 text-foreground" />}

      {connected && <LeftClusters sql={engineCaps(engine).sql} />}

      <StatusCapsule />

      <RightClusters connected={connected} />

      {!isMac && <WindowControls />}
      <LiveAnnouncer />
      <UpdateToasts />
    </header>
  );
}

// ───────────────────────── Left clusters ─────────────────────────

function LeftClusters({ sql }: { sql: boolean }) {
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

      {sql && <ChangesCluster />}
      {sql && txnState === 'active' && <TxnCluster />}
      <SessionCluster sql={sql} />
    </>
  );
}

/**
 * Discard · Preview · Commit for buffered grid edits. Contextual, like the
 * transaction cluster: it only appears while the active tab has staged
 * edits (or a commit is running / just failed), so the toolbar isn't
 * carrying three dead buttons the rest of the time.
 */
function ChangesCluster() {
  // Edits are per tab: the toolbar shows / commits / discards the ACTIVE tab's.
  const edits = useSession((s) => editsOf(s.pendingEditsByTab, s.activeTabId));
  const busy = useSession((s) => s.pendingEditsBusy);
  const commit = useSession((s) => s.commitPendingEdits);
  const revert = useSession((s) => s.revertPendingEdits);
  // Commit failures live in the store (the grid points at the failing cell).
  const error = useSession((s) =>
    !s.pendingEditsError?.tabId || s.pendingEditsError.tabId === s.activeTabId
      ? (s.pendingEditsError?.message ?? null)
      : null,
  );
  const canDetectConflicts = useSession((s) => engineCaps(s.activeConfig?.engine).editConflicts);
  const has = edits.length > 0;
  if (!has && !busy && !error) return null;

  const onCommit = async () => {
    try {
      await commit();
    } catch {
      // surfaced via pendingEditsError (grid banner + this badge)
    }
  };

  return (
    <ToolbarGroup className={cn(has && 'ring-1 ring-[var(--wb-accent)]/50')}>
      <ToolbarButton
        label="Discard pending changes"
        disabled={!has || busy}
        onClick={() => void revert()}
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
            {summarizeEdits(edits)} — commits as one transaction ({kbd('S')})
          </div>
          {!canDetectConflicts && (
            <div className="border-b border-[var(--wb-separator)] px-3 py-2 text-[12px] text-[var(--wb-text-2)]">
              Conflicts cannot be detected on this engine. If someone else changed these rows after
              you loaded them, your changes overwrite theirs.
            </div>
          )}
          {error && (
            <div
              className="border-b border-[var(--wb-separator)] px-3 py-2 text-[12px] text-destructive"
              role="alert"
            >
              Commit failed: {error}
            </div>
          )}
          <PendingEditsTable edits={edits} />
        </PopoverContent>
      </Popover>
      <ToolbarButton
        label={has ? `Commit ${edits.length} change${edits.length === 1 ? '' : 's'}` : 'Commit'}
        title={
          error
            ? `Commit failed: ${error}`
            : has
              ? `Commit ${edits.length} change${edits.length === 1 ? '' : 's'} (${kbd('S')})`
              : 'Commit'
        }
        disabled={!has || busy}
        tone={error ? 'danger' : has ? 'accent' : 'default'}
        onClick={() => void onCommit()}
        data-testid="toolbar-commit"
      >
        {busy ? <Loader2 className="animate-spin" /> : <Check />}
      </ToolbarButton>
      {/* Fixed-width count slot so the capsule never shifts (VF14). */}
      <span
        className={cn(
          'w-7 text-center font-mono text-[11px] font-semibold tabular-nums',
          error ? 'text-destructive' : 'text-[var(--wb-accent-text)]',
        )}
        role={error ? 'alert' : undefined}
        aria-label={error ? `Commit failed: ${error}` : undefined}
        title={error ? `Commit failed: ${error}` : undefined}
      >
        {has ? (edits.length > 99 ? '99+' : edits.length) : ''}
      </span>
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
function SessionCluster({ sql }: { sql: boolean }) {
  const activeConfig = useSession((s) => s.activeConfig);
  const editMode = useSession((s) => s.editMode);
  const toggleEditMode = useSession((s) => s.toggleEditMode);
  const addTab = useSession((s) => s.addTab);
  const canvasMode = useSession((s) => s.canvasMode);
  const setCanvasMode = useSession((s) => s.setCanvasMode);
  const readOnlyConn =
    Boolean(activeConfig?.readOnly) || !engineCaps(activeConfig?.engine).rowEdits;
  const noRowEdits = !engineCaps(activeConfig?.engine).rowEdits;

  return (
    <ToolbarGroup>
      <ToolbarButton
        label={
          noRowEdits
            ? 'Rows are read-only for this engine — write SQL in the editor instead'
            : readOnlyConn
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
      {sql && (
        <ToolbarButton
          label={`New SQL query (${kbd('T')})`}
          onClick={() => {
            if (canvasMode !== 'database') setCanvasMode('database');
            addTab();
          }}
        >
          <span className="text-[10px] font-semibold">SQL</span>
        </ToolbarButton>
      )}
    </ToolbarGroup>
  );
}

// ───────────────────────── Right clusters ─────────────────────────

function RightClusters({ connected }: { connected: boolean }) {
  const togglePalette = useSession((s) => s.togglePalette);
  const presenting = usePresenting();
  const updateSettings = useSession((s) => s.updateSettings);
  const refreshSchema = useSession((s) => s.refreshSchema);
  const refreshTable = useSession((s) => s.refreshTable);
  const schemaLoading = useSession((s) => s.schemaLoading);
  const canvasMode = useSession((s) => s.canvasMode);
  const setCanvasMode = useSession((s) => s.setCanvasMode);
  const rightPanelMode = useSession((s) => s.rightPanelMode);
  const setRightPanelMode = useSession((s) => s.setRightPanelMode);
  const engine = useSession((s) => s.activeConfig?.engine ?? 'postgres');
  const activeKind = useActiveTabSelect((t) => t?.kind);
  const activity = engineCaps(engine).activity || engine === 'redis' || engine === 'opensearch';

  return (
    <>
      <ToolbarGroup>
        {connected && (
          <ToolbarButton
            label="Reload schema and current table"
            disabled={schemaLoading}
            onClick={() => {
              void refreshSchema();
              if (activeKind === 'table') void refreshTable();
            }}
          >
            <RefreshCw className={schemaLoading ? 'animate-spin' : ''} />
          </ToolbarButton>
        )}
        {connected && activity && (
          <ToolbarButton
            label="Health advisor"
            active={canvasMode === 'monitor'}
            onClick={() => setCanvasMode(canvasMode === 'monitor' ? 'database' : 'monitor')}
          >
            <Activity />
          </ToolbarButton>
        )}
        <ToolbarButton
          label={`${presenting ? 'Turn off' : 'Turn on'} presentation mode (${kbd('⇧M')})`}
          active={presenting}
          tone={presenting ? 'accent' : 'default'}
          onClick={() => void updateSettings({ presentationMode: !presenting })}
          data-testid="presentation-toggle"
        >
          <ShieldCheck />
        </ToolbarButton>
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
            onClick={() => setRightPanelMode(rightPanelMode ? null : 'details')}
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
  usePresentationWindowTitle();
  const presenting = usePresenting();
  const activeConfig = useSession((s) => s.activeConfig);
  const connectionState = useSession((s) => s.connectionState);
  const serverVersion = useSession((s) => s.serverVersion);
  const tag = useSession((s) =>
    activeConfig?.id ? s.settings.connectionTags?.[activeConfig.id] : undefined,
  );
  const viaSsh = useSession((s) =>
    Boolean(activeConfig?.id && s.settings.connectionSsh?.[activeConfig.id]),
  );
  const tab = useActiveTabSelect((t) =>
    t
      ? { kind: t.kind, tableName: t.tableName, title: t.title, queryRunState: t.queryRunState }
      : undefined,
  );
  const canvasMode = useSession((s) => s.canvasMode);

  const engine = activeConfig?.engine ?? 'postgres';
  const caps = engineCaps(engine);
  const redisDb = useSession((s) => s.redisDb);
  // Redis can switch logical db at runtime; the config only holds the initial one.
  const dbLabel =
    engine === 'redis' ? String(redisDb ?? 0) : activeConfig ? databaseLabel(activeConfig) : '';
  const connected = connectionState === 'connected';
  // Connected = a neutral surface faintly tinted with the theme accent, text
  // --wb-text; the env tag shows as a coloured chip. Only PROD fills the
  // whole capsule red (white text) so a production session is never
  // mistaken for a safe one — and nothing else reads as "danger" (F9).
  const prodFill = connected && tag === 'prod';
  const surface = prodFill
    ? 'var(--status-prod)'
    : connected
      ? 'var(--wb-connected)'
      : 'var(--status-none)';
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
        ? 'Health'
        : canvasMode === 'history'
          ? 'History'
          : canvasMode === 'settings'
            ? 'Settings'
            : canvasMode === 'connections'
              ? 'Connections'
              : null
      : tab
        ? tab.kind === 'table' && tab.tableName
          ? tab.tableName
          : tab.kind === 'sql' && !caps.sql
            ? 'Overview' // Redis / OpenSearch placeholder tab (see TabStrip)
            : tab.title
        : null;

  const { outerRef, innerRef, drop } = useCapsuleFit(
    [serverVersion, transport, activeConfig?.name, dbLabel, object, tag, connected].join('\u0000'),
  );

  return (
    <div
      ref={outerRef}
      className={cn(
        'no-drag flex h-9 min-w-0 flex-1 items-center overflow-hidden rounded-full px-4 font-mono text-[13px] font-semibold leading-none',
        'shadow-[inset_0_1px_0_rgb(255_255_255/0.08)]',
        prodFill ? 'text-white' : 'text-[var(--wb-text)]',
      )}
      style={{ backgroundColor: surface }}
      data-testid="status-capsule"
    >
      <span className="sr-only" data-testid="status-connection">
        {stateLabel}
      </span>

      {activeConfig && connected ? (
        <span ref={innerRef} className="flex min-w-0 items-center">
          {drop < 2 && (
            <>
              <Seg>{shortVersion(serverVersion, engine)}</Seg>
              <Sep />
            </>
          )}
          {drop < 1 && engine !== 'sqlite' && engine !== 'duckdb' && (
            <>
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
            </>
          )}
          <ConnectionSwitcher
            trigger={
              <CapsuleButton title="Switch connection">
                <span className="truncate">{activeConfig.name}</span>
              </CapsuleButton>
            }
          />
          {dbLabel && !(engine === 'duckdb' && dbLabel === activeConfig.name) && (
            <>
              <Sep />
              <Seg
                title={
                  (engine === 'sqlite' || engine === 'duckdb') && !presenting
                    ? (activeConfig.duckdb?.files ?? [])
                        .concat(activeConfig.database)
                        .filter((f) => f && f !== ':memory:')
                        .join('\n') || activeConfig.database
                    : undefined
                }
              >
                {presenting && (engine === 'sqlite' || engine === 'duckdb') ? 'database' : dbLabel}
              </Seg>
            </>
          )}
          {caps.schemaSwitcher && drop < 3 && <SchemaSwitcher />}
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
            <span
              className={cn(
                'ml-2.5 shrink-0 rounded-[4px] px-1.5 py-[3px] font-sans text-[11px] font-semibold text-white',
                prodFill && 'bg-black/25',
              )}
              style={prodFill ? undefined : { backgroundColor: TAG_FILL[tag] }}
              data-testid="status-tag"
            >
              {TAG_LABEL[tag] ?? tag}
            </span>
          )}
        </span>
      ) : (
        <OfflineCapsule />
      )}
    </div>
  );
}

/**
 * Capsule body while not connected. Shows what the reconnect machine is
 * doing and makes the whole capsule a reconnect button:
 *
 *   ● Connection to Resilinc Admin lost — retrying in 4s        Reconnect now  ⇅
 *   ◌ Reconnecting to Resilinc Admin… (attempt 2)                               ⇅
 *   ● Couldn't reach Resilinc Admin — click to reconnect                        ⇅
 *   ● Not connected — click to connect to Resilinc Admin                        ⇅
 *
 * The trailing ⇅ always opens the connection switcher.
 */
function OfflineCapsule() {
  const connectionState = useSession((s) => s.connectionState);
  const activeConfig = useSession((s) => s.activeConfig);
  const savedConnections = useSession((s) => s.savedConnections);
  const lastId = useSession((s) => s.settings.lastConnectionId);
  const target = useReconnect((s) => s.target);
  const phase = useReconnect((s) => s.phase);
  const reason = useReconnect((s) => s.reason);
  const attempt = useReconnect((s) => s.attempt);
  const nextAt = useReconnect((s) => s.nextAt);
  const lastError = useReconnect((s) => s.lastError);
  const reconnectNow = useReconnect((s) => s.reconnectNow);
  const start = useReconnect((s) => s.start);
  const now = useNow(phase === 'waiting' ? 1000 : null);

  // With no retry in progress, still offer the last connection by name.
  const last = !target ? savedConnections.find((c) => c.id === lastId) : undefined;
  const busy = phase === 'connecting' || connectionState === 'connecting';
  const name = target?.name ?? last?.name ?? activeConfig?.name;

  let label: string;
  let dot: string;
  let onClick: (() => void) | null = null;
  if (busy) {
    label =
      target && reason !== 'manual' && attempt > 0
        ? `Reconnecting to ${name}… (attempt ${attempt + 1})`
        : `Connecting to ${name ?? 'database'}…`;
    dot = 'animate-pulse bg-[var(--wb-accent)]';
  } else if (target && phase === 'waiting') {
    const secs = nextAt ? Math.max(0, Math.ceil((nextAt - now) / 1000)) : 0;
    label = `Connection to ${target.name} lost — retrying in ${secs}s`;
    dot = 'bg-[var(--status-staging)]';
    onClick = () => void reconnectNow();
  } else if (target && phase === 'failed') {
    label =
      reason === 'launch'
        ? `Couldn't connect to ${target.name} — click to retry`
        : `Couldn't reach ${target.name} — click to reconnect`;
    dot = 'bg-destructive';
    onClick = () => void reconnectNow();
  } else if (last) {
    label = `Not connected — click to connect to ${last.name}`;
    dot = 'bg-[var(--wb-text-3)]';
    onClick = () => start({ id: last.id, name: last.name }, 'manual');
  } else {
    label = 'Not connected — open a connection';
    dot = 'bg-[var(--wb-text-3)]';
  }

  const body = (
    <>
      {busy ? (
        <Loader2 className="mr-2 h-3.5 w-3.5 shrink-0 animate-spin opacity-80" aria-hidden />
      ) : (
        <span className={cn('mr-2 inline-block h-2 w-2 shrink-0 rounded-full', dot)} aria-hidden />
      )}
      <span className="truncate">{label}</span>
    </>
  );

  return (
    <span className="flex min-w-0 flex-1 items-center">
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          title={lastError ? `${label}\n\nLast error: ${lastError}` : label}
          className="-ml-1 flex min-w-0 flex-1 items-center rounded-full px-1 py-1 text-left hover:bg-black/10 dark:hover:bg-white/10"
          data-testid="reconnect-button"
        >
          {body}
          {phase === 'waiting' && (
            <span className="ml-auto shrink-0 pl-3 font-sans text-[12px] font-medium opacity-80">
              Reconnect now
            </span>
          )}
        </button>
      ) : (
        <span className="flex min-w-0 flex-1 items-center" title={label}>
          {body}
        </span>
      )}
      <ConnectionSwitcher
        trigger={
          <button
            type="button"
            aria-label="Switch connection"
            title="Switch connection"
            className="ml-1 grid h-6 w-6 shrink-0 place-items-center rounded-full opacity-70 hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10"
          >
            <ChevronsUpDown className="h-3.5 w-3.5" />
          </button>
        }
      />
    </span>
  );
}

/**
 * Measures the capsule and returns how many low-priority segments to drop
 * (see MAX_CAPSULE_DROP). Re-measures from zero whenever the capsule width
 * or its content changes, then drops one more segment per layout pass
 * while any segment is still truncated — all before paint.
 */
function useCapsuleFit(contentKey: string) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(0);
  const [drop, setDrop] = useState(0);
  const measured = useRef<string | null>(null);

  useLayoutEffect(() => {
    const el = outerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      setWidth((prev) => (prev === w ? prev : w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const key = `${width}|${contentKey}`;
    if (measured.current !== key) {
      measured.current = key;
      if (drop !== 0) {
        setDrop(0);
        return;
      }
    }
    const inner = innerRef.current;
    if (!inner || drop >= MAX_CAPSULE_DROP) return;
    const truncated = Array.from(inner.querySelectorAll<HTMLElement>('.truncate')).some(
      (seg) => seg.scrollWidth > seg.clientWidth + 1,
    );
    if (truncated) setDrop(drop + 1);
  }, [width, contentKey, drop]);

  return { outerRef, innerRef, drop };
}

/** Re-render every `intervalMs` (null = paused); returns Date.now(). */
function useNow(intervalMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs === null) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
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

/**
 * Clickable capsule segment. Forwards its ref: it is used as a Radix
 * `PopoverTrigger asChild`, which needs the DOM node to open and anchor
 * the popover (without it, clicking the connection name did nothing).
 */
const CapsuleButton = forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
  ({ children, title, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      title={title}
      className="group/cap -mx-1 flex min-w-0 shrink items-center gap-0.5 rounded-[5px] px-1 py-1 font-semibold transition-colors hover:bg-black/15"
      {...props}
    >
      {children}
      <ChevronsUpDown className="hidden h-3 w-3 shrink-0 opacity-70 group-hover/cap:inline-block group-focus-visible/cap:inline-block" />
    </button>
  ),
);
CapsuleButton.displayName = 'CapsuleButton';

function ConnectionSwitcher({ trigger }: { trigger: React.ReactElement }) {
  const activeConfig = useSession((s) => s.activeConfig);
  const savedConnections = useSession((s) => s.savedConnections);
  const connectionState = useSession((s) => s.connectionState);
  const openDialog = useSession((s) => s.openDialog);
  const connectSaved = useSession((s) => s.connectSaved);
  const disconnect = useSession((s) => s.disconnect);
  const retrying = useReconnect((s) => s.target !== null);
  const cancelReconnect = useReconnect((s) => s.cancel);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  // Menu actions close the menu first, then act.
  const act = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  const q = filter.trim().toLowerCase();
  const list = q
    ? savedConnections.filter(
        (c) => c.name.toLowerCase().includes(q) || c.host.toLowerCase().includes(q),
      )
    : savedConnections;

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setFilter('');
      }}
    >
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
              onPick={() => setOpen(false)}
            />
          ))}
        </div>
        <div className="my-1 h-px bg-[var(--wb-toolbar-group-edge)]" />
        {activeConfig && connectionState === 'connected' && (
          <button
            type="button"
            onClick={act(() => void connectSaved(activeConfig.id))}
            className={MENU_ROW}
            title="Open a fresh session to the current connection"
          >
            <RotateCw className="h-3.5 w-3.5" />
            Reconnect to {activeConfig.name}
          </button>
        )}
        {activeConfig && connectionState === 'connected' && (
          <button
            type="button"
            onClick={act(() => void disconnect())}
            className={MENU_ROW}
            title="Close the session. Staged grid edits are confirmed first."
            data-testid="switcher-disconnect"
          >
            <Unplug className="h-3.5 w-3.5" />
            Disconnect from {activeConfig.name}
          </button>
        )}
        {retrying && connectionState !== 'connected' && (
          <button
            type="button"
            onClick={act(() => {
              cancelReconnect();
              void disconnect();
            })}
            className={MENU_ROW}
            title="Stop the automatic reconnect attempts"
            data-testid="switcher-stop-reconnect"
          >
            <Unplug className="h-3.5 w-3.5" />
            Stop reconnecting
          </button>
        )}
        <button type="button" onClick={act(() => openDialog())} className={MENU_ROW}>
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
  onPick,
}: {
  c: SavedConnection;
  active: boolean;
  disabled: boolean;
  /** Closes the menu. */
  onPick: () => void;
}) {
  const connectSaved = useSession((s) => s.connectSaved);
  const editConnection = useSession((s) => s.editConnection);
  const tag = useSession((s) => s.settings.connectionTags?.[c.id]);
  const presenting = usePresenting();
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
          if (active || disabled) return;
          onPick();
          void connectSaved(c.id);
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
            {hostLabel(presenting, c.host, c.port)}
            {c.database ? ` / ${c.database}` : ''}
          </span>
        </span>
        {active && <Check className="h-3.5 w-3.5 shrink-0 text-[var(--wb-accent-text)]" />}
      </button>
      <button
        type="button"
        onClick={() => {
          onPick();
          void editConnection(c.id);
        }}
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

const shortVersion = shortServerVersion;
