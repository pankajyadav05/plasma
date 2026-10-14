/**
 * Codex and Claude Code model lists, built the way T3 Code builds them (MIT,
 * Copyright (c) 2026 T3 Tools Inc.; see THIRD_PARTY.md): packages/provider-core
 * ModelCatalog.ts, apps/server CodexProvider.ts and ClaudeModelCatalog.ts.
 *
 * Codex: live discovery (`model/list`) with the manifest as an overlay (legacy,
 * default). Claude Code: a static catalog from the manifest, filtered by the
 * installed version. Pure, so it is tested without a program.
 */
import type {
  AiModel,
  CliCapabilities,
  CliOption,
  CliOptionDescriptor,
  CliUpdateRequired,
} from '@shared/ai-models';
import {
  EFFORT_OPTION,
  SERVICE_TIER_OPTION,
  explicitOption,
  findCliModel,
} from '@shared/cli-models';
import type { Manifest, ManifestCatalog, ManifestModel } from './model-manifest';
import { compareSemver } from './semver';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

// ───────────────────────── Codex ─────────────────────────

export const REASONING_EFFORT_LABELS: Readonly<Record<string, string>> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
  ultra: 'Ultra',
};

/**
 * Efforts Plasma does not offer: Ultra delegates to sub-agents (Plasma runs Codex
 * with multi-agent switched off), so it would behave like another level.
 */
const HIDDEN_CODEX_EFFORTS = new Set(['ultra']);

export const DEFAULT_CODEX_MODEL = 'gpt-6-astra';
/** Codex default-model preference, most preferred first. */
export const PREFERRED_DEFAULT_CODEX_MODELS: readonly string[] = [
  DEFAULT_CODEX_MODEL,
  'gpt-5.6-sol',
  'gpt-5.6-terra',
];
export const DEFAULT_SERVICE_TIER_ID = 'default';

/** Compare Codex model families without changing the id that is sent. */
export function codexModelFamily(slug: string): string {
  return slug.startsWith('openai.gpt-') ? slug.slice('openai.'.length) : slug;
}

export function formatCodexModelName(name: string): string {
  return name.replace(/^gpt/i, 'GPT').replace(/-([a-z])/g, (_, c: string) => `-${c.toUpperCase()}`);
}

const effortLabel = (id: string) => REASONING_EFFORT_LABELS[id] ?? id;

/** Shorter copy for tiers whose catalog description wraps in a menu. */
const SERVICE_TIER_DESCRIPTIONS: Readonly<Record<string, string>> = {
  ultrafast: 'Even faster, more expensive',
};

/** Reasoning efforts and service tiers of one `model/list` entry. */
export function mapCodexModelCapabilities(model: Json): CliCapabilities {
  const supported = Array.isArray(model.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts
    : [];
  const slug = typeof model.model === 'string' ? model.model : '';
  const wantedDefault =
    codexModelFamily(slug) === DEFAULT_CODEX_MODEL
      ? 'medium'
      : typeof model.defaultReasoningEffort === 'string'
        ? model.defaultReasoningEffort
        : undefined;
  const efforts: CliOption[] = [];
  for (const e of supported) {
    const id = isObj(e) && typeof e.reasoningEffort === 'string' ? e.reasoningEffort : null;
    if (!id || HIDDEN_CODEX_EFFORTS.has(id) || efforts.some((o) => o.id === id)) continue;
    efforts.push({
      id,
      label: effortLabel(id),
      ...(id === wantedDefault ? { isDefault: true } : {}),
    });
  }
  const effortDefault = efforts.find((o) => o.isDefault)?.id;

  type Tier = { id: string; name: string; description: string };
  const tiersRaw = Array.isArray(model.serviceTiers) ? model.serviceTiers : [];
  let tiers: Tier[] = [];
  for (const t of tiersRaw) {
    if (isObj(t) && typeof t.id === 'string' && t.id) {
      tiers.push({
        id: t.id,
        name: typeof t.name === 'string' && t.name ? t.name : t.id,
        description: typeof t.description === 'string' ? t.description : '',
      });
    }
  }
  if (tiers.length === 0 && Array.isArray(model.additionalSpeedTiers)) {
    tiers = model.additionalSpeedTiers
      .filter((id): id is string => typeof id === 'string' && id !== '')
      .map((id) => ({ id, name: id === 'fast' ? 'Fast' : id, description: '' }));
  }
  const catalogDefaultTier =
    typeof model.defaultServiceTier === 'string' &&
    tiers.some((t) => t.id === model.defaultServiceTier)
      ? model.defaultServiceTier
      : null;
  const defaultTier = catalogDefaultTier ?? DEFAULT_SERVICE_TIER_ID;

  const descriptors: CliOptionDescriptor[] = [];
  if (efforts.length > 0) {
    descriptors.push({
      id: EFFORT_OPTION,
      label: 'Reasoning',
      type: 'select',
      options: efforts,
      ...(effortDefault ? { currentValue: effortDefault } : {}),
    });
  }
  if (tiers.length > 0) {
    descriptors.push({
      id: SERVICE_TIER_OPTION,
      label: 'Speed',
      type: 'select',
      options: [
        {
          id: DEFAULT_SERVICE_TIER_ID,
          label: 'Standard',
          ...(defaultTier === DEFAULT_SERVICE_TIER_ID ? { isDefault: true } : {}),
        },
        ...tiers.map((t) => {
          const description = SERVICE_TIER_DESCRIPTIONS[t.id] ?? t.description;
          return {
            id: t.id,
            label: t.name,
            ...(description ? { description } : {}),
            ...(defaultTier === t.id ? { isDefault: true } : {}),
          };
        }),
      ],
      currentValue: defaultTier,
    });
  }
  return { optionDescriptors: descriptors };
}

function cliModel(
  vendor: string,
  vendorName: string,
  fields: Pick<AiModel, 'id' | 'name'> & Partial<AiModel>,
): AiModel {
  return {
    vendor,
    vendorName,
    created: 0,
    contextLength: null,
    promptPrice: null,
    completionPrice: null,
    tools: true,
    vision: true,
    free: false,
    expires: null,
    ...fields,
  };
}

/** One `model/list` page → models. Hidden models are skipped. */
export function parseCodexModelListPage(response: unknown): AiModel[] {
  const data = isObj(response) && Array.isArray(response.data) ? response.data : [];
  const out: AiModel[] = [];
  for (const raw of data) {
    if (!isObj(raw) || raw.hidden === true) continue;
    const slug = typeof raw.model === 'string' && raw.model ? raw.model : raw.id;
    if (typeof slug !== 'string' || !slug) continue;
    const display = typeof raw.displayName === 'string' && raw.displayName ? raw.displayName : slug;
    out.push(
      cliModel('openai', 'OpenAI', {
        id: slug,
        name: formatCodexModelName(display),
        ...(raw.isDefault === true ? { isDefault: true } : {}),
        capabilities: mapCodexModelCapabilities({ ...raw, model: slug }),
      }),
    );
  }
  return out;
}

/** Legacy from the manifest (by slug or family); nothing else changes. Also readable names from the manifest. */
export function classifyCatalogModels(
  models: readonly AiModel[],
  catalog: ManifestCatalog | undefined,
  family: (slug: string) => string = (s) => s,
): AiModel[] {
  return models.map((model) => {
    const entry =
      catalog?.models.find((c) => c.slug === model.id) ??
      catalog?.models.find((c) => c.slug === family(model.id));
    const { isLegacy: _drop, ...rest } = model;
    if (entry?.status === 'legacy') return { ...rest, isLegacy: true };
    return rest;
  });
}

/** Move the default to `slug` when the list has it. */
function moveDefault(models: readonly AiModel[], slug: string | undefined): AiModel[] {
  if (!slug || !models.some((m) => m.id === slug)) return [...models];
  return models.map((m) => {
    if (m.id === slug) return m.isDefault ? m : { ...m, isDefault: true };
    if (!m.isDefault) return m;
    const { isDefault: _drop, ...rest } = m;
    return rest;
  });
}

/** The first of the preferred slugs the list has becomes the default; else Codex's own flag stays. */
export function applyPreferredCodexDefaultModel(models: readonly AiModel[]): AiModel[] {
  const preferred = PREFERRED_DEFAULT_CODEX_MODELS.flatMap((slug) =>
    models.filter((m) => codexModelFamily(m.id) === slug),
  )[0]?.id;
  return moveDefault(models, preferred);
}

/**
 * Codex's listed models (all pages) with the manifest laid over them: legacy
 * flags, readable names, and the default (manifest `defaults.chat` if the list
 * has it, else the preferred ranking, else Codex's own).
 */
export function buildCodexModels(pages: readonly unknown[], manifest: Manifest): AiModel[] {
  const catalog = manifest.providers.codex;
  const seen = new Set<string>();
  const listed: AiModel[] = [];
  for (const page of pages) {
    for (const m of parseCodexModelListPage(page)) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      listed.push(m);
    }
  }
  const named = listed.map((m) => {
    const entry = catalog.models.find((c) => c.slug === m.id);
    return entry ? { ...m, name: entry.name } : m;
  });
  const classified = classifyCatalogModels(named, catalog, codexModelFamily);
  const chat = catalog.defaults?.chat;
  if (chat && classified.some((m) => m.id === chat)) return moveDefault(classified, chat);
  return applyPreferredCodexDefaultModel(classified);
}

// ───────────────────────── Claude Code ─────────────────────────

export interface ClaudeCatalogEntry {
  model: AiModel;
  entry: ManifestModel;
  effortMap: Record<string, string | null>;
}

/** The manifest's Claude Code models, each with its capabilities from the profile. */
export function claudeCatalog(manifest: Manifest): ClaudeCatalogEntry[] {
  const catalog = manifest.providers['claude-code'];
  const chat = catalog.defaults?.chat;
  return catalog.models.map((entry) => {
    const profile = entry.profile ? catalog.profiles[entry.profile] : undefined;
    const runtime = profile?.adapter?.claudeCode;
    const capabilities = profile?.capabilities ?? { optionDescriptors: [] };
    const model = cliModel('anthropic', 'Anthropic', {
      id: entry.slug,
      name: entry.name,
      contextLength: runtime?.fixedContextWindowTokens ?? null,
      ...(entry.aliases?.length ? { aliases: entry.aliases } : {}),
      ...(chat === entry.slug ? { isDefault: true } : {}),
      ...(entry.status === 'legacy' ? { isLegacy: true } : {}),
      ...(entry.badge ? { badge: entry.badge } : {}),
      capabilities,
    });
    return { model, entry, effortMap: runtime?.effortMap ?? {} };
  });
}

function supportedBy(entry: ManifestModel, version: string | null | undefined): boolean {
  const c = entry.adapter?.claudeCode;
  if (!c?.minVersion && !c?.maxVersionExclusive) return true;
  if (!version) return false;
  if (c.minVersion && (compareSemver(version, c.minVersion) ?? 0) < 0) return false;
  if (c.maxVersionExclusive && (compareSemver(version, c.maxVersionExclusive) ?? 0) >= 0) {
    return false;
  }
  return true;
}

/**
 * The models the installed Claude Code can run, and the current ones it is too
 * old for (shown as "Update Claude Code to v… to use").
 */
export function claudeModelsForVersion(
  manifest: Manifest,
  version: string | null | undefined,
): { models: AiModel[]; updateRequired: CliUpdateRequired[] } {
  const all = claudeCatalog(manifest);
  const models = all.filter((c) => supportedBy(c.entry, version)).map((c) => c.model);
  const updateRequired: CliUpdateRequired[] = [];
  if (version) {
    for (const { model, entry } of all) {
      const min = entry.adapter?.claudeCode?.minVersion;
      if (model.isLegacy || !min || (compareSemver(version, min) ?? 0) >= 0) continue;
      updateRequired.push({
        slug: model.id,
        name: model.name,
        minVersion: min,
        ...(model.badge ? { badge: model.badge } : {}),
      });
    }
  }
  return { models, updateRequired };
}

/**
 * The canonical slug for a saved model: 'sonnet' -> 'claude-sonnet-5-5', '' -> the
 * manifest's chat default. A name the manifest does not know (a full model name
 * the user typed) goes through unchanged.
 */
export function resolveClaudeSlug(manifest: Manifest, saved: string | undefined): string {
  const v = saved?.trim() ?? '';
  const catalog = claudeCatalog(manifest).map((c) => c.model);
  if (!v)
    return (
      manifest.providers['claude-code'].defaults?.chat ?? catalog.find((m) => m.isDefault)?.id ?? ''
    );
  return findCliModel(catalog, v)?.id ?? v;
}

/** The value for `--effort`: the user's pick when this model offers it, mapped through the profile; else nothing. */
export function claudeEffortArg(
  manifest: Manifest,
  slugOrAlias: string,
  saved: string | undefined,
): string | undefined {
  const entries = claudeCatalog(manifest);
  const found = findCliModel(
    entries.map((c) => c.model),
    slugOrAlias,
  );
  const entry = entries.find((c) => c.model.id === found?.id);
  const picked = explicitOption(entry?.model, EFFORT_OPTION, saved);
  if (!picked || !entry) return undefined;
  const map = entry.effortMap;
  if (Object.hasOwn(map, picked)) return map[picked] ?? undefined;
  return picked;
}

/** Codex: the effort to send on turn/start (only a non-default pick the model offers). */
export function codexEffortArg(model: AiModel | undefined, saved: string | undefined) {
  return explicitOption(model, EFFORT_OPTION, saved);
}

/** Codex: the service tier to send ('default' / Standard sends nothing). */
export function codexServiceTierArg(model: AiModel | undefined, saved: string | undefined) {
  const v = explicitOption(model, SERVICE_TIER_OPTION, saved);
  return v === DEFAULT_SERVICE_TIER_ID ? undefined : v;
}
