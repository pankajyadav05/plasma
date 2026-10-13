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

/** Keyword -> label, first match wins ("self_serve_business_prolite" is a Business plan). */
const CODEX_PLANS: Array<[RegExp, string]> = [
  [/enterprise/, 'ChatGPT Enterprise'],
  [/business/, 'ChatGPT Business'],
  [/team/, 'ChatGPT Team'],
  [/edu/, 'ChatGPT Edu'],
  [/pro/, 'ChatGPT Pro'],
  [/plus/, 'ChatGPT Plus'],
  [/\bgo\b/, 'ChatGPT Go'],
  [/free/, 'ChatGPT Free'],
];

const words = (raw: string) =>
  raw
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

/** "plus" -> "ChatGPT Plus", "max" -> "Claude Max". */
export function cliPlanLabel(provider: AiCliProvider, raw: string): string {
  const key = raw.trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (provider === 'codex') {
    return CODEX_PLANS.find(([re]) => re.test(key))?.[1] ?? `ChatGPT ${words(key)}`.trim();
  }
  return `Claude ${words(key)}`.trim();
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

/** Choose (or reset) the program a CLI provider runs. Only main opens the file picker. */
export const AiCliChoosePathRequest = z.object({
  provider: AiCliProvider,
  /** Forget the chosen path and look for the program by itself again. */
  reset: z.boolean().optional(),
});
export type AiCliChoosePathRequest = z.infer<typeof AiCliChoosePathRequest>;

export type AiCliChoosePathResult = {
  /** The path now stored ('' = none: Plasma looks for the program itself). */
  path: string;
  /** Why the chosen file was refused. */
  error?: string;
};

/** The only file names a CLI provider may run: `codex` / `claude`, with the Windows suffixes. */
export function cliBasenameOk(provider: AiCliProvider, file: string): boolean {
  const base = file.split(/[\\/]/).pop() ?? '';
  const name = provider === 'codex' ? 'codex' : 'claude';
  return new RegExp(`^${name}(\\.exe|\\.cmd)?$`, 'i').test(base);
}
