import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/cn';
import { kbd } from '@/lib/platform';
import { type TabKind, useActiveTab, useSession } from '@/stores/session';
import type { ConnectionEngine, SavedConnection } from '@shared/protocol';
import {
  AlertCircle,
  Boxes,
  Check,
  ChevronsUpDown,
  Database,
  FileCode,
  KeyRound,
  Layers,
  Loader2,
  Lock,
  LockOpen,
  PanelLeft,
  PanelLeftClose,
  PanelRight,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  Table2,
} from 'lucide-react';
import { useState } from 'react';
import { BrandMark } from './BrandMark';
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

/**
 * Environment tag → capsule tint. Mirrors the picker in
 * ConnectionDialog; a prod connection should be unmistakable from
 * across the room (TablePlus colour-codes the whole status capsule).
 */
const TAG_CAPSULE: Record<string, string> = {
  local: 'border-border',
  dev: 'border-border',
  staging: 'border-primary/60 bg-primary/5',
  prod: 'border-destructive bg-destructive/10',
};

const TAG_CHIP: Record<string, string> = {
  local: 'bg-foreground text-background',
  dev: 'bg-secondary text-secondary-foreground',
  staging: 'bg-primary text-primary-foreground',
  prod: 'bg-destructive text-destructive-foreground',
};

/**
 * Main toolbar, TablePlus anatomy:
 *
 *   [◆][⊟]   ┌ ■ PostgreSQL 16.2 · TLS │ conn ▾ / db / schema ▾ / object ┐   [changes][safe][⊡]
 *
 * Left: brand + sidebar toggle. Centre: the status capsule — engine and
 * version, transport security, connection switcher, database, schema
 * switcher and the active object — tinted by the environment tag.
 * Right: pending-change review (only while edits are buffered), the
 * write-safety toggle, and the right-sidebar toggle.
 */
export function TopBar() {
  const activeConfig = useSession((s) => s.activeConfig);
  const sidebarCollapsed = useSession((s) => s.settings.sidebarCollapsed);
  const toggleSidebar = useSession((s) => s.toggleSidebar);
  const connected = useSession((s) => s.connectionState === 'connected');

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
        'topbar-pad relative z-20 flex h-11 items-center gap-1 border-b bg-background',
        overlayOpen ? 'pointer-events-none' : 'drag',
      )}
    >
      <div className="no-drag flex shrink-0 items-center gap-0.5 pl-1">
        <BrandMark className="mx-1 h-5 w-5 text-foreground" />
        {connected && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void toggleSidebar()}
            aria-label={sidebarCollapsed ? 'Show left sidebar' : 'Hide left sidebar'}
            title={`${sidebarCollapsed ? 'Show' : 'Hide'} left sidebar (${kbd('B')})`}
          >
            {sidebarCollapsed ? <PanelLeft /> : <PanelLeftClose />}
          </Button>
        )}
      </div>

      <div className="flex min-w-0 flex-1 justify-center px-2">
        <StatusCapsule />
      </div>

      <div className="no-drag flex shrink-0 items-center gap-1 pr-1">
        {activeConfig && <PendingChangesGroup />}
        {activeConfig && <SafetyToggle />}
        {connected && <ToolbarActions />}
      </div>

      {!isMac && <WindowControls />}
    </header>
  );
}

// ───────────────────────── Status capsule ─────────────────────────

function StatusCapsule() {
  const activeConfig = useSession((s) => s.activeConfig);
  const connectionState = useSession((s) => s.connectionState);
  const serverVersion = useSession((s) => s.serverVersion);
  const togglePalette = useSession((s) => s.togglePalette);
  const tag = useSession((s) =>
    activeConfig?.id ? s.settings.connectionTags?.[activeConfig.id] : undefined,
  );
  const viaSsh = useSession((s) =>
    Boolean(activeConfig?.id && s.settings.connectionSsh?.[activeConfig.id]),
  );

  const engine = activeConfig?.engine ?? 'postgres';
  const EngineIcon = ENGINE_ICON[engine];

  const dotClass =
    connectionState === 'connected'
      ? 'bg-[var(--type-str)]'
      : connectionState === 'connecting'
        ? 'bg-primary animate-pulse'
        : connectionState === 'error'
          ? 'bg-destructive'
          : 'bg-muted-foreground';

  return (
    <div
      className={cn(
        'no-drag flex h-8 min-w-0 max-w-[880px] flex-1 items-center rounded-md border bg-card/70 text-xs',
        (tag && TAG_CAPSULE[tag]) || 'border-border',
      )}
      data-testid="status-capsule"
    >
      {/* Engine · version · transport */}
      <div className="flex shrink-0 items-center gap-2 border-r border-border/70 px-2.5">
        <span
          className={cn('inline-block h-2 w-2 shrink-0 rounded-[1px]', dotClass)}
          title={connectionState}
        />
        <EngineIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="whitespace-nowrap font-mono text-[11px] text-foreground">
          {activeConfig
            ? shortVersion(serverVersion, engine)
            : connectionState === 'connecting'
              ? 'connecting…'
              : 'not connected'}
        </span>
        {activeConfig && connectionState === 'connected' && (
          <TransportBadge ssl={activeConfig.ssl} tlsMode={activeConfig.tls?.mode} ssh={viaSsh} />
        )}
        {tag && (
          <span
            className={cn(
              'rounded-sm px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider',
              TAG_CHIP[tag] ?? 'bg-muted text-muted-foreground',
            )}
          >
            {tag}
          </span>
        )}
      </div>

      {/* Connection / database / schema / object */}
      <div className="flex min-w-0 flex-1 items-center">
        <ConnectionSwitcher />
        {activeConfig && (
          <>
            <Crumb />
            <DatabaseCrumb />
            {engine === 'postgres' && (
              <>
                <Crumb />
                <SchemaSwitcher />
              </>
            )}
            <ActiveObjectCrumb />
          </>
        )}
      </div>

      <button
        type="button"
        onClick={togglePalette}
        className="flex h-full shrink-0 items-center gap-1.5 border-l border-border/70 px-2.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title={`Open anything (${kbd('K')})`}
        aria-label="Open command palette"
      >
        <Search className="h-3.5 w-3.5" />
        <span className="font-mono text-[10px]">{kbd('K')}</span>
      </button>
    </div>
  );
}

function TransportBadge({
  ssl,
  tlsMode,
  ssh,
}: {
  ssl: boolean;
  tlsMode?: string;
  ssh: boolean;
}) {
  const label = ssl ? 'TLS' : ssh ? 'SSH' : 'plain';
  const title = ssl
    ? `Encrypted with TLS${tlsMode ? ` (${tlsMode})` : ''}${ssh ? ', over an SSH tunnel' : ''}`
    : ssh
      ? 'Tunnelled over SSH (no TLS to the server)'
      : 'Unencrypted connection';
  const Icon = ssl ? ShieldCheck : ssh ? KeyRound : LockOpen;
  return (
    <span
      className={cn(
        'flex items-center gap-1 font-mono text-[10px] uppercase',
        ssl || ssh ? 'text-muted-foreground' : 'text-destructive',
      )}
      title={title}
      data-testid="status-transport"
    >
      <Icon className="h-3 w-3" />
      {label}
    </span>
  );
}

function Crumb() {
  return (
    <span className="shrink-0 px-0.5 text-muted-foreground/50" aria-hidden>
      /
    </span>
  );
}

function ConnectionSwitcher() {
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
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex h-7 min-w-0 shrink items-center gap-1.5 rounded-sm px-2 transition-colors hover:bg-accent',
            !activeConfig && 'text-muted-foreground',
          )}
          title="Switch connection"
        >
          {activeConfig ? (
            <span className="truncate font-medium text-foreground">{activeConfig.name}</span>
          ) : (
            <span className="font-display italic">Connect to a database</span>
          )}
          <ChevronsUpDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-[340px] p-1">
        <div className="p-1">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search connections…"
            aria-label="Search connections"
            className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
          />
        </div>
        <div className="max-h-[320px] overflow-y-auto">
          {list.length === 0 && (
            <div className="px-2 py-2 font-display text-xs italic text-muted-foreground">
              {savedConnections.length === 0 ? 'no saved connections yet' : 'no matches'}
            </div>
          )}
          {list.map((c) => (
            <ConnectionPickerRow
              key={c.id}
              c={c}
              active={activeConfig?.id === c.id}
              disabled={connectionState === 'connecting'}
            />
          ))}
        </div>
        <div className="my-1 h-px bg-border" />
        <button
          type="button"
          onClick={() => openDialog()}
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-foreground transition-colors hover:bg-accent"
        >
          <Plus className="h-3.5 w-3.5 text-muted-foreground" />
          New connection…
        </button>
      </PopoverContent>
    </Popover>
  );
}

function DatabaseCrumb() {
  const activeConfig = useSession((s) => s.activeConfig);
  const editConnection = useSession((s) => s.editConnection);
  if (!activeConfig?.database) return null;
  return (
    <button
      type="button"
      onClick={() => void editConnection(activeConfig.id)}
      title="Database (bound to the connection — click to edit)"
      className="flex h-7 min-w-0 shrink items-center gap-1.5 rounded-sm px-2 transition-colors hover:bg-accent"
    >
      <Database className="h-3 w-3 shrink-0 text-muted-foreground" />
      <span className="truncate font-mono text-foreground">{activeConfig.database}</span>
    </button>
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
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-7 min-w-0 shrink items-center gap-1.5 rounded-sm px-2 transition-colors hover:bg-accent"
          title="Switch schema"
        >
          <span className="truncate font-mono text-foreground">{value}</span>
          <ChevronsUpDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-[240px] p-1">
        <div className="px-2 py-1 font-display text-[11px] italic text-muted-foreground">
          Schemas
        </div>
        <div className="max-h-[280px] overflow-y-auto">
          {list.map((s) => (
            <button
              key={s.name}
              type="button"
              onClick={() => setCurrentSchema(s.name)}
              className={cn(
                'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 font-mono text-xs',
                s.name === value
                  ? 'bg-accent text-accent-foreground'
                  : 'text-foreground hover:bg-accent hover:text-accent-foreground',
              )}
            >
              {s.name === value ? (
                <Check className="h-3 w-3 text-primary" />
              ) : (
                <span className="h-3 w-3" aria-hidden />
              )}
              <span className="truncate">{s.name}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

const OBJECT_ICON: Partial<Record<TabKind, typeof Table2>> = {
  sql: FileCode,
  table: Table2,
};

/** The object the active tab is looking at — table name or SQL file. */
function ActiveObjectCrumb() {
  const tab = useActiveTab();
  const canvasMode = useSession((s) => s.canvasMode);
  if (!tab || canvasMode !== 'database') return null;
  const Icon = OBJECT_ICON[tab.kind] ?? FileCode;
  const label = tab.kind === 'table' && tab.tableName ? tab.tableName : tab.title;
  return (
    <>
      <Crumb />
      <span
        className="flex min-w-0 shrink items-center gap-1.5 px-2 text-foreground"
        title={tab.kind === 'table' ? `${tab.tableSchema}.${tab.tableName}` : tab.title}
      >
        <Icon className="h-3 w-3 shrink-0 text-primary" />
        <span className="truncate font-mono">{label}</span>
        {tab.queryRunState === 'running' && (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
        )}
      </span>
    </>
  );
}

function ConnectionPickerRow({
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
        'group/row relative flex w-full items-stretch rounded-sm transition-colors',
        active
          ? 'bg-accent text-accent-foreground'
          : 'hover:bg-accent hover:text-accent-foreground',
        disabled && 'opacity-50',
      )}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          if (!active && !disabled) void connectSaved(c.id);
        }}
        title={active ? 'Active' : `Connect to ${c.name}`}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-xs"
      >
        {active ? (
          <Check className="h-3 w-3 shrink-0 text-primary" />
        ) : (
          <span className="h-3 w-3 shrink-0" aria-hidden />
        )}
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{c.name}</span>
          <span className="block truncate font-mono text-[10px] text-muted-foreground">
            {c.host}:{c.port}
            {c.database ? `/${c.database}` : ''}
          </span>
        </span>
        {tag && (
          <span
            className={cn(
              'shrink-0 rounded-sm px-1 py-px text-[9px] font-semibold uppercase tracking-wider',
              TAG_CHIP[tag] ?? 'bg-muted text-muted-foreground',
            )}
          >
            {tag}
          </span>
        )}
      </button>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={(e) => {
          e.stopPropagation();
          void editConnection(c.id);
        }}
        aria-label={`Edit ${c.name}`}
        title="Edit (delete inside)"
        className="mr-1 h-5 w-5 self-center opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 focus-visible:opacity-100"
      >
        <Pencil />
      </Button>
    </div>
  );
}

// ───────────────────────── Right-hand groups ─────────────────────────

/**
 * Discard / review / commit for buffered grid edits — TablePlus keeps
 * this in the toolbar so pending work is visible from any tab. Only
 * rendered while something is pending; the tray above the status bar
 * still carries the per-edit diff.
 */
function PendingChangesGroup() {
  const edits = useSession((s) => s.pendingEdits);
  const busy = useSession((s) => s.pendingEditsBusy);
  const commit = useSession((s) => s.commitPendingEdits);
  const revert = useSession((s) => s.revertPendingEdits);
  const [error, setError] = useState<string | null>(null);
  if (edits.length === 0) return null;
  const onCommit = async () => {
    setError(null);
    try {
      await commit();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <div
      className="flex h-8 items-center gap-0.5 rounded-md border border-primary/50 bg-primary/5 pl-2 pr-0.5"
      data-testid="toolbar-pending-changes"
    >
      <span className="mr-1 font-display text-xs italic text-foreground">
        <span className="font-mono font-semibold not-italic text-primary">{edits.length}</span>{' '}
        change{edits.length === 1 ? '' : 's'}
      </span>
      {error && (
        <span className="mx-1 text-destructive" title={`Commit failed: ${error}`} role="alert">
          <AlertCircle className="h-3.5 w-3.5" aria-label={`Commit failed: ${error}`} />
        </span>
      )}
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={() => void revert()}
        disabled={busy}
        aria-label="Discard pending changes"
        title="Discard pending changes"
      >
        <RotateCcw />
      </Button>
      <Button
        variant="primary"
        size="xs"
        onClick={() => void onCommit()}
        disabled={busy}
        title="Commit pending changes (one transaction)"
        className="h-6"
      >
        {busy ? <Loader2 className="animate-spin" /> : <Check />}
        Commit
      </Button>
    </div>
  );
}

/** Read-only ⇄ edit toggle — Plasma's equivalent of TablePlus Safe Mode. */
function SafetyToggle() {
  const activeConfig = useSession((s) => s.activeConfig);
  const editMode = useSession((s) => s.editMode);
  const toggleEditMode = useSession((s) => s.toggleEditMode);
  if (!activeConfig) return null;
  if (activeConfig.readOnly) {
    return (
      <Button
        variant="outline"
        size="xs"
        disabled
        title="This connection is read-only — writes are disabled"
      >
        <Lock />
        Read only
      </Button>
    );
  }
  return (
    <Button
      variant={editMode ? 'primary' : 'outline'}
      size="xs"
      onClick={toggleEditMode}
      title={editMode ? 'Writes enabled — click to lock' : 'Read-only — click to enable writes'}
      data-testid="toolbar-safety"
    >
      {editMode ? <Pencil /> : <Lock />}
      {editMode ? 'Edit mode' : 'Read only'}
    </Button>
  );
}

function ToolbarActions() {
  const rightPanelMode = useSession((s) => s.rightPanelMode);
  const setRightPanelMode = useSession((s) => s.setRightPanelMode);
  const canvasMode = useSession((s) => s.canvasMode);
  const engine = useSession((s) => s.activeConfig?.engine ?? 'postgres');
  const isPostgres = engine === 'postgres';

  return (
    <>
      {canvasMode === 'database' && (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setRightPanelMode(rightPanelMode ? null : isPostgres ? 'details' : 'ai')}
          aria-label={rightPanelMode ? 'Hide right sidebar' : 'Show right sidebar'}
          title={rightPanelMode ? 'Hide right sidebar' : 'Show right sidebar (Details)'}
          className={rightPanelMode ? 'text-primary' : undefined}
        >
          <PanelRight />
        </Button>
      )}
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
