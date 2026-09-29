import { Checkbox } from '@/components/ui/checkbox';
import { IconButton } from '@/components/ui/workbench';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/cn';
import { type EntityKind, useSession } from '@/stores/session';
import { Eye, GitBranch, Globe, Layers, SlidersHorizontal, Star, Table2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { SidebarSearch, SidebarSearchRow, sidebarRowClass } from './sidebar-parts';

/**
 * Tables-mode sidebar content. Replaces the legacy schema tree with:
 *   - Schema picker (dropdown at top)
 *   - Filter row (search + entity-type filter)
 *   - Flat entity list (tables + views + matviews) for the selected schema
 *
 * Exposed as an ARIA role="tree" with treeitem / aria-level so the
 * DESIGN.md section 9 accessibility floor is met even though the visual
 * layout is a single-level list (schema selection lives in the topbar).
 */
export function EntityList() {
  const activeConfig = useSession((s) => s.activeConfig);
  const schema = useSession((s) => s.schema);
  const schemaLoading = useSession((s) => s.schemaLoading);
  const currentSchema = useSession((s) => s.currentSchema);
  const entityFilter = useSession((s) => s.entityFilter);
  const toggleEntityFilter = useSession((s) => s.toggleEntityFilter);
  const activeTable = useSession((s) => s.activeTable);
  const openTable = useSession((s) => s.openTable);
  const favoriteTables = useSession((s) => s.settings.favoriteTables);
  const toggleFavoriteTable = useSession((s) => s.toggleFavoriteTable);

  const [search, setSearch] = useState('');

  const favoriteTableSet = new Set(activeConfig ? (favoriteTables?.[activeConfig.id] ?? []) : []);

  const effectiveSchema = currentSchema ?? schema?.schemas[0]?.name ?? null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: favoriteTableSet ref shifts every render
  const entities = useMemo(() => {
    if (!schema || !effectiveSchema) return [];
    const q = search.trim().toLowerCase();
    return schema.tables
      .filter((t) => t.schema === effectiveSchema)
      .filter((t) => entityFilter.has(t.kind as EntityKind))
      .filter((t) => (q ? t.name.toLowerCase().includes(q) : true))
      .sort((a, b) => {
        const aFav = favoriteTableSet.has(`${a.schema}.${a.name}`) ? 0 : 1;
        const bFav = favoriteTableSet.has(`${b.schema}.${b.name}`) ? 0 : 1;
        if (aFav !== bFav) return aFav - bFav;
        return a.name.localeCompare(b.name);
      });
  }, [schema, effectiveSchema, entityFilter, search]);

  if (!activeConfig) {
    return (
      <div className="px-4 py-3 text-[13px] text-[var(--wb-text-2)]">
        connect to browse the schema
      </div>
    );
  }

  if (!schema && schemaLoading) {
    return <div className="px-4 py-3 text-[13px] text-[var(--wb-text-2)]">loading…</div>;
  }
  if (!schema) {
    return <div className="px-4 py-3 text-[13px] text-[var(--wb-text-2)]">no schema</div>;
  }

  return (
    <div className="flex h-full flex-col">
      {/* Schema picker lives in the topbar — don't duplicate it here. */}

      {/* ── Search + entity filter ── */}
      <SidebarSearchRow>
        <SidebarSearch
          value={search}
          onChange={setSearch}
          placeholder="Search for item…"
          ariaLabel="Search tables"
        />
        <EntityFilterMenu entityFilter={entityFilter} toggle={toggleEntityFilter} />
      </SidebarSearchRow>

      {/* ── Entity list (ARIA tree — DESIGN.md §9 / U38) ── */}
      <div
        className="min-h-0 flex-1 overflow-y-auto py-1"
        role="tree"
        aria-label={effectiveSchema ? `Tables in ${effectiveSchema}` : 'Tables'}
      >
        {entities.length === 0 && (
          <div className="px-4 py-3 text-[13px] text-[var(--wb-text-2)]">
            {search ? `no entities match "${search}"` : 'empty'}
          </div>
        )}
        {entities.map((t) => {
          const fav = favoriteTableSet.has(`${t.schema}.${t.name}`);
          const active = activeTable?.schema === t.schema && activeTable?.name === t.name;
          return (
            <EntityRow
              key={`${t.schema}.${t.name}`}
              name={t.name}
              kind={t.kind as EntityKind}
              favorite={fav}
              active={active}
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
    </div>
  );
}

const ENTITY_KIND_LABELS: Record<EntityKind, string> = {
  table: 'Table',
  view: 'View',
  matview: 'Materialized View',
  foreign: 'Foreign Table',
  partitioned: 'Partitioned Table',
};

const ENTITY_KIND_ORDER: EntityKind[] = ['table', 'view', 'matview', 'foreign', 'partitioned'];

function EntityFilterMenu({
  entityFilter,
  toggle,
}: {
  entityFilter: Set<EntityKind>;
  toggle: (k: EntityKind) => void;
}) {
  const allOn = ENTITY_KIND_ORDER.every((k) => entityFilter.has(k));
  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton
          variant="plain"
          label="Filter entity types"
          active={!allOn}
          className="[&_svg]:h-4 [&_svg]:w-4"
        >
          <SlidersHorizontal />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={4} className="w-[220px] p-3">
        <h3 className="mb-2 text-[11px] font-semibold text-[var(--wb-text-2)]">
          Show entity types
        </h3>
        <div className="flex flex-col gap-1">
          {ENTITY_KIND_ORDER.map((k) => {
            const on = entityFilter.has(k);
            return (
              <label
                key={k}
                htmlFor={`entity-filter-${k}`}
                className="flex h-6 cursor-pointer items-center gap-2 rounded-[5px] px-1 text-[13px] text-[var(--wb-text)] hover:bg-[color-mix(in_srgb,var(--wb-text)_6%,transparent)]"
              >
                <Checkbox
                  id={`entity-filter-${k}`}
                  checked={on}
                  onCheckedChange={() => toggle(k)}
                />
                <span>{ENTITY_KIND_LABELS[k]}</span>
              </label>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function EntityRow({
  name,
  kind,
  favorite,
  active,
  onClick,
  onToggleFavorite,
}: {
  name: string;
  kind: EntityKind;
  favorite: boolean;
  active: boolean;
  onClick: () => void;
  onToggleFavorite: () => void;
}) {
  const Icon =
    kind === 'view'
      ? Eye
      : kind === 'matview'
        ? Layers
        : kind === 'foreign'
          ? Globe
          : kind === 'partitioned'
            ? GitBranch
            : Table2;

  return (
    <div
      role="treeitem"
      aria-level={1}
      aria-selected={active}
      className={cn('group/row relative items-stretch', sidebarRowClass(active))}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggleFavorite();
        }}
        aria-label={favorite ? `Unstar ${name}` : `Star ${name}`}
        className="group/star flex h-full w-6 shrink-0 cursor-pointer items-center justify-center"
      >
        <span className="relative grid h-4 w-4 place-items-center">
          <Icon
            className={cn(
              'absolute inset-0 m-auto h-3.5 w-3.5 transition-opacity duration-150',
              favorite
                ? 'opacity-0'
                : 'opacity-100 group-hover/row:opacity-0 group-focus-visible/star:opacity-0',
              'text-[var(--wb-text-2)]',
            )}
          />
          <Star
            className={cn(
              'absolute inset-0 m-auto h-3.5 w-3.5 transition-opacity duration-150',
              favorite
                ? 'fill-[#d9b44a] text-[#d9b44a] opacity-100'
                : 'text-[var(--wb-text-2)] opacity-0 group-hover/row:opacity-100 group-focus-visible/star:opacity-100',
            )}
          />
        </span>
      </button>
      <button
        type="button"
        onClick={onClick}
        title={`Open ${name}`}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 pl-1 pr-2 text-left text-[13px] text-[var(--wb-text)]',
        )}
      >
        <span className="truncate">{name}</span>
      </button>
    </div>
  );
}
