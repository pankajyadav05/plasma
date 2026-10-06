/**
 * Which AI provider is set up, what it is called, and what a chat sends.
 * Pure, so the wording the panel shows ("What is sent") is tested.
 */
import { AI_SCHEMA_MAX_TABLES } from '@shared/ai-schema-policy';
import type { Settings } from '@shared/protocol';

type ProviderSettings = Partial<
  Pick<
    Settings,
    | 'aiProvider'
    | 'aiLocalModel'
    | 'aiLocalUrl'
    | 'openrouterModel'
    | 'hasOpenrouterApiKey'
    | 'hasClaudeApiKey'
    | 'openrouterApiKey'
    | 'claudeApiKey'
  >
>;

/** AI is ready to use: a key for OpenRouter, a model name for a local server. */
export function aiConfigured(s: ProviderSettings | undefined): boolean {
  if (!s) return false;
  if (s.aiProvider === 'local') return Boolean(s.aiLocalModel?.trim());
  return Boolean(
    s.hasOpenrouterApiKey || s.hasClaudeApiKey || s.openrouterApiKey || s.claudeApiKey,
  );
}

/** What is missing, for notices and rejected requests. */
export function aiSetupHint(s: ProviderSettings | undefined): string {
  return s?.aiProvider === 'local'
    ? 'Choose a local model in Settings, AI.'
    : 'Add an OpenRouter key in Settings, AI.';
}

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  'meta-llama': 'Meta',
  mistralai: 'Mistral',
  qwen: 'Qwen',
  deepseek: 'DeepSeek',
  'x-ai': 'xAI',
};

/**
 * Badge label for an OpenRouter model id: "anthropic/claude-sonnet-4.5" →
 * "Anthropic · claude-sonnet-4.5". The request always goes through
 * OpenRouter; the prefix names the model's actual provider (G3).
 */
export function modelLabel(model: string): string {
  const slash = model.indexOf('/');
  if (slash === -1) return model;
  const vendor = model.slice(0, slash);
  return `${PROVIDER_NAMES[vendor] ?? vendor} · ${model.slice(slash + 1)}`;
}

/** Header badge: "Anthropic · claude-sonnet-4.5" or "Local · llama3.1". */
export function aiBadgeLabel(s: ProviderSettings): string {
  if (s.aiProvider === 'local') return `Local · ${s.aiLocalModel?.trim() || 'no model set'}`;
  return modelLabel(s.openrouterModel ?? '');
}

/** Tooltip for the badge: where requests go. */
export function aiBadgeTitle(s: ProviderSettings): string {
  return s.aiProvider === 'local'
    ? `${s.aiLocalModel?.trim() || 'No model'} on this machine (${s.aiLocalUrl ?? ''}). Nothing leaves your computer.`
    : `${s.openrouterModel} via OpenRouter (your API key)`;
}

/** "OpenRouter · anthropic/claude-sonnet-4.5" or "Local · llama3.1". */
function providerLine(s: ProviderSettings): string {
  return s.aiProvider === 'local'
    ? `Local · ${s.aiLocalModel?.trim() || 'no model set'}`
    : `OpenRouter · ${s.openrouterModel ?? ''}`;
}

/**
 * The line under the composer: exactly what the next message sends. Built
 * from the same facts main enforces (schema policy, row-data opt-in), so it
 * cannot promise less or more than what leaves.
 */
export function describeAiSends(input: {
  settings: ProviderSettings;
  /** SQL engines get schema + current tab; the others a connection overview. */
  sql: boolean;
  schemaAllowed: boolean;
  tableCount: number;
  hasContext: boolean;
  rowData: boolean;
  /** Images in the draft: they go to the model with the next message. */
  images?: number;
}): string {
  const parts = [providerLine(input.settings)];
  if (input.sql) {
    const n = Math.min(input.tableCount, AI_SCHEMA_MAX_TABLES);
    parts.push(
      input.schemaAllowed && n > 0 ? `Schema: ${n} ${n === 1 ? 'table' : 'tables'}` : 'Schema: off',
    );
    parts.push(`Current tab: ${input.schemaAllowed && input.hasContext ? 'sent' : 'off'}`);
  } else {
    parts.push(`Overview: ${input.schemaAllowed ? 'sent' : 'off'}`);
  }
  parts.push(`Row data: ${input.rowData ? 'capped samples' : 'off'}`);
  if (input.images) parts.push(`Images: ${input.images}`);
  return parts.join(' · ');
}
