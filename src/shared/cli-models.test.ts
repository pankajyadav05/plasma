import { describe, expect, it } from 'vitest';
import type { AiModel } from './ai-models';
import {
  EFFORT_OPTION,
  SERVICE_TIER_OPTION,
  cliTraits,
  explicitOption,
  shortModelName,
  storedOption,
} from './cli-models';

const model = {
  capabilities: {
    optionDescriptors: [
      {
        id: EFFORT_OPTION,
        label: 'Reasoning',
        type: 'select',
        options: [
          { id: 'low', label: 'Low' },
          { id: 'medium', label: 'Medium', isDefault: true },
          { id: 'high', label: 'High' },
        ],
      },
      {
        id: SERVICE_TIER_OPTION,
        label: 'Speed',
        type: 'select',
        options: [
          { id: 'default', label: 'Standard', isDefault: true },
          { id: 'priority', label: 'Fast' },
        ],
      },
    ],
  },
} as unknown as Pick<AiModel, 'capabilities'>;

describe('cliTraits', () => {
  it('shows the model default when nothing is saved', () => {
    const t = cliTraits('codex', model, { effort: '', serviceTier: '' });
    expect(t.label).toBe('Medium');
    expect(t.effort?.value).toBe('medium');
    expect(t.tier?.value).toBe('default');
  });

  it('names a non-default level and speed', () => {
    expect(cliTraits('codex', model, { effort: 'high', serviceTier: 'priority' }).label).toBe(
      'High · Fast',
    );
  });

  it('Claude Code has no speed choice', () => {
    const t = cliTraits('claude-code', model, { effort: 'low', serviceTier: 'priority' });
    expect(t.tier).toBeNull();
    expect(t.label).toBe('Low');
  });

  it('a model without options, or an unknown one, has no traits', () => {
    expect(cliTraits('codex', null, {}).label).toBe('');
    expect(cliTraits('codex', { capabilities: { optionDescriptors: [] } }, {}).effort).toBeNull();
  });

  it('a saved value the model does not offer falls back to its default', () => {
    expect(cliTraits('codex', model, { effort: 'max' }).label).toBe('Medium');
  });
});

describe('storedOption', () => {
  const options = cliTraits('codex', model, {}).effort?.options ?? [];
  it('stores "" for the default, else the id the run sends', () => {
    expect(storedOption(options, 'medium')).toBe('');
    expect(storedOption(options, 'high')).toBe('high');
    // What the chip stores is what the run sends: nothing for '', the pick otherwise.
    expect(explicitOption(model, EFFORT_OPTION, storedOption(options, 'high'))).toBe('high');
    expect(explicitOption(model, EFFORT_OPTION, storedOption(options, 'medium'))).toBeUndefined();
  });
});

describe('shortModelName', () => {
  it('drops the maker word, keeps GPT names, prefers an explicit short name', () => {
    expect(shortModelName({ name: 'Claude Haiku 5.5' })).toBe('Haiku 5.5');
    expect(shortModelName({ name: 'GPT-6 Luna' })).toBe('GPT-6 Luna');
    expect(shortModelName({ name: 'Claude' })).toBe('Claude');
    expect(shortModelName({ name: 'Claude Haiku 5.5', shortName: 'Haiku' })).toBe('Haiku');
  });
});
