import { z } from 'zod';

/**
 * The two AI providers that drive a command-line tool the user already installed
 * and signed into (Codex, Claude Code), so chats use their own plan instead of an
 * API key. Pure: wording and shapes shared by main and the renderer.
 */

export const AiCliProvider = z.enum(['codex', 'claude-code']);
export type AiCliProvider = z.infer<typeof AiCliProvider>;

export const isAiCliProvider = (v: unknown): v is AiCliProvider =>
  v === 'codex' || v === 'claude-code';

export const AiCliStatusRequest = z.object({ provider: AiCliProvider });
export type AiCliStatusRequest = z.infer<typeof AiCliStatusRequest>;

/** What the settings row shows. Never carries the account's e-mail address. */
export const AiCliStatus = z.object({
  provider: AiCliProvider,
  installed: z.boolean(),
  version: z.string().optional(),
  signedIn: z.boolean(),
  plan: z.string().optional(),
  path: z.string().optional(),
  error: z.string().optional(),
});
export type AiCliStatus = z.infer<typeof AiCliStatus>;

export function cliProviderName(provider: AiCliProvider): string {
  return provider === 'codex' ? 'Codex' : 'Claude Code';
}

const CODEX_PLANS: Record<string, string> = {
  free: 'ChatGPT Free',
  go: 'ChatGPT Go',
  plus: 'ChatGPT Plus',
  pro: 'ChatGPT Pro',
  prolite: 'ChatGPT Pro',
  team: 'ChatGPT Team',
  business: 'ChatGPT Business',
  enterprise: 'ChatGPT Enterprise',
  edu: 'ChatGPT Edu',
};

/** "plus" -> "ChatGPT Plus", "max" -> "Claude Max". */
export function cliPlanLabel(provider: AiCliProvider, raw: string): string {
  const key = raw.trim().toLowerCase();
  if (provider === 'codex') {
    return CODEX_PLANS[key] ?? `ChatGPT ${key.charAt(0).toUpperCase()}${key.slice(1)}`.trim();
  }
  return `Claude ${key.charAt(0).toUpperCase()}${key.slice(1)}`.trim();
}

/** The settings row: "Signed in · ChatGPT Plus", "Not installed", ... */
export function describeCliStatus(s: AiCliStatus | null): {
  tone: 'ok' | 'warn' | 'idle';
  text: string;
} {
  if (!s) return { tone: 'idle', text: 'Checking...' };
  const name = cliProviderName(s.provider);
  if (!s.installed) return { tone: 'warn', text: `${name} is not installed` };
  if (!s.signedIn) {
    return {
      tone: 'warn',
      text: `Not signed in: run \`${s.provider === 'codex' ? 'codex login' : 'claude'}\` in a terminal`,
    };
  }
  return { tone: 'ok', text: `Signed in${s.plan ? ` · ${s.plan}` : ''}` };
}

export const CLI_INSTALL_DOCS: Record<AiCliProvider, string> = {
  codex: 'https://developers.openai.com/codex/cli',
  'claude-code': 'https://docs.claude.com/en/docs/claude-code/setup',
};

/** What the model is called wherever the provider is shown: "Codex · gpt-6.1-sol". */
export function cliBadge(provider: AiCliProvider, model: string | undefined): string {
  return `${cliProviderName(provider)} · ${model?.trim() || 'default model'}`;
}
