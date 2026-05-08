import { Dialog, DialogOverlay, DialogPortal } from '@/components/ui/dialog';
import { kbd } from '@/lib/platform';
import { useSession } from '@/stores/session';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Command } from 'cmdk';
import {
  Clock,
  Command as CommandIcon,
  LogOut,
  Moon,
  PanelLeft,
  Play,
  Plug,
  Plus,
  Search,
  Settings as SettingsIcon,
  Table2,
} from 'lucide-react';
import { useEffect, useMemo } from 'react';

/**
 * Command palette — global ⌘K launcher powered by `cmdk`, wrapped in a
 * Radix Dialog for focus management + Esc + portal behaviour.
 */
export function CommandPalette() {
  const open = useSession((s) => s.paletteOpen);
  const setOpen = useSession((s) => s.setPaletteOpen);
  const togglePalette = useSession((s) => s.togglePalette);

  const schema = useSession((s) => s.schema);
  const savedConnections = useSession((s) => s.savedConnections);
  const activeConfig = useSession((s) => s.activeConfig);
  const addTab = useSession((s) => s.addTab);
  const openTable = useSession((s) => s.openTable);
  const connectSaved = useSession((s) => s.connectSaved);
  const runQuery = useSession((s) => s.runQuery);
  const toggleEditor = useSession((s) => s.toggleEditor);
  const toggleSidebar = useSession((s) => s.toggleSidebar);
  const toggleTheme = useSession((s) => s.toggleTheme);
  const setSettingsOpen = useSession((s) => s.setSettingsOpen);
  const setHistoryOpen = useSession((s) => s.setHistoryOpen);
  const loadHistory = useSession((s) => s.loadHistory);
  const disconnect = useSession((s) => s.disconnect);
  const openDialog = useSession((s) => s.openDialog);

  // Global ⌘K listener
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        togglePalette();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [togglePalette]);

  const tables = useMemo(() => schema?.tables ?? [], [schema]);

  const runAction = (action: () => void | Promise<void>) => {
    setOpen(false);
    void action();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content className="fixed left-1/2 top-[15vh] z-50 w-[620px] max-w-[90vw] -translate-x-1/2 rounded-lg border bg-popover text-popover-foreground shadow-lg focus:outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 duration-200">
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Search tables, connections, and actions
          </DialogPrimitive.Description>
          <Command label="Command palette" shouldFilter>
            <div className="flex items-center gap-3 border-b px-4 py-3">
              <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
              <Command.Input
                autoFocus
                placeholder="Search tables, connections, actions…"
                className="h-8 flex-1 border-0 bg-transparent text-sm text-foreground outline-none focus:outline-none focus-visible:outline-none focus-visible:ring-0 placeholder:text-muted-foreground"
              />
            </div>

            <Command.List className="max-h-[50vh] overflow-y-auto p-2">
              <Command.Empty className="px-4 py-8 text-center text-sm text-muted-foreground">
                No matches.
              </Command.Empty>

              <Command.Group
                heading="Actions"
                className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
              >
                <PaletteItem
                  icon={<Play className="h-3.5 w-3.5" />}
                  onSelect={() => runAction(runQuery)}
                  keys={kbd('⏎')}
                >
                  Run query
                </PaletteItem>
                <PaletteItem
                  icon={<Plus className="h-3.5 w-3.5" />}
                  onSelect={() => runAction(addTab)}
                  keys={kbd('T')}
                >
                  New query tab
                </PaletteItem>
                <PaletteItem
                  icon={<CommandIcon className="h-3.5 w-3.5" />}
                  onSelect={() => runAction(toggleEditor)}
                  keys={kbd('J')}
                >
                  Toggle query editor
                </PaletteItem>
                <PaletteItem
                  icon={<PanelLeft className="h-3.5 w-3.5" />}
                  onSelect={() => runAction(toggleSidebar)}
                  keys={kbd('B')}
                >
                  Toggle sidebar
                </PaletteItem>
                <PaletteItem
                  icon={<Moon className="h-3.5 w-3.5" />}
                  onSelect={() => runAction(toggleTheme)}
                >
                  Toggle dark mode
                </PaletteItem>
                <PaletteItem
                  icon={<Clock className="h-3.5 w-3.5" />}
                  onSelect={() => {
                    setOpen(false);
                    setHistoryOpen(true);
                    void loadHistory();
                  }}
                  keys={kbd('H')}
                >
                  Query history
                </PaletteItem>
                <PaletteItem
                  icon={<SettingsIcon className="h-3.5 w-3.5" />}
                  onSelect={() => runAction(() => setSettingsOpen(true))}
                >
                  Settings
                </PaletteItem>
                <PaletteItem
                  icon={<Plus className="h-3.5 w-3.5" />}
                  onSelect={() => runAction(() => openDialog())}
                >
                  New connection
                </PaletteItem>
                {activeConfig && (
                  <PaletteItem
                    icon={<LogOut className="h-3.5 w-3.5" />}
                    onSelect={() => runAction(disconnect)}
                  >
                    Disconnect
                  </PaletteItem>
                )}
              </Command.Group>

              {savedConnections.length > 0 && (
                <Command.Group
                  heading="Connections"
                  className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
                >
                  {savedConnections.map((c) => {
                    const active = c.id === activeConfig?.id;
                    return (
                      <PaletteItem
                        key={c.id}
                        icon={<Plug className="h-3.5 w-3.5" />}
                        onSelect={() =>
                          runAction(() => (active ? Promise.resolve() : connectSaved(c.id)))
                        }
                      >
                        {c.name} -
                        <span className="ml-auto text-xs text-muted-foreground">
                          &nbsp;{c.host}:{c.port}/{c.database}
                        </span>
                      </PaletteItem>
                    );
                  })}
                </Command.Group>
              )}

              {tables.length > 0 && (
                <Command.Group
                  heading="Tables"
                  className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
                >
                  {tables.slice(0, 100).map((t) => (
                    <PaletteItem
                      key={`${t.schema}.${t.name}`}
                      value={`${t.schema}.${t.name}`}
                      icon={<Table2 className="h-3.5 w-3.5" />}
                      onSelect={() => runAction(() => openTable(t.schema, t.name))}
                    >
                      {t.schema}.{t.name}
                      {t.rowCountEstimate !== null && t.rowCountEstimate >= 0 && (
                        <span className="ml-auto text-xs text-muted-foreground">
                          {formatK(t.rowCountEstimate)} rows
                        </span>
                      )}
                    </PaletteItem>
                  ))}
                </Command.Group>
              )}
            </Command.List>
          </Command>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}

function PaletteItem({
  children,
  onSelect,
  keys,
  value,
  icon,
}: {
  children: React.ReactNode;
  onSelect: () => void;
  keys?: string;
  value?: string;
  icon?: React.ReactNode;
}) {
  return (
    <Command.Item
      onSelect={onSelect}
      value={value}
      className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm text-foreground transition-colors aria-selected:bg-accent aria-selected:text-accent-foreground data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
    >
      {icon && <span className="shrink-0 text-muted-foreground">{icon}</span>}
      <span className="flex-1 truncate">{children}</span>
      {keys && <span className="shrink-0 text-xs text-muted-foreground">{keys}</span>}
    </Command.Item>
  );
}

function formatK(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(0)}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
}
