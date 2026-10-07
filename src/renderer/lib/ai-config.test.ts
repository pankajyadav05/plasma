import { describe, expect, it } from 'vitest';
import {
  aiBadgeLabel,
  aiBadgeTitle,
  aiConfigured,
  aiSetupHint,
  describeAiSends,
  modelLabel,
} from './ai-config';

describe('aiConfigured', () => {
  it('needs a key for OpenRouter and a model for a local server', () => {
    expect(aiConfigured({})).toBe(false);
    expect(aiConfigured({ hasOpenrouterApiKey: true })).toBe(true);
    expect(aiConfigured({ hasClaudeApiKey: true })).toBe(true);
    expect(aiConfigured({ aiProvider: 'openrouter', aiLocalModel: 'llama3.1' })).toBe(false);
    expect(aiConfigured({ aiProvider: 'local', aiLocalModel: '' })).toBe(false);
    expect(aiConfigured({ aiProvider: 'local', aiLocalModel: '  ' })).toBe(false);
    // A local model needs no key.
    expect(aiConfigured({ aiProvider: 'local', aiLocalModel: 'llama3.1' })).toBe(true);
    expect(aiConfigured(undefined)).toBe(false);
  });

  it('points at the missing piece', () => {
    expect(aiSetupHint({ aiProvider: 'local' })).toMatch(/local model/);
    expect(aiSetupHint({})).toMatch(/OpenRouter key/);
  });
});

describe('labels', () => {
  it('labels OpenRouter and local models', () => {
    expect(modelLabel('anthropic/claude-sonnet-4.5')).toBe('Anthropic · claude-sonnet-4.5');
    expect(aiBadgeLabel({ openrouterModel: 'openai/gpt-4o' })).toBe('OpenAI · gpt-4o');
    expect(aiBadgeLabel({ aiProvider: 'local', aiLocalModel: 'llama3.1' })).toBe(
      'Local · llama3.1',
    );
    expect(aiBadgeLabel({ aiProvider: 'local', aiLocalModel: '' })).toBe('Local · no model set');
    expect(
      aiBadgeTitle({
        aiProvider: 'local',
        aiLocalModel: 'llama3.1',
        aiLocalUrl: 'http://127.0.0.1:11434/v1',
      }),
    ).toContain('Nothing leaves your computer');
    expect(aiBadgeTitle({ openrouterModel: 'm' })).toBe('m via OpenRouter (your API key)');
  });
});

describe('describeAiSends', () => {
  it('lists the memory notes only when some are sent', () => {
    const base = {
      settings: { aiProvider: 'openrouter' as const, openrouterModel: 'a/b' },
      sql: true,
      schemaAllowed: true,
      tableCount: 2,
      hasContext: false,
      rowData: false,
    };
    expect(describeAiSends({ ...base, memory: 3 })).toMatch(/ · Memory: 3 notes$/);
    expect(describeAiSends({ ...base, memory: 1 })).toMatch(/ · Memory: 1 note$/);
    expect(describeAiSends({ ...base, memory: 0 })).not.toMatch(/Memory/);
    expect(describeAiSends(base)).not.toMatch(/Memory/);
  });

  const base = {
    settings: { openrouterModel: 'anthropic/claude-sonnet-4.5' },
    sql: true,
    schemaAllowed: true,
    tableCount: 12,
    hasContext: true,
    rowData: false,
  };

  it('is exact for the default case', () => {
    expect(describeAiSends(base)).toBe(
      'OpenRouter · anthropic/claude-sonnet-4.5 · Schema: 12 tables · Current tab: sent · Row data: off',
    );
  });

  it('adds the images of the draft', () => {
    expect(describeAiSends({ ...base, images: 2 })).toMatch(/Row data: off · Images: 2$/);
    expect(describeAiSends({ ...base, images: 0 })).not.toContain('Images');
  });

  it('says off when the schema may not be sent, and the tab goes with it', () => {
    expect(describeAiSends({ ...base, schemaAllowed: false })).toBe(
      'OpenRouter · anthropic/claude-sonnet-4.5 · Schema: off · Current tab: off · Row data: off',
    );
  });

  it('reports row samples, one table, no tab, and counts at most what main sends', () => {
    expect(describeAiSends({ ...base, rowData: true, tableCount: 1, hasContext: false })).toBe(
      'OpenRouter · anthropic/claude-sonnet-4.5 · Schema: 1 table · Current tab: off · Row data: capped samples',
    );
    expect(describeAiSends({ ...base, tableCount: 500 })).toContain('Schema: 80 tables');
    expect(describeAiSends({ ...base, tableCount: 0 })).toContain('Schema: off');
  });

  it('names the local model and has a line for non-SQL engines', () => {
    expect(
      describeAiSends({ ...base, settings: { aiProvider: 'local', aiLocalModel: 'llama3.1' } }),
    ).toBe('Local · llama3.1 · Schema: 12 tables · Current tab: sent · Row data: off');
    expect(describeAiSends({ ...base, sql: false })).toBe(
      'OpenRouter · anthropic/claude-sonnet-4.5 · Overview: sent · Row data: off',
    );
  });
});
