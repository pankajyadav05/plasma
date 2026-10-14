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
