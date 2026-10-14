import type { AiCliProvider } from '@shared/ai-cli';
import type { AiModelsResult } from '@shared/ai-models';
import { findCliModel } from '@shared/cli-models';
import {
  claudeEffortArg,
  codexEffortArg,
  codexServiceTierArg,
  resolveClaudeSlug,
} from './cli-models';
import { manifestStore } from './model-manifest';
import { listCliModels } from './status';

/**
 * What a CLI chat is started with: the canonical model name, and the reasoning
 * effort / service tier the user picked, when the model offers them. A saved
 * value the model does not offer is dropped (the model's own default applies).
 */

const LIST_TTL_MS = 5 * 60_000;
const memo = new Map<string, { at: number; result: AiModelsResult }>();

/** The CLI's model list, kept for 5 minutes (listing Codex starts a program). */
export async function cachedCliModels(
  provider: AiCliProvider,
  override: string,
  cwd: string,
  refresh = false,
): Promise<AiModelsResult> {
  const key = `${provider}\0${override}`;
  const hit = memo.get(key);
  if (!refresh && hit && Date.now() - hit.at < LIST_TTL_MS) return hit.result;
  const result = await listCliModels(provider, override, cwd);
  if (result.models.length > 0) memo.set(key, { at: Date.now(), result });
  return result;
}

export interface CliRunChoices {
  model: string;
  effort?: string;
  serviceTier?: string;
}

export async function resolveCliRunChoices(input: {
  provider: AiCliProvider;
  model: string;
  effort: string;
  serviceTier: string;
  binaryOverride: string;
  cwd: string;
}): Promise<CliRunChoices> {
  if (input.provider === 'claude-code') {
    const manifest = await manifestStore().current();
    const model = resolveClaudeSlug(manifest, input.model);
    const effort = claudeEffortArg(manifest, model, input.effort);
    return { model, ...(effort ? { effort } : {}) };
  }
  const model = input.model.trim();
  if (!input.effort.trim() && !input.serviceTier.trim()) return { model };
  const list = await cachedCliModels('codex', input.binaryOverride, input.cwd).catch(() => null);
  const picked = list
    ? model
      ? findCliModel(list.models, model)
      : list.models.find((m) => m.isDefault)
    : undefined;
  const effort = codexEffortArg(picked, input.effort);
  const serviceTier = codexServiceTierArg(picked, input.serviceTier);
  return {
    model,
    ...(effort ? { effort } : {}),
    ...(serviceTier ? { serviceTier } : {}),
  };
}
