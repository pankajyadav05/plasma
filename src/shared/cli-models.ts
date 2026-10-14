import type { AiModel, CliOption, CliOptionDescriptor } from './ai-models';

/**
 * Reading what a Codex / Claude Code model offers (reasoning efforts, service
 * tiers). Pure, shared by main (what a run sends) and the renderer (what the
 * settings show), so a saved value the model does not offer falls back the same
 * way in both.
 */

export const EFFORT_OPTION = 'effort';
export const SERVICE_TIER_OPTION = 'serviceTier';

type SelectDescriptor = Extract<CliOptionDescriptor, { type: 'select' }>;

/** The select option list `id` of `model`, when it has one with at least one choice. */
export function selectDescriptor(
  model: Pick<AiModel, 'capabilities'> | null | undefined,
  id: string,
): SelectDescriptor | null {
  const d = model?.capabilities?.optionDescriptors.find((x) => x.id === id);
  return d && d.type === 'select' && d.options.length > 0 ? d : null;
}

/** The option the model marks as its default (or the descriptor's current value). */
export function defaultOption(d: SelectDescriptor): CliOption | undefined {
  return (
    d.options.find((o) => o.isDefault) ??
    (d.currentValue ? d.options.find((o) => o.id === d.currentValue) : undefined)
  );
}

/**
 * The value to use for option `id`: the saved one when the model offers it,
 * else the model's default. `undefined` when the model has no such option.
 */
export function effectiveOption(
  model: Pick<AiModel, 'capabilities'> | null | undefined,
  id: string,
  saved: string | undefined,
): string | undefined {
  const d = selectDescriptor(model, id);
  if (!d) return undefined;
  const wanted = saved?.trim();
  if (wanted && d.options.some((o) => o.id === wanted)) return wanted;
  return defaultOption(d)?.id;
}

/** A model name that is safe to hand to a program as an argument (never starts with "-"). */
export const SAFE_MODEL_RE = /^[A-Za-z0-9][\w.:@/[\]-]{0,127}$/;
/** A reasoning effort or service tier id. */
export const SAFE_OPTION_RE = /^[a-z][a-z0-9_-]{0,31}$/;
export const isSafeModelName = (v: string) => SAFE_MODEL_RE.test(v);
export const isSafeOptionId = (v: string) => SAFE_OPTION_RE.test(v);

/**
 * What to put on the wire: nothing for '' (the model's default, so a newer default applies
 * at once), else the value the user picked, even when it equals the model's default today.
 * A value the model does not offer is dropped.
 */
export function explicitOption(
  model: Pick<AiModel, 'capabilities'> | null | undefined,
  id: string,
  saved: string | undefined,
): string | undefined {
  const wanted = saved?.trim();
  if (!wanted) return undefined;
  const d = selectDescriptor(model, id);
  if (!d || !d.options.some((o) => o.id === wanted)) return undefined;
  return wanted;
}

/** Find a model by id or alias (case-insensitive for aliases). */
export function findCliModel<T extends Pick<AiModel, 'id' | 'aliases'>>(
  models: readonly T[],
  idOrAlias: string,
): T | undefined {
  const v = idOrAlias.trim();
  if (!v) return undefined;
  return (
    models.find((m) => m.id === v) ??
    models.find((m) => m.aliases?.some((a) => a.toLowerCase() === v.toLowerCase()))
  );
}

type OptionList = SelectDescriptor['options'];

/** What the composer's reasoning / speed control shows for a CLI model. */
export type CliTraits = {
  effort: { options: OptionList; value: string } | null;
  tier: { options: OptionList; value: string } | null;
  /** Chip text: "Medium", "High · Fast". Empty when the model offers neither. */
  label: string;
};

/**
 * The reasoning and speed choices of `model` with the saved values applied. Speed
 * is a Codex-only choice. The label names the reasoning level, and the speed only
 * when it is not the model's default ("High · Fast").
 */
export function cliTraits(
  provider: 'codex' | 'claude-code',
  model: Pick<AiModel, 'capabilities'> | null | undefined,
  saved: { effort?: string | undefined; serviceTier?: string | undefined },
): CliTraits {
  const e = selectDescriptor(model, EFFORT_OPTION);
  const t = provider === 'codex' ? selectDescriptor(model, SERVICE_TIER_OPTION) : null;
  const effort = e
    ? { options: e.options, value: effectiveOption(model, EFFORT_OPTION, saved.effort) ?? '' }
    : null;
  const tier = t
    ? {
        options: t.options,
        value: effectiveOption(model, SERVICE_TIER_OPTION, saved.serviceTier) ?? '',
      }
    : null;
  const nameOf = (x: { options: OptionList; value: string } | null) =>
    x?.options.find((o) => o.id === x.value);
  const parts = [nameOf(effort)?.label];
  const tierOpt = nameOf(tier);
  if (tierOpt && !tierOpt.isDefault) parts.push(tierOpt.label);
  return { effort, tier, label: parts.filter(Boolean).join(' · ') };
}

/** The value to store for a pick: '' for the model's default (so a newer default applies). */
export function storedOption(options: OptionList, picked: string): string {
  return options.find((o) => o.isDefault)?.id === picked ? '' : picked;
}

/**
 * A short name for the composer chip: the model's own `shortName`, else its name without
 * the maker's word ("Claude Haiku 5.5" -> "Haiku 5.5"; "GPT-6 Luna" stays).
 */
export function shortModelName(
  m: Pick<AiModel, 'name'> & { shortName?: string | undefined },
): string {
  if (m.shortName) return m.shortName;
  const short = m.name.replace(/^(Claude|Anthropic)\s+/i, '').trim();
  return short || m.name;
}
