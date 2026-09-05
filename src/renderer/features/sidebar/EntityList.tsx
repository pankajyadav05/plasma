import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/cn';
import { type EntityKind, useSession } from '@/stores/session';
import {
  Braces,
  ChevronDown,
  ChevronRight,
  Eye,
  Filter as FilterIcon,
  FunctionSquare,
  GitBranch,
  Globe,
  Hash,
  Layers,
  Search,
  Star,
  Table2,
  Zap,
  X,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';

/**
 * Tables-mode sidebar content. Replaces the legacy schema tree with:
 *   - Schema picker (dropdown at top)
 *   - Filter row (search + entity-type filter)
 *   - Flat entity list (tables + views + matviews) for the selected schema
 *   - Collapsible sections for functions, enums, sequences, triggers (U34)
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
  const addTab = useSession((s) => s.addTab);
  const setSql = useSession((s) => s.setSql);
  const setEditorExpanded = useSession((s) => s.setEditorExpanded);

  const [search, setSearch] = useState('');
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    functions: true,
    enums: true,
    sequences: true,
    triggers: true,
  });

  const favoriteTableSet = new Set(activeConfig ? (favoriteTables?.[activeConfig.id] ?? []) : []);

  const effectiveSchema = currentSchema ?? schema?.schemas[0]?.name ?? null;

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
    // biome-ignore lint/correctness/useExhaustiveDependencies: favoriteTableSet ref shifts every render
  }, [schema, effectiveSchema, entityFilter, search]);

  const q = search.trim().toLowerCase();

  const functions = useMemo(() => {
    if (!schema || !effectiveSchema) return [];
    return (schema.functions ?? [])
      .filter((f) => f.schema === effectiveSchema)
      .filter((f) => (q ? f.name.toLowerCase().includes(q) : true))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [schema, effectiveSchema, q]);

  const enums = useMemo(() => {
    if (!schema || !effectiveSchema) return [];
    return (schema.enums ?? [])
      .filter((e) => e.schema === effectiveSchema)
      .filter((e) => (q ? e.name.toLowerCase().includes(q) : true))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [schema, effectiveSchema, q]);

  const sequences = useMemo(() => {
    if (!schema || !effectiveSchema) return [];
    return (schema.sequences ?? [])
      .filter((s) => s.schema === effectiveSchema)
      .filter((s) => (q ? s.name.toLowerCase().includes(q) : true))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [schema, effectiveSchema, q]);

  const triggers = useMemo(() => {
    if (!schema || !effectiveSchema) return [];
    return (schema.triggers ?? [])
      .filter((t) => t.schema === effectiveSchema)
      .filter((t) =>
        q
          ? t.name.toLowerCase().includes(q) || t.table.toLowerCase().includes(q)
          : true,
      )
      .sort((a, b) => a.name.localeCompare(b.name) || a.table.localeCompare(b.table));
  }, [schema, effectiveSchema, q]);

  const openInEditor = (sql: string) => {
    addTab();
    setSql(sql);
    setEditorExpanded(true);
  };

  const toggleSection = (key: string) => {
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  if (!activeConfig) {
    return (
      <div className="px-4 py-3 font-display text-sm italic text-muted-foreground">
        connect to browse the schema
      </div>
    );
  }

  if (!schema && schemaLoading) {
    return (
      <div className="px-4 py-3 font-display text-sm italic text-muted-foreground">loading…</div>
    );
  }
  if (!schema) {
    return (
      <div className="px-4 py-3 font-display text-sm italic text-muted-foreground">no schema</div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Schema picker lives in the topbar — don't duplicate it here. */}

      {/* ── Search + entity filter ── */}
      <div className="border-b border-sidebar-border px-3 py-2">
        <div className="flex items-center gap-1">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search schema…"
              className="h-8 w-full rounded-md border border-sidebar-border bg-background pl-8 pr-7 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
              aria-label="Search schema"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-1.5 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded-sm text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          <EntityFilterMenu entityFilter={entityFilter} toggle={toggleEntityFilter} />
        </div>
      </div>

      {/* ── Entity list + extra sections ── */}
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {entities.length === 0 && (
          <div className="px-4 py-3 font-display text-sm italic text-muted-foreground">
            {search ? `no tables match "${search}"` : 'no tables'}
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

        <SchemaSection
          title="Functions"
          count={functions.length}
          open={openSections.functions !== false}
          onToggle={() => toggleSection('functions')}
        >
          {functions.map((f) => {
            const argHint = f.identityArgs
              ? f.identityArgs
                  .split(',')
                  .map((a) => a.trim())
                  .filter(Boolean)
                  .map((a) => `/* ${a} */`)
                  .join(', ')
              : '';
            const callName =
              f.schema === 'public'
                ? quoteIdent(f.name)
                : `${quoteIdent(f.schema)}.${quoteIdent(f.name)}`;
            const stub =
              f.kind === 'procedure'
                ? `CALL ${callName}(${argHint});`
                : `SELECT ${callName}(${argHint});`;
            return (
              <SimpleRow
                key={`${f.schema}.${f.name}.${f.identityArgs}`}
                icon={FunctionSquare}
                name={f.name}
                detail={f.kind === 'function' ? f.returnType : f.kind}
                title={`${f.schema}.${f.name}(${f.identityArgs}) → ${f.returnType || f.kind}`}
                onClick={() => openInEditor(`-- ${f.kind} ${f.schema}.${f.name}(${f.identityArgs})\n${stub}`)}
              />
            );
          })}
        </SchemaSection>

        <SchemaSection
          title="Enums"
          count={enums.length}
          open={openSections.enums !== false}
          onToggle={() => toggleSection('enums')}
        >
          {enums.map((e) => {
            const qualified = e.schema === 'public' ? e.name : `${e.schema}.${e.name}`;
            const labels = e.labels.map((l) => `'${l.replace(/'/g, "''")}'`).join(', ');
            return (
              <SimpleRow
                key={`${e.schema}.${e.name}`}
                icon={Braces}
                name={e.name}
                detail={`${e.labels.length}`}
                title={`${qualified}: ${e.labels.join(' | ')}`}
                onClick={() =>
                  openInEditor(
                    `-- enum ${qualified}\n-- labels: ${e.labels.join(', ')}\nSELECT unnest(ARRAY[${labels}]::${quoteIdent(e.schema)}.${quoteIdent(e.name)}[]);`,
                  )
                }
              />
            );
          })}
        </SchemaSection>

        <SchemaSection
          title="Sequences"
          count={sequences.length}
          open={openSections.sequences !== false}
          onToggle={() => toggleSection('sequences')}
        >
          {sequences.map((s) => {
            const qualified =
              s.schema === 'public' ? quoteIdent(s.name) : `${quoteIdent(s.schema)}.${quoteIdent(s.name)}`;
            return (
              <SimpleRow
                key={`${s.schema}.${s.name}`}
                icon={Hash}
                name={s.name}
                detail={s.dataType}
                title={`${s.schema}.${s.name} (${s.dataType}, start ${s.startValue})`}
                onClick={() => openInEditor(`SELECT * FROM ${qualified};`)}
              />
            );
          })}
        </SchemaSection>

        <SchemaSection
          title="Triggers"
          count={triggers.length}
          open={openSections.triggers !== false}
          onToggle={() => toggleSection('triggers')}
        >
          {triggers.map((t) => (
            <SimpleRow
              key={`${t.schema}.${t.table}.${t.name}`}
              icon={Zap}
              name={t.name}
              detail={t.table}
              title={`${t.timing} ${t.events} ON ${t.schema}.${t.table}${t.enabled ? '' : ' (disabled)'}`}
              onClick={() => openInEditor(`${t.definition};`)}
            />
          ))}
        </SchemaSection>
      </div>
    </div>
  );
}

function quoteIdent(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

function SchemaSection({
  title,
  count,
  open,
  onToggle,
  children,
}: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <div className="mt-2 border-t border-sidebar-border pt-1">
      <button
        type="button"
        onClick={onToggle}
        className="mx-2 flex h-7 w-[calc(100%-1rem)] items-center gap-1 rounded-md px-2 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span className="flex-1">{title}</span>
        <span className="font-mono text-[9px] normal-case tracking-normal">{count}</span>
      </button>
      {open && children}
    </div>
  );
}

function SimpleRow({
  icon: Icon,
  name,
  detail,
  title,
  onClick,
}: {
  icon: typeof Table2;
  name: string;
  detail?: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="group/row cv-row-28 mx-2 flex h-7 w-[calc(100%-1rem)] items-center gap-2 rounded-md px-2 text-left font-mono text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {detail ? (
        <span className="max-w-[40%] shrink-0 truncate font-mono text-[9px] text-muted-foreground/80">
          {detail}
        </span>
      ) : null}
    </button>
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
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Filter entity types"
          title="Filter entity types"
          className={!allOn ? 'text-primary' : 'text-muted-foreground'}
        >
          <FilterIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={4} className="w-[220px] p-3">
        <h3 className="mb-2 font-display text-xs italic text-muted-foreground">
          Show entity types
        </h3>
        <div className="flex flex-col gap-1">
          {ENTITY_KIND_ORDER.map((k) => {
            const on = entityFilter.has(k);
            return (
              <label
                key={k}
                htmlFor={`entity-filter-${k}`}
                className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1 text-sm text-foreground hover:bg-accent"
              >
                <Checkbox
                  id={`entity-filter-${k}`}
                  checked={on}
                  onCheckedChange={() => toggle(k)}
                />
                <span className="font-mono text-xs">{ENTITY_KIND_LABELS[k]}</span>
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
      className={cn(
        'group/row cv-row-28 relative mx-2 flex h-7 items-stretch rounded-md transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        active && 'bg-sidebar-accent text-sidebar-accent-foreground',
      )}
    >
      {active && (
        <div
          className="absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-full bg-primary"
          aria-hidden
        />
      )}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggleFavorite();
        }}
        aria-label={favorite ? `Unstar ${name}` : `Star ${name}`}
        className="group/star flex h-full w-7 shrink-0 cursor-pointer items-center justify-center"
      >
        <span className="relative grid h-4 w-4 place-items-center">
          <Icon
            className={cn(
              'absolute inset-0 m-auto h-3.5 w-3.5 transition-opacity duration-150',
              favorite
                ? 'opacity-0'
                : 'opacity-100 group-hover/row:opacity-0 group-focus-visible/star:opacity-0',
              active ? 'text-primary' : 'text-muted-foreground',
            )}
          />
          <Star
            className={cn(
              'absolute inset-0 m-auto h-3.5 w-3.5 transition-opacity duration-150',
              favorite
                ? 'fill-primary text-primary opacity-100'
                : 'text-muted-foreground opacity-0 group-hover/row:opacity-100 group-focus-visible/star:opacity-100',
            )}
          />
        </span>
      </button>
      <button
        type="button"
        onClick={onClick}
        title={`Open ${name}`}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 pl-1 pr-3 text-left font-mono text-xs',
          active
            ? 'text-foreground'
            : 'text-muted-foreground group-hover/row:text-sidebar-accent-foreground',
        )}
      >
        <span className="truncate">{name}</span>
      </button>
    </div>
  );
}
