/**
 * What the model picker lists for a tab or a search: pure, so the grouping,
 * the "Use id" row and the vendor counts are tested without rendering.
 */
import {
  type AiModel,
  type CliUpdateRequired,
  OTHER_VENDOR,
  VENDORS,
  groupForVendor,
  looksLikeModelId,
  railVendor,
  searchModels,
  stubModel,
} from '@shared/ai-models';

export type PickerTab = 'start' | 'results' | string;

export type PickerItem =
  | { kind: 'header'; key: string; label: string }
  | { kind: 'model'; key: string; model: AiModel }
  | { kind: 'legacy'; key: string; vendor: string; count: number; open: boolean; label?: string }
  | { kind: 'use'; key: string; id: string }
  /** Claude Code: a current model the installed version cannot run (shown disabled). */
  | { kind: 'update'; key: string; name: string; slug: string; minVersion: string };

export type RailEntry = { id: string; name: string; count: number };

/** The vendor tiles that have models, main vendors in order, then Other. */
export function railEntries(models: readonly AiModel[]): RailEntry[] {
  const counts = new Map<string, number>();
  for (const m of models) counts.set(railVendor(m), (counts.get(railVendor(m)) ?? 0) + 1);
  const out: RailEntry[] = [];
  for (const v of [...VENDORS, OTHER_VENDOR]) {
    const count = counts.get(v.id) ?? 0;
    if (count > 0) out.push({ id: v.id, name: v.name, count });
  }
  return out;
}

const NEWEST_COUNT = 6;

export type PickerInput = {
  models: readonly AiModel[];
  /** 'start' (favourites, recent, newest), a rail vendor id, or ignored while `query` is set. */
  tab: PickerTab;
  query: string;
  favorites: readonly string[];
  recents: readonly string[];
  currentId: string;
  /** Rail vendors whose "Legacy models" group is expanded. */
  legacyOpen: ReadonlySet<string>;
  /** The local server's list: one flat group, any typed name can be used. */
  local: boolean;
  now: number;
  /** Only models that accept images. */
  visionOnly?: boolean;
  /** Codex / Claude Code: the CLI's list (current models, "Older models" group, update-required rows). */
  cli?: { updateRequired: readonly CliUpdateRequired[] };
};

/** The id offered as "Use …", or null when the query is not a usable id. */
function useId(input: PickerInput, query: string): string | null {
  if (!query) return null;
  const q = query.toLowerCase();
  if (
    input.models.some(
      (m) => m.id.toLowerCase() === q || m.aliases?.some((a) => a.toLowerCase() === q),
    )
  ) {
    return null;
  }
  if (input.local) return query;
  return looksLikeModelId(query) ? query : null;
}

export function buildPickerItems(input: PickerInput): PickerItem[] {
  const { now } = input;
  const visionOnly = input.visionOnly === true;
  const models = visionOnly ? input.models.filter((m) => m.vision) : input.models;
  const byId = new Map(models.map((m) => [m.id, m]));
  const resolve = (id: string) => byId.get(id) ?? stubModel(id);
  const query = input.query.trim();
  const items: PickerItem[] = [];
  const modelItem = (prefix: string, model: AiModel): PickerItem => ({
    kind: 'model',
    key: `${prefix}:${model.id}`,
    model,
  });

  if (query) {
    const found = searchModels(models, query)
      .sort((a, b) => b.created - a.created)
      .slice(0, 100);
    for (const m of found) items.push(modelItem('r', m));
    const id = useId(input, query);
    if (id) items.push({ kind: 'use', key: `use:${id}`, id });
    return items;
  }

  if (input.cli) {
    for (const m of models.filter((x) => !x.isLegacy)) items.push(modelItem('l', m));
    const older = models.filter((x) => x.isLegacy);
    if (older.length > 0) {
      const open = input.legacyOpen.has('cli');
      items.push({
        kind: 'legacy',
        key: 'legacy:cli',
        vendor: 'cli',
        count: older.length,
        open,
        label: 'Older models',
      });
      if (open) for (const m of older) items.push(modelItem('g', m));
    }
    if (input.cli.updateRequired.length > 0) {
      items.push({ kind: 'header', key: 'h:update', label: 'Needs a newer version' });
      for (const u of input.cli.updateRequired) {
        items.push({
          kind: 'update',
          key: `update:${u.slug}`,
          name: u.name,
          slug: u.slug,
          minVersion: u.minVersion,
        });
      }
    }
    return items;
  }

  if (input.local) {
    for (const m of models) items.push(modelItem('l', m));
    return items;
  }

  if (input.tab === 'start') {
    const shown = new Set<string>();
    const section = (key: string, label: string, list: AiModel[]) => {
      const fresh = list.filter((m) => !shown.has(m.id) && (!visionOnly || m.vision));
      if (fresh.length === 0) return;
      items.push({ kind: 'header', key: `h:${key}`, label });
      for (const m of fresh) {
        shown.add(m.id);
        items.push(modelItem(key, m));
      }
    };
    section('fav', 'Favourites', input.favorites.map(resolve));
    const recents = input.recents.includes(input.currentId)
      ? input.recents
      : [input.currentId, ...input.recents];
    section('recent', 'Recent', recents.filter((id) => id).map(resolve));
    const newest: AiModel[] = [];
    for (const v of VENDORS) {
      const mine = models.filter((m) => m.vendor === v.id);
      newest.push(...groupForVendor(mine, now).latest.slice(0, 2));
    }
    newest.sort((a, b) => b.created - a.created);
    section('new', 'Newest', newest.slice(0, NEWEST_COUNT + shown.size));
    return items;
  }

  const mine = models.filter((m) => railVendor(m) === input.tab);
  const { latest, legacy } = groupForVendor(mine, now);
  for (const m of latest) items.push(modelItem('v', m));
  if (legacy.length > 0) {
    const open = input.legacyOpen.has(input.tab);
    items.push({
      kind: 'legacy',
      key: `legacy:${input.tab}`,
      vendor: input.tab,
      count: legacy.length,
      open,
    });
    if (open) for (const m of legacy) items.push(modelItem('g', m));
  }
  return items;
}

/** Model rows in display order (the ones ⌘1–⌘9 count). */
export function modelRows(items: readonly PickerItem[]): AiModel[] {
  const out: AiModel[] = [];
  for (const i of items) if (i.kind === 'model') out.push(i.model);
  return out;
}
