import type { AiCliProvider } from '@shared/ai-cli';
import type { AiModelsResult } from '@shared/ai-models';
import { findCliModel, isSafeOptionId } from '@shared/cli-models';
import {
  claudeEffortArg,
  codexEffortArg,
  codexServiceTierArg,
  resolveClaudeSlug,
} from './cli-models';
import { manifestStore } from './model-manifest';
import { defaultResolveDeps, resolveBinary } from './resolve';
import { ensureShellEnv } from './shell-env';
import { claudeCliInfo, listCliModels } from './status';

/**
 * What a CLI chat is started with: the canonical model name, and the reasoning
 * effort / service tier the user picked. Starting a chat never lists models: it only
 * reads a list that is already in memory (whatever its age).
 */

const LIST_TTL_MS = 5 * 60_000;
const memo = new Map<string, { at: number; result: AiModelsResult }>();
const memoKey = (provider: AiCliProvider, override: string) => `${provider}\0${override}`;

/** The CLI's model list for the picker, kept for 5 minutes (listing Codex starts a program). */
export async function cachedCliModels(
  provider: AiCliProvider,
  override: string,
  cwd: string,
  refresh = false,
): Promise<AiModelsResult> {
  const key = memoKey(provider, override);
  const hit = memo.get(key);
  if (!refresh && hit && Date.now() - hit.at < LIST_TTL_MS) return hit.result;
  const result = await listCliModels(provider, override, cwd);
  // A list with a problem (empty, or a version that could not be read) is not kept.
  if (result.models.length > 0 && !result.error) memo.set(key, { at: Date.now(), result });
  return result;
}

/** A list the picker or settings already loaded, of any age; never starts a program. */
export function memoizedCliModels(provider: AiCliProvider, override: string) {
  return memo.get(memoKey(provider, override))?.result ?? null;
}

export function resetCliOptionsForTests(): void {
  memo.clear();
}

/** For tests: put a list in memory as if the picker had loaded it `at` ms. */
export function seedCliModelsForTests(
  provider: AiCliProvider,
  override: string,
  result: AiModelsResult,
  at = Date.now(),
): void {
  memo.set(memoKey(provider, override), { at, result });
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
}): Promise<CliRunChoices> {
  if (input.provider === 'claude-code') {
    await ensureShellEnv();
    const found = await resolveBinary('claude', input.binaryOverride, defaultResolveDeps()).catch(
      () => null,
    );
    const info = found ? await claudeCliInfo(found.path) : { effort: false };
    const manifest = await manifestStore().current();
    const model = resolveClaudeSlug(manifest, input.model, info.version);
    // `--effort` only when this Claude Code has the flag.
    const effort = info.effort ? claudeEffortArg(manifest, model, input.effort) : undefined;
    return { model, ...(effort ? { effort } : {}) };
  }
  const model = input.model.trim();
  const saved = memoizedCliModels('codex', input.binaryOverride);
  const effortSaved = input.effort.trim();
  const tierSaved = input.serviceTier.trim();
  if (!saved) {
    // No list in memory: pass the saved values as they are. A value Codex does not know is
    // refused by Codex with a readable message.
    return {
      model,
      ...(isSafeOptionId(effortSaved) ? { effort: effortSaved } : {}),
      ...(isSafeOptionId(tierSaved) && tierSaved !== 'default' ? { serviceTier: tierSaved } : {}),
    };
  }
  const picked = model ? findCliModel(saved.models, model) : saved.models.find((m) => m.isDefault);
  const effort = codexEffortArg(picked, effortSaved);
  const serviceTier = codexServiceTierArg(picked, tierSaved);
  return {
    model,
    ...(effort ? { effort } : {}),
    ...(serviceTier ? { serviceTier } : {}),
  };
}
