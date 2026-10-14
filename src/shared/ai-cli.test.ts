import { describe, expect, it } from 'vitest';
import {
  AiCliStatusRequest,
  CLI_INSTALL_DOCS,
  cliBadge,
  cliBasenameOk,
  cliPlanLabel,
  cliProviderName,
  isAiCliProvider,
} from './ai-cli';
import { SettingsShape } from './protocol';

describe('aiProvider settings', () => {
  it('old stored values still parse', () => {
    expect(SettingsShape.parse({ aiProvider: 'openrouter' }).aiProvider).toBe('openrouter');
    expect(SettingsShape.parse({ aiProvider: 'local' }).aiProvider).toBe('local');
    expect(SettingsShape.parse({}).aiProvider).toBe('openrouter');
  });

  it('the two CLI providers are accepted', () => {
    expect(SettingsShape.parse({ aiProvider: 'codex' }).aiProvider).toBe('codex');
    expect(SettingsShape.parse({ aiProvider: 'claude-code' }).aiProvider).toBe('claude-code');
  });

  it('a value from a newer or older build falls back to OpenRouter instead of failing', () => {
    expect(SettingsShape.parse({ aiProvider: 'gemini-cli' }).aiProvider).toBe('openrouter');
    expect(SettingsShape.parse({ aiProvider: 7 }).aiProvider).toBe('openrouter');
  });

  it('has the CLI model and path settings with their defaults', () => {
    const s = SettingsShape.parse({});
    expect(s.aiCodexModel).toBe('');
    expect(s.aiClaudeCodeModel).toBe('sonnet');
    expect(s.aiCodexPath).toBe('');
    expect(s.aiClaudeCodePath).toBe('');
    const set = SettingsShape.parse({ aiCodexModel: 'gpt-6-luna', aiClaudeCodePath: '/x/claude' });
    expect(set.aiCodexModel).toBe('gpt-6-luna');
    expect(set.aiClaudeCodePath).toBe('/x/claude');
  });
});

describe('provider helpers', () => {
  it('names and recognises the providers', () => {
    expect(isAiCliProvider('codex')).toBe(true);
    expect(isAiCliProvider('claude-code')).toBe(true);
    expect(isAiCliProvider('local')).toBe(false);
    expect(isAiCliProvider(undefined)).toBe(false);
    expect(cliProviderName('codex')).toBe('Codex');
    expect(cliProviderName('claude-code')).toBe('Claude Code');
  });

  it('labels the provider and model the way the chat shows them', () => {
    expect(cliBadge('codex', 'gpt-6.1-sol')).toBe('Codex · gpt-6.1-sol');
    expect(cliBadge('claude-code', 'sonnet')).toBe('Claude Code · sonnet');
    expect(cliBadge('codex', '')).toBe('Codex · default model');
  });

  it('labels plans', () => {
    expect(cliPlanLabel('codex', 'plus')).toBe('ChatGPT Plus Subscription');
    expect(cliPlanLabel('claude-code', 'max')).toBe('Claude Max');
    expect(cliPlanLabel('claude-code', 'Pro')).toBe('Claude Pro');
    expect(cliPlanLabel('codex', 'self_serve_business_prolite')).toBe(
      'ChatGPT Business Subscription',
    );
    expect(cliPlanLabel('codex', 'prolite')).toBe('ChatGPT Pro 5x Subscription');
    expect(cliPlanLabel('codex', 'new_thing')).toBe('ChatGPT New Thing');
  });

  it('only files called codex / claude may be chosen', () => {
    expect(cliBasenameOk('codex', '/usr/bin/codex')).toBe(true);
    expect(cliBasenameOk('codex', 'C:\\npm\\Codex.CMD')).toBe(true);
    expect(cliBasenameOk('claude-code', '/a/claude.exe')).toBe(true);
    expect(cliBasenameOk('claude-code', '/a/codex')).toBe(false);
    expect(cliBasenameOk('codex', '/bin/sh')).toBe(false);
    expect(cliBasenameOk('codex', '/a/codex.sh')).toBe(false);
    expect(cliBasenameOk('codex', '/a/mycodex')).toBe(false);
  });

  it('the status request takes a provider and nothing else', () => {
    expect(AiCliStatusRequest.safeParse({ provider: 'codex' }).success).toBe(true);
    expect(AiCliStatusRequest.safeParse({ provider: 'openrouter' }).success).toBe(false);
    expect(Object.keys(CLI_INSTALL_DOCS).sort()).toEqual(['claude-code', 'codex']);
  });
});
