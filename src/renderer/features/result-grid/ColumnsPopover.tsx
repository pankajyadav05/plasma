import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/cn';
import { useActiveTab, useSession } from '@/stores/session';
import { Command } from 'cmdk';
import { Columns3, Eye, EyeOff, Pin, PinOff, Search } from 'lucide-react';

export function ColumnsPopover() {
  const tab = useActiveTab();
  const schema = useSession((s) => s.schema);
  const toggleColumnHidden = useSession((s) => s.toggleColumnHidden);
  const showAllColumns = useSession((s) => s.showAllColumns);
  const setHiddenColumns = useSession((s) => s.setHiddenColumns);
  const toggleStickyColumn = useSession((s) => s.toggleStickyColumn);
  const clearStickyColumns = useSession((s) => s.clearStickyColumns);

  if (!tab) return null;

  // Column list source depends on tab kind:
  //   table tab → full table schema (includes hidden cols so they can
  //               be toggled back on; the query re-runs on toggle).
  //   SQL tab   → whatever the current result set returned (hiding is
  //               pure display — we filter in ResultGrid at render time).
  const isTable = tab.kind === 'table';
  const allColumns: Array<{ name: string; dataType: string }> = isTable
    ? tab.tableSchema && tab.tableName
      ? (schema?.columns
          .filter((c) => c.schema === tab.tableSchema && c.table === tab.tableName)
          .sort((a, b) => a.ordinal - b.ordinal)
          .map((c) => ({ name: c.name, dataType: c.dataType })) ?? [])
      : []
    : (tab.queryResult?.columns ?? []).map((c) => ({
        name: c.name,
        dataType: c.dataTypeName,
      }));

  if (allColumns.length === 0) return null;

  const hiddenCount = tab.hiddenColumns.size;
  const stickyCount = tab.stickyColumns.size;
  const hasState = hiddenCount > 0 || stickyCount > 0;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant={hasState ? 'outline' : 'ghost'}
          size="xs"
          className={hasState ? 'border-primary text-primary' : ''}
        >
          <Columns3 />
          Columns
          {hiddenCount > 0 && (
            <span className="rounded-sm bg-primary px-1 py-0.5 text-xs font-semibold leading-none text-primary-foreground">
              {allColumns.length - hiddenCount}/{allColumns.length}
            </span>
          )}
          {stickyCount > 0 && <Pin className="h-3 w-3" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom" className="w-[420px] p-0">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h3 className="text-xs text-muted-foreground">
            Columns ({allColumns.length - hiddenCount} visible · {stickyCount} pinned)
          </h3>
          <div className="flex items-center gap-1">
            {stickyCount > 0 && (
              <Button
                variant="ghost"
                size="xs"
                onClick={clearStickyColumns}
                className="text-muted-foreground"
              >
                Unpin all
              </Button>
            )}
            {hiddenCount < allColumns.length ? (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => void setHiddenColumns(new Set(allColumns.map((c) => c.name)))}
                className="text-muted-foreground"
                title="Hide every column"
              >
                <EyeOff />
                Hide all
              </Button>
            ) : null}
            {hiddenCount > 0 && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => void showAllColumns()}
                className="text-muted-foreground"
              >
                <Eye />
                Show all
              </Button>
            )}
          </div>
        </div>
        <Command className="flex flex-col" shouldFilter>
          {allColumns.length > 8 && (
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <Command.Input
                placeholder="Search columns…"
                className="h-6 flex-1 border-0 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
              />
            </div>
          )}
          <Command.List className="max-h-[400px] overflow-y-auto py-1">
            <Command.Empty className="px-3 py-3 font-display text-xs italic text-muted-foreground">
              no matching column
            </Command.Empty>
            {allColumns.map((col) => {
              const hidden = tab.hiddenColumns.has(col.name);
              const sticky = tab.stickyColumns.has(col.name);
              return (
                // cmdk filters via the `value` prop — combine name + type
                // so users can search either ("uuid", "created_at").
                <Command.Item
                  key={col.name}
                  value={`${col.name} ${col.dataType}`}
                  onSelect={() => void toggleColumnHidden(col.name)}
                  className="group/row flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
                >
                  <span
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                    title={hidden ? 'Show column' : 'Hide column'}
                  >
                    {hidden ? (
                      <EyeOff className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <Eye className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span
                      className={cn(
                        'truncate font-semibold',
                        hidden && 'text-muted-foreground line-through',
                      )}
                    >
                      {col.name}
                    </span>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      {col.dataType}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      // Stop cmdk Item's onSelect from firing when the user clicks Pin.
                      e.stopPropagation();
                      toggleStickyColumn(col.name);
                    }}
                    className={cn(
                      'ml-1 grid h-6 w-6 shrink-0 place-items-center rounded-sm transition-colors',
                      sticky ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
                    )}
                    title={sticky ? 'Unpin column' : 'Pin column (sticky left)'}
                    aria-label={sticky ? 'Unpin column' : 'Pin column'}
                  >
                    {sticky ? (
                      <Pin className="h-3.5 w-3.5 fill-current" />
                    ) : (
                      <PinOff className="h-3.5 w-3.5" />
                    )}
                  </button>
                </Command.Item>
              );
            })}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
