import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/cn';
import { ipc } from '@/lib/ipc';
import { MOD, isMac } from '@/lib/platform';
import { useSession } from '@/stores/session';
import {
  type AiModel,
  type AiModelsResult,
  OTHER_VENDOR,
  formatAgo,
  formatContext,
  formatPrice,
  isNew,
  pushRecent,
  stubModel,
  vendorMonogram,
} from '@shared/ai-models';
import {
  AlertTriangle,
  Boxes,
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  RefreshCw,
  Search,
  Star,
  Wrench,
  X,
} from 'lucide-react';
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  type PickerItem,
  type PickerTab,
  buildPickerItems,
  modelRows,
  railEntries,
} from './model-picker-rows';
import { VENDOR_LOGOS } from './vendor-logos';

/**
 * The assistant's model selector: a vendor rail, a search field and two-line
 * rows, fed live from OpenRouter (main caches it for 6 h) or from the local
 * server's own list. Colour comes from `--wb-*` tokens (vendor tiles mix a fixed hue into them),
 * so every palette, light and dark, gets the same calm graphite popover.
 */

// ───────────────────────── Data ─────────────────────────

const loaded = new Map<string, AiModelsResult>();
const loadListeners = new Set<() => void>();
let loadVersion = 0;
function noteLoaded(key: string, r: AiModelsResult) {
  loaded.set(key, r);
  loadVersion++;
  for (const l of loadListeners) l();
}
const subscribeLoaded = (l: () => void) => {
  loadListeners.add(l);
  return () => void loadListeners.delete(l);
};
const loadedVersion = () => loadVersion;

/** Whether the current model reads images: unknown for a local model or one not in the list. */
export function useCurrentModelVision(): { name: string; state: 'yes' | 'no' | 'unknown' } {
  const provider = useSession((s) => s.settings.aiProvider);
  const orModel = useSession((s) => s.settings.openrouterModel);
  useSyncExternalStore(subscribeLoaded, loadedVersion);
  if (provider === 'local') return { name: 'The local model', state: 'unknown' };
  const id = orModel?.trim() ?? '';
  const found = loaded.get('or')?.models.find((m) => m.id === id);
  if (!found) return { name: id ? stubModel(id).name : 'This model', state: 'unknown' };
  return { name: found.name, state: found.vision ? 'yes' : 'no' };
}

/** The model list for the active provider; stale-while-revalidate from main's cache. */
function useAiModelList(key: string, open: boolean) {
  const [result, setResult] = useState<AiModelsResult | null>(() => loaded.get(key) ?? null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  const load = useCallback(
    async (refresh: boolean) => {
      const mine = ++seq.current;
      setLoading(true);
      try {
        const r = await ipc.ai.listModels(refresh ? { refresh: true } : {});
        if (mine !== seq.current) return;
        noteLoaded(key, r);
        setResult(r);
      } catch (err) {
        if (mine !== seq.current) return;
        const next: AiModelsResult = {
          models: loaded.get(key)?.models ?? [],
          fetchedAt: loaded.get(key)?.fetchedAt ?? 0,
          source: loaded.get(key) ? 'cache' : 'none',
          error: err instanceof Error ? err.message : String(err),
        };
        setResult(next);
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [key],
  );

  // New provider or URL: start from what is known for it, then ask main.
  useEffect(() => {
    setResult(loaded.get(key) ?? null);
    void load(false);
  }, [key, load]);

  // Opening with nothing to show (first run, offline) tries again.
  const retry = result === null || result.source === 'none';
  useEffect(() => {
    if (open && retry) void load(false);
  }, [open, retry, load]);

  return { result, loading, refresh: () => load(true) };
}

// ───────────────────────── Vendor marks ─────────────────────────

/** Local model names hint at their maker ("llama3.1" → Meta). */
const LOCAL_FAMILIES: Array<[RegExp, string]> = [
  [/llama/i, 'meta-llama'],
  [/qwen|qwq/i, 'qwen'],
  [/mistral|mixtral|codestral|ministral/i, 'mistralai'],
  [/gemma|gemini/i, 'google'],
  [/deepseek/i, 'deepseek'],
  [/phi-?\d/i, 'microsoft'],
  [/gpt-oss/i, 'openai'],
  [/granite/i, 'ibm-granite'],
  [/command-?r|aya/i, 'cohere'],
  [/glm/i, 'z-ai'],
  [/kimi/i, 'moonshotai'],
];

function logoKey(vendor: string, modelName?: string): string {
  if (vendor === 'local' && modelName) {
    return LOCAL_FAMILIES.find(([re]) => re.test(modelName))?.[1] ?? 'ollama';
  }
  return vendor;
}

/** The vendor's logo; a neutral monogram tile for vendors without one. */
function VendorMark({
  vendor,
  name,
  modelName,
  size = 16,
}: {
  vendor: string;
  name: string;
  /** Local models: guess the maker from the model name. */
  modelName?: string;
  size?: number;
}) {
  const logo = VENDOR_LOGOS[logoKey(vendor, modelName)];
  if (logo) {
    const src = `data:image/svg+xml;utf8,${encodeURIComponent(logo.svg)}`;
    return logo.mono ? (
      <span
        aria-hidden
        className="shrink-0 bg-current"
        style={{
          width: size,
          height: size,
          maskImage: `url("${src}")`,
          WebkitMaskImage: `url("${src}")`,
          maskSize: 'contain',
          WebkitMaskSize: 'contain',
          maskRepeat: 'no-repeat',
          WebkitMaskRepeat: 'no-repeat',
          maskPosition: 'center',
          WebkitMaskPosition: 'center',
        }}
      />
    ) : (
      <img
        aria-hidden
        alt=""
        src={src}
        width={size}
        height={size}
        className="shrink-0"
        draggable={false}
      />
    );
  }
  if (vendor === OTHER_VENDOR.id) {
    return <Boxes aria-hidden className="shrink-0" style={{ width: size - 2, height: size - 2 }} />;
  }
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-[4px] bg-[var(--wb-control)] font-semibold leading-none text-[var(--wb-text-2)]"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.58) }}
    >
      {vendorMonogram(name)}
    </span>
  );
}

// ───────────────────────── Picker ─────────────────────────

export function ModelPicker({
  variant = 'composer',
  className,
  open: openProp,
  onOpenChange,
  imagesAttached = false,
}: {
  /** `composer`: a quiet chip under the chat input. `field`: a full-width settings field. */
  variant?: 'composer' | 'field';
  className?: string;
  /** Controlled open state (the composer opens it from its image warning). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The draft has images: the picker offers (and starts with) an "Images" filter. */
  imagesAttached?: boolean;
}) {
  const provider = useSession((s) => s.settings.aiProvider);
  const localUrl = useSession((s) => s.settings.aiLocalUrl);
  const orModel = useSession((s) => s.settings.openrouterModel);
  const localModel = useSession((s) => s.settings.aiLocalModel);
  const favorites = useSession((s) => s.settings.aiFavoriteModels ?? EMPTY);
  const recents = useSession((s) => s.settings.aiRecentModels ?? EMPTY);
  const updateSettings = useSession((s) => s.updateSettings);

  const local = provider === 'local';
  const currentId = (local ? localModel : orModel)?.trim() ?? '';
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (v: boolean) => {
    setOpenState(v);
    onOpenChange?.(v);
  };
  const { result, loading, refresh } = useAiModelList(local ? `local:${localUrl}` : 'or', open);
  const models = result?.models ?? EMPTY_MODELS;

  const current = useMemo(
    () => models.find((m) => m.id === currentId) ?? (currentId ? stubModel(currentId) : null),
    [models, currentId],
  );

  const choose = (id: string) => {
    if (local) void updateSettings({ aiLocalModel: id });
    else void updateSettings({ openrouterModel: id, aiRecentModels: pushRecent(recents, id) });
    setOpen(false);
  };
  const toggleFavorite = (id: string) => {
    const next = favorites.includes(id) ? favorites.filter((f) => f !== id) : [...favorites, id];
    void updateSettings({ aiFavoriteModels: next });
  };

  const label = current ? current.name : local ? 'Choose a model' : 'Choose a model';
  const vendorKey = current ? current.vendor : 'other';
  const markName = current ? current.vendorName : '?';

  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger asChild>
        {variant === 'composer' ? (
          <button
            type="button"
            aria-label={`Model: ${label}. Change model`}
            data-testid="ai-model-trigger"
            className={cn(
              'inline-flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded-[6px] pl-1 pr-1.5 text-[12px] leading-none text-[var(--wb-text-2)] transition-colors duration-100',
              'hover:bg-[var(--wb-control-hover)] hover:text-[var(--wb-text)]',
              'data-[state=open]:bg-[var(--wb-control)] data-[state=open]:text-[var(--wb-text)]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              className,
            )}
          >
            <VendorMark vendor={vendorKey} name={markName} modelName={current?.name} />
            <span className="truncate">{label}</span>
            <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
          </button>
        ) : (
          <button
            type="button"
            aria-label={`Model: ${label}. Change model`}
            data-testid="ai-model-trigger"
            className={cn(
              'flex h-[26px] w-full min-w-0 items-center gap-2 rounded-[7px] bg-[var(--wb-field)] px-2 text-left text-[13px] text-[var(--wb-text)]',
              'shadow-[inset_0_0_0_1px_var(--wb-toolbar-group-edge)] transition-shadow',
              'focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--ring),0_0_0_3px_color-mix(in_oklab,var(--ring)_30%,transparent)]',
              className,
            )}
          >
            <VendorMark vendor={vendorKey} name={markName} modelName={current?.name} />
            <span className="truncate">{label}</span>
            {current && current.id !== current.name && (
              <span className="truncate font-mono text-[11px] text-[var(--wb-text-3)]">
                {current.id}
              </span>
            )}
            <span className="flex-1" />
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--wb-text-2)]" />
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side={variant === 'composer' ? 'top' : 'bottom'}
        aria-label="Choose a model"
        onOpenAutoFocus={(e) => {
          // A picker opens to type in: the search field, not the first tile.
          e.preventDefault();
          (e.currentTarget as HTMLElement).querySelector('input')?.focus();
        }}
        className="flex h-[min(440px,var(--radix-popover-content-available-height))] w-[min(560px,calc(100vw-24px))] overflow-hidden p-0"
      >
        <PickerBody
          models={models}
          result={result}
          loading={loading}
          local={local}
          localUrl={localUrl}
          currentId={currentId}
          favorites={favorites}
          recents={recents}
          onChoose={choose}
          onToggleFavorite={toggleFavorite}
          onRefresh={() => void refresh()}
          imagesAttached={imagesAttached && !local}
        />
      </PopoverContent>
    </Popover>
  );
}

const EMPTY: string[] = [];
const EMPTY_MODELS: AiModel[] = [];

// ───────────────────────── Popover body ─────────────────────────

type BodyProps = {
  models: AiModel[];
  result: AiModelsResult | null;
  loading: boolean;
  local: boolean;
  localUrl: string;
  currentId: string;
  favorites: string[];
  recents: string[];
  onChoose: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  onRefresh: () => void;
  imagesAttached: boolean;
};

function PickerBody(props: BodyProps) {
  const { result, loading, local, currentId, favorites, recents } = props;
  const models = props.models;
  // With images in the draft only models that read them are useful: start filtered.
  const [visionOnly, setVisionOnly] = useState(props.imagesAttached);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<PickerTab>('start');
  const [legacyOpen, setLegacyOpen] = useState<Set<string>>(() => new Set());
  const [hiKey, setHiKey] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const now = useMemo(() => Date.now(), []);
  const searching = query.trim() !== '';

  const items = useMemo(
    () =>
      buildPickerItems({
        models,
        tab,
        query,
        favorites,
        recents,
        currentId,
        legacyOpen,
        local,
        now,
        visionOnly,
      }),
    [models, tab, query, favorites, recents, currentId, legacyOpen, local, now, visionOnly],
  );
  const rail = useMemo(
    () => railEntries(visionOnly ? models.filter((m) => m.vision) : models),
    [models, visionOnly],
  );

  const selectable = useMemo(() => items.filter((i) => i.kind !== 'header'), [items]);
  const numbers = useMemo(() => {
    const map = new Map<string, number>();
    for (const i of items) if (i.kind === 'model') map.set(i.key, map.size + 1);
    return map;
  }, [items]);

  // The highlighted row: the one the user moved to, else the current model
  // (when not searching), else the first.
  const hiIndex = useMemo(() => {
    const byKey = selectable.findIndex((i) => i.key === hiKey);
    if (byKey >= 0) return byKey;
    if (!searching) {
      const cur = selectable.findIndex((i) => i.kind === 'model' && i.model.id === currentId);
      if (cur >= 0) return cur;
    }
    return 0;
  }, [selectable, hiKey, searching, currentId]);
  const hiItem = selectable[hiIndex];

  useEffect(() => {
    if (!hiItem) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-key="${CSS.escape(hiItem.key)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [hiItem]);

  const toggleLegacy = (vendor: string) =>
    setLegacyOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(vendor)) next.add(vendor);
      return next;
    });

  const activate = (item: PickerItem | undefined) => {
    if (!item) return;
    if (item.kind === 'model') props.onChoose(item.model.id);
    else if (item.kind === 'use') props.onChoose(item.id);
    else if (item.kind === 'legacy') toggleLegacy(item.vendor);
  };

  const selectTab = (next: PickerTab) => {
    setQuery('');
    setTab(next);
    setHiKey(null);
    listRef.current?.scrollTo({ top: 0 });
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const inRail = (e.target as HTMLElement).closest('[data-rail]') !== null;
    const onButton = (e.target as HTMLElement).closest('button') !== null;
    if (mod && /^[1-9]$/.test(e.key)) {
      const row = modelRows(items)[Number(e.key) - 1];
      if (row) {
        e.preventDefault();
        props.onChoose(row.id);
      }
      return;
    }
    if (mod && e.key.toLowerCase() === 'd' && !local) {
      if (hiItem?.kind === 'model') {
        e.preventDefault();
        props.onToggleFavorite(hiItem.model.id);
      }
      return;
    }
    if (inRail) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (selectable.length === 0) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const next = selectable[(hiIndex + step + selectable.length) % selectable.length];
      setHiKey(next?.key ?? null);
    } else if (e.key === 'Enter' && !onButton) {
      e.preventDefault();
      activate(hiItem);
    }
  };

  const activeRail: string = searching ? 'results' : tab;
  const optionId = (key: string) => `model-opt-${key.replace(/[^\w-]/g, '_')}`;

  return (
    <div className="flex min-h-0 min-w-0 flex-1" onKeyDown={onKeyDown}>
      {!local && (
        <Rail
          entries={rail}
          active={activeRail}
          searching={searching}
          loading={loading && models.length === 0}
          onSelect={selectTab}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="shrink-0 border-b border-[var(--wb-separator)] p-2">
          <div className="flex items-center gap-1.5">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--wb-text-3)]" />
              <Input
                ref={inputRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setHiKey(null);
                }}
                placeholder={local ? 'Search or type a model name' : 'Search models'}
                aria-label="Search models"
                role="combobox"
                aria-expanded
                aria-controls="model-picker-list"
                aria-activedescendant={hiItem ? optionId(hiItem.key) : undefined}
                autoComplete="off"
                spellCheck={false}
                className="h-7 pl-7 pr-7"
              />
              {query && (
                <button
                  type="button"
                  aria-label="Clear search"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setQuery('');
                    inputRef.current?.focus();
                  }}
                  className="absolute right-1 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded-[4px] text-[var(--wb-text-3)] hover:bg-[var(--wb-control-hover)] hover:text-[var(--wb-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
            {props.imagesAttached && (
              <button
                type="button"
                aria-pressed={visionOnly}
                aria-label="Only models that accept images"
                data-testid="ai-picker-images-filter"
                onClick={() => {
                  setVisionOnly((v) => !v);
                  setHiKey(null);
                }}
                className={cn(
                  'inline-flex h-7 shrink-0 items-center gap-1 rounded-[6px] px-2 text-[12px] leading-none transition-colors duration-100',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  visionOnly
                    ? 'bg-[color-mix(in_oklab,var(--wb-accent)_16%,transparent)] text-[var(--wb-accent-text)]'
                    : 'bg-[var(--wb-control)] text-[var(--wb-text-2)] hover:bg-[var(--wb-control-hover)]',
                )}
              >
                <Eye aria-hidden className="h-3 w-3" />
                Images
              </button>
            )}
          </div>
        </div>

        <div
          ref={listRef}
          id="model-picker-list"
          // biome-ignore lint/a11y/useSemanticElements: a listbox driven by aria-activedescendant
          role="listbox"
          tabIndex={-1}
          aria-label="Models"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5"
        >
          {loading && models.length === 0 && !result?.error ? (
            <Skeleton />
          ) : (
            <>
              {items.map((item) =>
                item.kind === 'header' ? (
                  <div
                    key={item.key}
                    role="presentation"
                    className="px-2 pb-1 pt-2 text-[11px] font-medium text-[var(--wb-text-3)] first:pt-1"
                  >
                    {item.label}
                  </div>
                ) : (
                  <Row
                    key={item.key}
                    id={optionId(item.key)}
                    item={item}
                    highlighted={hiItem?.key === item.key}
                    current={
                      (item.kind === 'model' && item.model.id === currentId) ||
                      (item.kind === 'use' && item.id === currentId)
                    }
                    number={numbers.get(item.key)}
                    favorite={item.kind === 'model' && favorites.includes(item.model.id)}
                    canFavorite={!local}
                    now={now}
                    onHover={() => setHiKey(item.key)}
                    onActivate={() => activate(item)}
                    onToggleFavorite={props.onToggleFavorite}
                  />
                ),
              )}
              {items.length === 0 && (
                <EmptyList query={query.trim()} error={result?.error} local={local} />
              )}
              {items.length > 0 && result?.error && models.length === 0 && (
                <p className="px-2 pt-2 text-[12px] leading-snug text-[var(--wb-text-3)]">
                  {result.error} Type a model id to use it.
                </p>
              )}
            </>
          )}
        </div>

        <Footer
          result={result}
          loading={loading}
          local={local}
          localUrl={props.localUrl}
          onRefresh={props.onRefresh}
          now={now}
        />
      </div>
    </div>
  );
}

// ───────────────────────── Rail ─────────────────────────

function Rail({
  entries,
  active,
  searching,
  loading,
  onSelect,
}: {
  entries: { id: string; name: string; count: number }[];
  active: string;
  searching: boolean;
  loading: boolean;
  onSelect: (tab: PickerTab) => void;
}) {
  const tiles: { id: string; title: string; node: ReactNode }[] = [
    searching
      ? { id: 'results', title: 'Results', node: <Search className="h-3.5 w-3.5" /> }
      : {
          id: 'start',
          title: 'Favourites, recent and newest',
          node: <Star className="h-3.5 w-3.5" />,
        },
    ...entries.map((e) => ({
      id: e.id,
      title: `${e.name} · ${e.count}`,
      node: <VendorMark vendor={e.id} name={e.name} size={20} />,
    })),
  ];

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const ids = tiles.map((t) => t.id);
    const at = Math.max(0, ids.indexOf(active));
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? ids.length - 1
          : (at + (e.key === 'ArrowDown' ? 1 : -1) + ids.length) % ids.length;
    const id = ids[next];
    if (!id) return;
    if (id !== 'results') onSelect(id);
    // Selecting moves focus to the search field; the rail keeps it while arrowing.
    requestAnimationFrame(() =>
      e.currentTarget.querySelector<HTMLElement>(`[data-tile="${CSS.escape(id)}"]`)?.focus(),
    );
  };

  return (
    <div
      data-rail
      role="tablist"
      aria-orientation="vertical"
      aria-label="Vendors"
      onKeyDown={onKey}
      className="flex w-[44px] shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-[var(--wb-separator)] bg-[var(--wb-window)] py-2"
    >
      {tiles.map((t, i) => {
        const on = t.id === active;
        return (
          <div key={t.id} className="contents">
            <button
              type="button"
              role="tab"
              aria-selected={on}
              aria-label={t.title}
              data-tile={t.id}
              data-tooltip={t.title}
              tabIndex={on ? 0 : -1}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => (t.id === 'results' ? undefined : onSelect(t.id))}
              className={cn(
                'relative grid h-8 w-8 shrink-0 place-items-center rounded-[8px] text-[var(--wb-text-2)] transition-colors duration-100',
                'hover:bg-[var(--wb-control-hover)] hover:text-[var(--wb-text)]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                on && 'bg-[var(--wb-control-active)] text-[var(--wb-text)]',
                on &&
                  "before:absolute before:-left-[6px] before:top-2 before:bottom-2 before:w-[3px] before:rounded-r-full before:bg-[var(--wb-accent)] before:content-['']",
              )}
            >
              {t.node}
            </button>
            {i === 0 && <span aria-hidden className="my-0.5 h-px w-5 bg-[var(--wb-separator)]" />}
          </div>
        );
      })}
      {loading &&
        [0, 1, 2, 3].map((n) => (
          <span
            key={n}
            aria-hidden
            className="h-8 w-8 shrink-0 animate-pulse rounded-[8px] bg-[var(--wb-control)]"
          />
        ))}
    </div>
  );
}

// ───────────────────────── Rows ─────────────────────────

function Row({
  id,
  item,
  highlighted,
  current,
  number,
  favorite,
  canFavorite,
  now,
  onHover,
  onActivate,
  onToggleFavorite,
}: {
  id: string;
  item: Exclude<PickerItem, { kind: 'header' }>;
  highlighted: boolean;
  current: boolean;
  number: number | undefined;
  favorite: boolean;
  canFavorite: boolean;
  now: number;
  onHover: () => void;
  onActivate: () => void;
  onToggleFavorite: (id: string) => void;
}) {
  const shell = cn(
    'group/row relative flex w-full cursor-default items-center gap-2 rounded-[6px] px-2 text-left',
    highlighted && 'bg-[var(--wb-selected)]',
  );

  if (item.kind === 'legacy') {
    return (
      // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard goes through the search field (aria-activedescendant)
      <div
        id={id}
        data-key={item.key}
        // biome-ignore lint/a11y/useSemanticElements: an option of the combobox's listbox
        role="option"
        aria-selected={highlighted}
        aria-expanded={item.open}
        tabIndex={-1}
        onMouseMove={onHover}
        onClick={onActivate}
        className={cn(shell, 'mt-0.5 h-7 text-[12px] text-[var(--wb-text-2)]')}
      >
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 shrink-0 transition-transform duration-100',
            item.open && 'rotate-90',
          )}
        />
        <span>Legacy models · {item.count}</span>
      </div>
    );
  }

  if (item.kind === 'use') {
    return (
      // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard goes through the search field (aria-activedescendant)
      <div
        id={id}
        data-key={item.key}
        // biome-ignore lint/a11y/useSemanticElements: an option of the combobox's listbox
        role="option"
        aria-selected={highlighted}
        tabIndex={-1}
        onMouseMove={onHover}
        onClick={onActivate}
        className={cn(shell, 'h-9 text-[13px]')}
      >
        <span className="grid w-3.5 shrink-0 place-items-center">
          {current && <Check className="h-3.5 w-3.5 text-[var(--wb-accent-text)]" />}
        </span>
        <span className="min-w-0 flex-1 truncate text-[var(--wb-text)]">
          Use <span className="font-mono text-[12px]">{item.id}</span>
        </span>
        <span className="text-[11px] text-[var(--wb-text-3)]">Enter</span>
      </div>
    );
  }

  const m = item.model;
  const price = formatPrice(m);
  const context = formatContext(m.contextLength);
  const meta = [m.vendorName, context, price].filter(Boolean).join(' · ');
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard goes through the search field (aria-activedescendant)
    <div
      id={id}
      data-key={item.key}
      // biome-ignore lint/a11y/useSemanticElements: an option of the combobox's listbox
      role="option"
      aria-selected={highlighted}
      aria-current={current ? 'true' : undefined}
      aria-label={m.name}
      tabIndex={-1}
      onMouseMove={onHover}
      onClick={onActivate}
      className={cn(shell, 'h-11')}
    >
      <span className="grid w-3.5 shrink-0 place-items-center">
        {current && (
          <Check aria-label="Current model" className="h-3.5 w-3.5 text-[var(--wb-accent-text)]" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn(
              'truncate text-[13px] leading-[18px] text-[var(--wb-text)]',
              current && 'font-medium',
            )}
          >
            {m.name}
          </span>
          {isNew(m, now) && (
            <span className="shrink-0 rounded-[4px] bg-[color-mix(in_oklab,var(--wb-accent)_16%,transparent)] px-1 text-[11px] font-semibold leading-[15px] text-[var(--wb-accent-text)] [font-variant-caps:all-small-caps]">
              new
            </span>
          )}
          {m.tools ? (
            <Wrench
              aria-label="Supports tools"
              data-tooltip="Supports tool calling"
              className="h-3 w-3 shrink-0 text-[var(--wb-text-3)]"
            />
          ) : (
            <span
              data-tooltip="No tool calling: the agent cannot act on the workbench with this model"
              className="inline-flex shrink-0 items-center gap-0.5 rounded-[4px] bg-[color-mix(in_oklab,var(--status-warn)_14%,transparent)] px-1 text-[11px] leading-[15px] text-[var(--status-warn)]"
            >
              <AlertTriangle aria-hidden className="h-2.5 w-2.5" />
              No tools
            </span>
          )}
          {m.vision && (
            <Eye
              aria-label="Accepts images"
              data-tooltip="Accepts images"
              className="h-3 w-3 shrink-0 text-[var(--wb-text-3)]"
            />
          )}
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-[11.5px] leading-[16px] text-[var(--wb-text-3)]">
          <VendorMark vendor={m.vendor} name={m.vendorName} modelName={m.name} size={12} />
          <span className="min-w-0 truncate">{meta}</span>
        </div>
      </div>
      {number !== undefined && number <= 9 && (
        <span
          aria-hidden
          className={cn(
            'shrink-0 text-[11px] tabular-nums text-[var(--wb-text-3)]',
            !highlighted && 'opacity-80',
          )}
        >
          {isMac ? `${MOD}${number}` : `${MOD}+${number}`}
        </span>
      )}
      {canFavorite && (
        <button
          type="button"
          tabIndex={-1}
          aria-pressed={favorite}
          aria-label={favorite ? `Remove ${m.name} from favourites` : `Add ${m.name} to favourites`}
          data-tooltip={
            favorite ? 'Remove from favourites' : `Add to favourites (${MOD}${isMac ? '' : '+'}D)`
          }
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            onToggleFavorite(m.id);
          }}
          className={cn(
            'grid h-6 w-6 shrink-0 place-items-center rounded-[5px] transition-opacity duration-100',
            'hover:bg-[var(--wb-control-hover)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            favorite
              ? 'text-[var(--icon-star)]'
              : cn(
                  'text-[var(--wb-text-3)] hover:text-[var(--wb-text)]',
                  highlighted ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100',
                ),
          )}
        >
          <Star className={cn('h-3.5 w-3.5', favorite && 'fill-current')} />
        </button>
      )}
    </div>
  );
}

function Skeleton() {
  return (
    <div aria-hidden className="flex flex-col">
      {[62, 48, 70, 54, 66, 44].map((w) => (
        <div key={w} className="flex h-11 items-center gap-2 px-2">
          <span className="w-3.5 shrink-0" />
          <div className="flex flex-1 flex-col gap-1.5">
            <span
              className="h-3 animate-pulse rounded-[3px] bg-[var(--wb-control)]"
              style={{ width: `${w}%` }}
            />
            <span
              className="h-2.5 animate-pulse rounded-[3px] bg-[var(--wb-control)]"
              style={{ width: `${w - 22}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyList({
  query,
  error,
  local,
}: {
  query: string;
  error: string | undefined;
  local: boolean;
}) {
  return (
    <div className="flex h-full min-h-32 flex-col items-center justify-center gap-1 px-6 text-center">
      <div className="text-[13px] text-[var(--wb-text-2)]">
        {query
          ? `No models match "${query}"`
          : error
            ? 'Could not load the model list'
            : local
              ? 'The local server lists no models'
              : 'No models'}
      </div>
      <div className="text-[12px] leading-snug text-[var(--wb-text-3)]">
        {error && !query
          ? error
          : local
            ? 'Type the model name your server runs to use it.'
            : 'Type a model id, like anthropic/claude-sonnet-5.5, to use it.'}
      </div>
    </div>
  );
}

// ───────────────────────── Footer ─────────────────────────

function Footer({
  result,
  loading,
  local,
  localUrl,
  onRefresh,
  now,
}: {
  result: AiModelsResult | null;
  loading: boolean;
  local: boolean;
  localUrl: string;
  onRefresh: () => void;
  now: number;
}) {
  const when = result && result.fetchedAt > 0 ? formatAgo(result.fetchedAt, now) : null;
  let text: ReactNode;
  if (local) {
    text = result?.error ? (
      <span className="text-[var(--status-warn)]">{result.error}</span>
    ) : (
      `From ${localUrl}`
    );
  } else if (result?.error) {
    text = (
      <span className="inline-flex min-w-0 items-center gap-1 text-[var(--status-warn)]">
        <AlertTriangle aria-hidden className="h-3 w-3 shrink-0" />
        <span className="truncate">
          {when
            ? `Could not refresh. Showing the list from ${when}.`
            : 'Could not load the list from OpenRouter.'}
        </span>
      </span>
    );
  } else if (when) {
    text = `Updated ${when} from OpenRouter`;
  } else {
    text = loading ? 'Loading models…' : 'OpenRouter';
  }
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-t border-[var(--wb-separator)] px-3 text-[11px] text-[var(--wb-text-3)]">
      <div className="min-w-0 flex-1 truncate" title={result?.error}>
        {text}
      </div>
      <button
        type="button"
        onClick={onRefresh}
        disabled={loading}
        aria-label="Refresh model list"
        className="inline-flex h-5 shrink-0 items-center gap-1 rounded-[4px] px-1.5 text-[11px] text-[var(--wb-text-2)] transition-colors hover:bg-[var(--wb-control-hover)] hover:text-[var(--wb-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
      >
        <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
        Refresh
      </button>
    </div>
  );
}
