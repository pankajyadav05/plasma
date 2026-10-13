import { describe, expect, it } from 'vitest';
import {
  aiBadgeLabel,
  aiBadgeTitle,
  aiConfigured,
  aiSetupHint,
  describeAiSends,
} from './ai-config';

describe('CLI providers', () => {
  const codex = { aiProvider: 'codex' as const, aiCodexModel: 'gpt-6.1-sol' };
  const claude = { aiProvider: 'claude-code' as const, aiClaudeCodeModel: 'sonnet' };

  it('need no API key', () => {
    expect(aiConfigured(codex)).toBe(true);
    expect(aiConfigured(claude)).toBe(true);
  });

  it('show provider and model wherever the provider is shown', () => {
    expect(aiBadgeLabel(codex)).toBe('Codex · gpt-6.1-sol');
    expect(aiBadgeLabel(claude)).toBe('Claude Code · sonnet');
    expect(aiBadgeLabel({ aiProvider: 'codex', aiCodexModel: '' })).toBe('Codex · default model');
    const line = describeAiSends({
      settings: codex,
      sql: true,
      schemaAllowed: true,
      tableCount: 3,
      hasContext: false,
      rowData: false,
    });
    expect(line.startsWith('Codex · gpt-6.1-sol · Schema: 3 tables')).toBe(true);
  });

  it('say where requests go and under whose account', () => {
    expect(aiBadgeTitle(codex)).toContain('ChatGPT account');
    expect(aiBadgeTitle(claude)).toContain('Claude account');
    expect(aiSetupHint(codex)).toBe('Check Codex in Settings, AI.');
  });
});
