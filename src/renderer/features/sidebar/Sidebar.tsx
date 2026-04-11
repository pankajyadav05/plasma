import {
  ChevronDown,
  ChevronRight,
  Circle,
  Database,
  Eye,
  Layers,
  Pencil,
  Plus,
  Star,
  Table2,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { useSession } from "@/stores/session";

/**
 * Sidebar — two independent regions:
 *   - Connections (top, sticky — does not scroll)
 *   - Schema     (bottom, scrollable, takes remaining space)
 *
 * Interaction pattern:
 *   The leftmost icon slot (database / table) IS the favorite toggle.
 *   Default state:  icon visible, name + count visible
 *   On hover:       icon crossfades to Star (100ms), row bg highlights
 *   Favorited:      Star is permanently visible in accent color
 *
 *   Clicking the icon slot → toggles favorite
 *   Clicking the body     → expands schema / opens table
 *
 * This keeps the row layout clean (no right-side hover-reveal
 * buttons) and the row count sits flush right where it belongs.
 */
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

  const inactiveSaved = savedConnections.filter((c) => c.id !== activeConfig?.id);

  const favoriteSchemaSet = new Set(activeConfig ? (favoriteSchemas?.[activeConfig.id] ?? []) : []);
  const favoriteTableSet = new Set(activeConfig ? (favoriteTables?.[activeConfig.id] ?? []) : []);

  const sortedSchemas = schema
    ? [...schema.schemas].sort((a, b) => {
        const aFav = favoriteSchemaSet.has(a.name) ? 0 : 1;
        const bFav = favoriteSchemaSet.has(b.name) ? 0 : 1;
        if (aFav !== bFav) return aFav - bFav;
        return a.name.localeCompare(b.name);
      })
    : [];

  return (
    <div className="flex h-full flex-col">
      {/* ── Connections — sticky ── */}
      <div className="shrink-0 border-b-2 border-border-strong">
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
              className="mx-5 my-2 flex items-center justify-center gap-2 border border-dashed border-rule py-3 font-display text-sm italic text-ink-muted transition-colors duration-instant hover:border-accent hover:text-accent"
            >
              <Plus className="h-3.5 w-3.5" />
              {connectionState === "connecting" ? "connecting…" : "add a connection"}
            </button>
          )}
        </Section>
      </div>

      {/* ── Schema — scrollable ── */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Section title={schemaLoading ? "Schema — loading" : "Schema"}>
          {!activeConfig && (
            <div className="px-5 py-3 font-display text-sm italic text-ink-muted">connect to browse the schema</div>
          )}

          {activeConfig && !schema && !schemaLoading && (
            <div className="px-5 py-3 font-display text-sm italic text-ink-muted">no schema loaded</div>
          )}

          {sortedSchemas.map((s) => {
            const expanded = expandedSchemas.has(s.name);
            const tables = schema?.tables.filter((t) => t.schema === s.name) ?? [];
            const sortedTables = [...tables].sort((a, b) => {
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
                  tableCount={tables.length}
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

// ─── Primitives ──────────────────────────────────────────────────────

function Section({ title, onAdd, children }: { title: string; onAdd?: () => void; children: React.ReactNode }) {
  return (
    <section className="py-3">
      <header className="flex items-center justify-between px-5 pb-2">
        <h2 className="font-mono text-xs uppercase text-ink-muted" style={{ letterSpacing: "0.10em" }}>
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

/**
 * IconStar — an icon slot that crossfades between a "resting" icon
 * (table / database) and a Star. The Star takes over when either:
 *   - the parent `.group` is hovered, OR
 *   - the row is favorited (permanent state)
 *
 * Both icons are absolutely positioned and stacked; opacity handles
 * the swap. 100ms ease-out crossfade keeps it feeling instantaneous.
 */
function IconStar({ resting, favorited }: { resting: React.ReactNode; favorited: boolean }) {
  return (
    <span className="relative grid h-4 w-4 shrink-0 place-items-center">
      <span
        className={cn(
          "absolute inset-0 grid place-items-center text-ink-muted transition-opacity duration-instant ease-out",
          favorited ? "opacity-0" : "opacity-100 group-hover/row:opacity-0",
        )}
      >
        {resting}
      </span>
      <span
        className={cn(
          "absolute inset-0 grid place-items-center transition-opacity duration-instant ease-out",
          favorited
            ? "text-accent opacity-100"
            : "text-ink-muted opacity-0 group-hover/row:text-accent group-hover/row:opacity-100",
        )}
      >
        <Star className={cn("h-3.5 w-3.5", favorited && "fill-accent")} />
      </span>
    </span>
  );
}

// ─── Connection rows ────────────────────────────────────────────────

function ActiveRow({ name, onEdit }: { name: string; onEdit: () => void }) {
  return (
    <div className="group/row relative flex h-8 w-full items-stretch border-l-[2px] border-accent bg-paper-selected transition-colors duration-instant">
      <button
        type="button"
        onClick={onEdit}
        title="Edit this connection"
        className="flex min-w-0 flex-1 items-center gap-2 pl-[16px] pr-3 text-left font-mono text-sm font-medium text-ink"
      >
        <Circle className="h-2 w-2 shrink-0 fill-accent text-accent" />
        <span className="truncate">{name}</span>
        <span className="ml-auto shrink-0 font-display text-xs italic text-ink-muted opacity-100 transition-opacity duration-instant group-hover/row:opacity-0">
          active
        </span>
      </button>
      <div className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 transition-opacity duration-instant group-hover/row:opacity-100">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          aria-label={`Edit ${name}`}
          title="Edit"
          className="h-5 w-5"
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
    <div className="group/row relative flex h-8 w-full items-stretch border-l-[2px] border-transparent transition-colors duration-instant hover:bg-[var(--bg-hover)]">
      <button
        type="button"
        onClick={onConnect}
        disabled={disabled}
        title={`Connect to ${hostLabel}`}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 pl-[16px] pr-3 text-left font-mono text-sm text-ink-2 transition-colors duration-instant",
          disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer group-hover/row:text-ink",
        )}
      >
        <Circle className="h-2 w-2 shrink-0 text-ink-muted" />
        <span className="truncate">{name}</span>
      </button>
      <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity duration-instant group-hover/row:opacity-100">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          aria-label={`Edit ${name}`}
          title="Edit"
          className="h-5 w-5"
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
          className="h-5 w-5"
        >
          <Trash2 />
        </Button>
      </div>
    </div>
  );
}

// ─── Schema tree rows ───────────────────────────────────────────────

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
    <div className="group/row relative flex h-8 w-full items-stretch transition-colors duration-instant hover:bg-[var(--bg-hover)]">
      {/* Chevron — clickable, toggles expand/collapse */}
      <button
        type="button"
        onClick={onToggleExpand}
        aria-label={expanded ? "Collapse" : "Expand"}
        className="flex h-full w-5 shrink-0 items-center justify-center pl-2 text-ink-muted transition-colors duration-instant group-hover/row:text-ink-2"
      >
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      </button>

      {/* Icon slot — Database ↔ Star crossfade, click toggles favorite */}
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

      {/* Body — click toggles expand. Schema names always render in
          semibold so they visibly sit "above" the table rows. */}
      <button
        type="button"
        onClick={onToggleExpand}
        className="flex min-w-0 flex-1 items-center gap-2 pl-1 pr-3 text-left font-mono text-[13px] font-semibold text-ink transition-colors duration-instant"
      >
        <span className="truncate">{name}</span>
        <span className="ml-auto shrink-0 font-display text-xs italic font-normal text-ink-muted">{tableCount}</span>
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
  // Icon varies by kind — tables use the default grid, views use Eye,
  // materialized views use Layers (suggesting cached layers).
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
        "group/row relative flex h-7 w-full items-stretch transition-colors duration-instant hover:bg-[var(--bg-hover)]",
        // The currently-open table gets a persistent bg so the user
        // always knows "this is the row I'm looking at right now".
        active && "bg-paper-selected",
      )}
    >
      {/* Active indicator — 2px oxblood bar at the left edge */}
      {active && <div className="absolute left-0 top-0 h-full w-[2px] bg-accent" aria-hidden />}

      {/* Indent to match schema content column */}
      <div className="w-5 shrink-0" aria-hidden />

      {/* Icon slot — resting icon ↔ Star crossfade */}
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

      {/* Body — click opens the table. Table names are lighter weight
          than schema names so the tree hierarchy reads clearly. */}
      <button
        type="button"
        onClick={onClick}
        title={`SELECT * FROM "${name}"`}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 pl-1 pr-3 text-left font-mono text-[12.5px] transition-colors duration-instant",
          active ? "font-medium text-ink" : "font-normal text-ink-2 group-hover/row:text-ink",
        )}
      >
        <span className="truncate">{name}</span>
        {rowCountEstimate !== null && rowCountEstimate >= 0 && (
          <span className="ml-auto shrink-0 font-display text-xs italic font-normal text-ink-muted">
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
