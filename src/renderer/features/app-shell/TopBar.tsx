import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/cn';
import { useSession } from '@/stores/session';
import type { SavedConnection } from '@shared/protocol';
import { Check, ChevronsUpDown, Database, Lock, Pencil, Plus } from 'lucide-react';
import { BrandMark } from './BrandMark';
import { WindowControls } from './WindowControls';

const isMac = window.plasma?.platform === 'darwin';

/**
 * Top bar — connection breadcrumb on the left, edit-mode + window
 * controls on the right. Sidebar-collapse and ⌘K live elsewhere now
 * (TabStrip and Sidebar respectively) so the topbar reads as
 * `[connection] / [database] / [schema]` without competing chrome.
 */
export function TopBar() {
  const activeConfig = useSession((s) => s.activeConfig);
  const connectionState = useSession((s) => s.connectionState);
  const editMode = useSession((s) => s.editMode);
  const toggleEditMode = useSession((s) => s.toggleEditMode);

  const overlayOpen = useSession(
    (s) =>
      s.dialogOpen ||
      s.paletteOpen ||
      s.settingsOpen ||
      s.historyOpen ||
      s.deleteConfirmConnectionId !== null,
  );

  const dotClass =
    connectionState === 'connected'
      ? 'bg-primary'
      : connectionState === 'connecting'
        ? 'bg-primary animate-pulse'
        : connectionState === 'error'
          ? 'bg-destructive'
          : 'bg-muted-foreground';

  return (
    <header
      className={cn(
        'topbar-pad relative z-20 flex h-11 items-center gap-1 border-b bg-background',
        overlayOpen ? 'pointer-events-none' : 'drag',
      )}
    >
      <div className="no-drag flex items-center pl-1">
        <BrandMark className="h-5 w-5 text-foreground" />
      </div>

      <div className="no-drag ml-1.5 flex items-center">
        <ConnectionChip dotClass={dotClass} />
        {activeConfig && (
          <>
            <Crumb />
            <DatabaseChip />
            <Crumb />
            <SchemaChip />
          </>
        )}
      </div>

      <div className="flex-1" />

      {activeConfig && (
        <Button
          variant={editMode ? 'primary' : 'outline'}
          size="xs"
          onClick={toggleEditMode}
          title={editMode ? 'Writes enabled — click to lock' : 'Read-only — click to enable writes'}
          className="no-drag"
        >
          {editMode ? <Pencil /> : <Lock />}
          {editMode ? 'Edit mode' : 'Read only'}
        </Button>
      )}

      {!isMac && <WindowControls />}
    </header>
  );
}

function Crumb() {
  return (
    <span className="px-1 text-sm text-muted-foreground/50" aria-hidden>
      /
    </span>
  );
}

function ConnectionChip({ dotClass }: { dotClass: string }) {
  const activeConfig = useSession((s) => s.activeConfig);
  const savedConnections = useSession((s) => s.savedConnections);
  const connectionState = useSession((s) => s.connectionState);
  const openDialog = useSession((s) => s.openDialog);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex h-8 items-center gap-2 rounded-md px-2 text-sm transition-colors hover:bg-accent',
            !activeConfig && 'text-muted-foreground',
          )}
        >
          <span className={cn('inline-block h-2 w-2 rounded-full', dotClass)} />
          {activeConfig ? (
            <span className="max-w-[160px] truncate font-medium text-foreground">
              {activeConfig.name}
            </span>
          ) : (
            <span className="font-display italic">Connect to a database</span>
          )}
          <ChevronsUpDown className="h-3 w-3 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} className="w-[320px] p-1">
        <div className="px-2 py-1 font-display text-[11px] italic text-muted-foreground">
          Connections
        </div>
        <div className="max-h-[320px] overflow-y-auto">
          {savedConnections.length === 0 && (
            <div className="px-2 py-2 font-display text-xs italic text-muted-foreground">
              no saved connections yet
            </div>
          )}
          {savedConnections.map((c) => {
            const active = activeConfig?.id === c.id;
            const disabled = connectionState === 'connecting';
            return <ConnectionPickerRow key={c.id} c={c} active={active} disabled={disabled} />;
          })}
        </div>
        <div className="my-1 h-px bg-border" />
        <button
          type="button"
          onClick={() => openDialog()}
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-foreground transition-colors hover:bg-accent"
        >
          <Plus className="h-3.5 w-3.5 text-muted-foreground" />
          Add connection
        </button>
      </PopoverContent>
    </Popover>
  );
}

function DatabaseChip() {
  const activeConfig = useSession((s) => s.activeConfig);
  const editConnection = useSession((s) => s.editConnection);
  if (!activeConfig) return null;
  return (
    <button
      type="button"
      onClick={() => void editConnection(activeConfig.id)}
      title="Edit connection (database is bound to the connection)"
      className="flex h-8 items-center gap-2 rounded-md px-2 text-sm transition-colors hover:bg-accent"
    >
      <Database className="h-3 w-3 text-muted-foreground" />
      <span className="max-w-[140px] truncate font-medium text-foreground">
        {activeConfig.database}
      </span>
    </button>
  );
}

function SchemaChip() {
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
          className="flex h-8 items-center gap-2 rounded-md px-2 text-sm transition-colors hover:bg-accent"
        >
          <span className="font-display text-[11px] italic text-muted-foreground">schema</span>
          <span className="max-w-[140px] truncate font-mono font-medium text-foreground">
            {value}
          </span>
          <ChevronsUpDown className="h-3 w-3 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} className="w-[240px] p-1">
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
        <span className="truncate font-medium">{c.name}</span>
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
