import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Circle,
  Database,
  Eye,
  Layers,
  Pencil,
  Plus,
  Search,
  Star,
  Table2,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { useSession } from "@/stores/session";

export function Sidebar() {
  const activeConfig = useSession((s) => s.activeConfig);
  const connectionState = useSession((s) => s.connectionState);
  const savedConnections = useSession((s) => s.savedConnections);
  const schema = useSession((s) => s.schema);
  const schemaLoading = useSession((s) => s.schemaLoading);
  const expandedSchemas = useSession((s) => s.expandedSchemas);
  const activeTable = useSession((s) => s.activeTable);
  const favoriteSchemas = useSession((s) => s.settings.favoriteSchemas);
  const favoriteTables = useSession((s) => s.settings.favoriteTables);
  const openDialog = useSession((s) => s.openDialog);
  const editConnection = useSession((s) => s.editConnection);
  const connectSaved = useSession((s) => s.connectSaved);
  const requestDelete = useSession((s) => s.requestDeleteConnection);
  const toggleSchema = useSession((s) => s.toggleSchema);
  const openTable = useSession((s) => s.openTable);
  const toggleFavoriteSchema = useSession((s) => s.toggleFavoriteSchema);
  const toggleFavoriteTable = useSession((s) => s.toggleFavoriteTable);

  const [searchQuery, setSearchQuery] = useState("");

  const inactiveSaved = savedConnections.filter((c) => c.id !== activeConfig?.id);

  const favoriteSchemaSet = new Set(activeConfig ? (favoriteSchemas?.[activeConfig.id] ?? []) : []);
  const favoriteTableSet = new Set(activeConfig ? (favoriteTables?.[activeConfig.id] ?? []) : []);

  // When searching, we filter tables by name (case-insensitive substring)
  // and drop any schema that has zero matches so the tree stays tight.
  // Matching schemas are force-expanded regardless of the user's manual
  // expand/collapse state, so results are visible immediately.
  const search = searchQuery.trim().toLowerCase();
  const isSearching = search.length > 0;

  const sortedSchemas = useMemo(() => {
    if (!schema) return [];
    const base = [...schema.schemas].sort((a, b) => {
      const aFav = favoriteSchemaSet.has(a.name) ? 0 : 1;
      const bFav = favoriteSchemaSet.has(b.name) ? 0 : 1;
      if (aFav !== bFav) return aFav - bFav;
      return a.name.localeCompare(b.name);
    });
    if (!isSearching) return base;
    return base.filter((s) =>
      schema.tables.some(
        (t) => t.schema === s.name && t.name.toLowerCase().includes(search),
      ),
    );
    // biome-ignore lint/correctness/useExhaustiveDependencies: favoriteSchemaSet derived per-render, ref identity doesn't matter
  }, [schema, isSearching, search]);

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-sidebar-border">
        <Section title="Connections" onAdd={() => openDialog()}>
          {activeConfig && <ActiveRow name={activeConfig.name} onEdit={() => void editConnection(activeConfig.id)} />}

          {inactiveSaved.map((saved) => (
            <SavedRow
              key={saved.id}
              name={saved.name}
              hostLabel={`${saved.host}:${saved.port}/${saved.database}`}
              disabled={connectionState === "connecting"}
              onConnect={() => void connectSaved(saved.id)}
              onEdit={() => void editConnection(saved.id)}
              onDelete={() => requestDelete(saved.id)}
            />
          ))}

          {!activeConfig && savedConnections.length === 0 && (
            <button
              type="button"
              onClick={() => openDialog()}
              className="mx-3 my-2 flex items-center justify-center gap-2 rounded-md border border-dashed border-sidebar-border py-3 font-display text-sm italic text-muted-foreground transition-colors hover:border-primary hover:text-primary"
            >
              <Plus className="h-3.5 w-3.5" />
              {connectionState === "connecting" ? "connecting…" : "add a connection"}
            </button>
          )}
        </Section>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Section title={schemaLoading ? "Schema — loading" : "Schema"}>
          {activeConfig && schema && (
            <div className="sticky top-0 z-10 border-b border-sidebar-border bg-sidebar px-3 pb-2 pt-1">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search tables…"
                  className="h-8 w-full rounded-md border border-sidebar-border bg-background pl-8 pr-7 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
                  aria-label="Search tables"
                />
                {isSearching && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery("")}
                    className="absolute right-1.5 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded-sm text-muted-foreground hover:text-foreground"
                    aria-label="Clear search"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            </div>
          )}

          {!activeConfig && (
            <div className="px-4 py-3 font-display text-sm italic text-muted-foreground">connect to browse the schema</div>
          )}

          {activeConfig && !schema && !schemaLoading && (
            <div className="px-4 py-3 font-display text-sm italic text-muted-foreground">no schema loaded</div>
          )}

          {activeConfig && schema && sortedSchemas.length === 0 && isSearching && (
            <div className="px-4 py-3 font-display text-sm italic text-muted-foreground">
              no tables match "{searchQuery}"
            </div>
          )}

          {sortedSchemas.map((s) => {
            const manuallyExpanded = expandedSchemas.has(s.name);
            // Auto-expand while searching so matches are visible without clicks.
            const expanded = manuallyExpanded || isSearching;
            const allTables = schema?.tables.filter((t) => t.schema === s.name) ?? [];
            const matchingTables = isSearching
              ? allTables.filter((t) => t.name.toLowerCase().includes(search))
              : allTables;
            const sortedTables = [...matchingTables].sort((a, b) => {
              const aFav = favoriteTableSet.has(`${s.name}.${a.name}`) ? 0 : 1;
              const bFav = favoriteTableSet.has(`${s.name}.${b.name}`) ? 0 : 1;
              if (aFav !== bFav) return aFav - bFav;
              return a.name.localeCompare(b.name);
            });
            const isSchemaFav = favoriteSchemaSet.has(s.name);
            return (
              <div key={s.name}>
                <SchemaRow
                  name={s.name}
                  tableCount={isSearching ? sortedTables.length : allTables.length}
                  expanded={expanded}
                  favorite={isSchemaFav}
                  onToggleExpand={() => toggleSchema(s.name)}
                  onToggleFavorite={() => {
                    if (activeConfig) {
                      void toggleFavoriteSchema(activeConfig.id, s.name);
                    }
                  }}
                />
                {expanded &&
                  sortedTables.map((t) => {
                    const isFav = favoriteTableSet.has(`${t.schema}.${t.name}`);
                    const isActive = activeTable?.schema === t.schema && activeTable?.name === t.name;
                    return (
                      <TableRow
                        key={`${t.schema}.${t.name}`}
                        name={t.name}
                        kind={t.kind}
                        rowCountEstimate={t.rowCountEstimate}
                        favorite={isFav}
                        active={isActive}
                        onClick={() => openTable(t.schema, t.name)}
                        onToggleFavorite={() => {
                          if (activeConfig) {
                            void toggleFavoriteTable(activeConfig.id, t.schema, t.name);
                          }
                        }}
                      />
                    );
                  })}
              </div>
            );
          })}
        </Section>
      </div>
    </div>
  );
}

function Section({ title, onAdd, children }: { title: string; onAdd?: () => void; children: React.ReactNode }) {
  return (
    <section className="py-2">
      <header className="flex items-center justify-between px-4 pb-2 pt-1">
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {title}
        </h2>
        {onAdd && (
          <Button variant="ghost" size="icon-xs" onClick={onAdd} aria-label={`Add ${title.toLowerCase()}`}>
            <Plus />
          </Button>
        )}
      </header>
      {children}
    </section>
  );
}

function IconStar({ resting, favorited }: { resting: React.ReactNode; favorited: boolean }) {
  return (
    <span className="relative grid h-4 w-4 shrink-0 place-items-center">
      <span
        className={cn(
          "absolute inset-0 grid place-items-center text-muted-foreground transition-opacity",
          favorited ? "opacity-0" : "opacity-100 group-hover/row:opacity-0",
        )}
      >
        {resting}
      </span>
      <span
        className={cn(
          "absolute inset-0 grid place-items-center transition-opacity",
          favorited
            ? "text-primary opacity-100"
            : "text-muted-foreground opacity-0 group-hover/row:text-primary group-hover/row:opacity-100",
        )}
      >
        <Star className={cn("h-3.5 w-3.5", favorited && "fill-primary")} />
      </span>
    </span>
  );
}

function ActiveRow({ name, onEdit }: { name: string; onEdit: () => void }) {
  return (
    <div className="group/row relative mx-2 flex h-8 items-stretch rounded-md bg-sidebar-accent text-sidebar-accent-foreground">
      <button
        type="button"
        onClick={onEdit}
        title="Edit this connection"
        className="flex min-w-0 flex-1 items-center gap-2 px-3 text-left text-sm font-medium"
      >
        <Circle className="h-2 w-2 shrink-0 fill-primary text-primary" />
        <span className="truncate">{name}</span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground opacity-100 transition-opacity group-hover/row:opacity-0">
          active
        </span>
      </button>
      <div className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 transition-opacity group-hover/row:opacity-100">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          aria-label={`Edit ${name}`}
          title="Edit"
          className="h-6 w-6"
        >
          <Pencil />
        </Button>
      </div>
    </div>
  );
}

function SavedRow({
  name,
  hostLabel,
  disabled,
  onConnect,
  onEdit,
  onDelete,
}: {
  name: string;
  hostLabel: string;
  disabled: boolean;
  onConnect: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group/row relative mx-2 flex h-8 items-stretch rounded-md transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground">
      <button
        type="button"
        onClick={onConnect}
        disabled={disabled}
        title={`Connect to ${hostLabel}`}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 px-3 text-left text-sm text-muted-foreground transition-colors",
          disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer group-hover/row:text-sidebar-accent-foreground",
        )}
      >
        <Circle className="h-2 w-2 shrink-0 text-muted-foreground" />
        <span className="truncate">{name}</span>
      </button>
      <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          aria-label={`Edit ${name}`}
          title="Edit"
          className="h-6 w-6"
        >
          <Pencil />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          aria-label={`Delete ${name}`}
          title="Delete"
          className="h-6 w-6"
        >
          <Trash2 />
        </Button>
      </div>
    </div>
  );
}

function SchemaRow({
  name,
  tableCount,
  expanded,
  favorite,
  onToggleExpand,
  onToggleFavorite,
}: {
  name: string;
  tableCount: number;
  expanded: boolean;
  favorite: boolean;
  onToggleExpand: () => void;
  onToggleFavorite: () => void;
}) {
  return (
    <div className="group/row relative mx-2 flex h-8 items-stretch rounded-md transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground">
      <button
        type="button"
        onClick={onToggleExpand}
        aria-label={expanded ? "Collapse" : "Expand"}
        className="flex h-full w-5 shrink-0 items-center justify-center pl-2 text-muted-foreground"
      >
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      </button>

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggleFavorite();
        }}
        aria-label={favorite ? `Unstar ${name}` : `Star ${name}`}
        title={favorite ? "Unstar" : "Star as favorite"}
        className="flex h-full w-6 shrink-0 items-center justify-center"
      >
        <IconStar favorited={favorite} resting={<Database className="h-3.5 w-3.5" />} />
      </button>

      <button
        type="button"
        onClick={onToggleExpand}
        className="flex min-w-0 flex-1 items-center gap-2 pl-1 pr-3 text-left text-sm font-semibold text-foreground"
      >
        <span className="truncate">{name}</span>
        <span className="ml-auto shrink-0 text-xs font-normal text-muted-foreground">{tableCount}</span>
      </button>
    </div>
  );
}

function TableRow({
  name,
  kind,
  rowCountEstimate,
  favorite,
  active,
  onClick,
  onToggleFavorite,
}: {
  name: string;
  kind: "table" | "view" | "matview";
  rowCountEstimate: number | null;
  favorite: boolean;
  active: boolean;
  onClick: () => void;
  onToggleFavorite: () => void;
}) {
  const restingIcon =
    kind === "view" ? (
      <Eye className="h-3.5 w-3.5" />
    ) : kind === "matview" ? (
      <Layers className="h-3.5 w-3.5" />
    ) : (
      <Table2 className="h-3.5 w-3.5" />
    );

  return (
    <div
      className={cn(
        "group/row cv-row-28 relative mx-2 flex h-7 items-stretch rounded-md transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        active && "bg-sidebar-accent text-sidebar-accent-foreground",
      )}
    >
      {active && <div className="absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-full bg-primary" aria-hidden />}

      <div className="w-5 shrink-0" aria-hidden />

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggleFavorite();
        }}
        aria-label={favorite ? `Unstar ${name}` : `Star ${name}`}
        title={favorite ? "Unstar" : "Star as favorite"}
        className="flex h-full w-6 shrink-0 items-center justify-center"
      >
        <IconStar favorited={favorite} resting={restingIcon} />
      </button>

      <button
        type="button"
        onClick={onClick}
        title={`SELECT * FROM "${name}"`}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 pl-1 pr-3 text-left text-sm transition-colors",
          active ? "font-medium text-foreground" : "font-normal text-muted-foreground group-hover/row:text-sidebar-accent-foreground",
        )}
      >
        <span className="truncate">{name}</span>
        {rowCountEstimate !== null && rowCountEstimate >= 0 && (
          <span className="ml-auto shrink-0 text-xs font-normal text-muted-foreground">
            {formatEstimate(rowCountEstimate)}
          </span>
        )}
      </button>
    </div>
  );
}

function formatEstimate(n: number): string {
  if (n < 0) return "";
  if (n < 1_000) return n.toString();
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}m`;
}
