import { describe, expect, it } from 'vitest';
import {
  type AiModel,
  formatAgo,
  formatContext,
  formatPrice,
  groupForVendor,
  isNew,
  looksLikeModelId,
  modelFamily,
  normalizeLocalModels,
  normalizeOpenRouterModels,
  pushRecent,
  railVendor,
  searchModels,
  vendorMonogram,
} from './ai-models';

const NOW = Date.UTC(2026, 9, 6);
const DAY = 86_400;
const ago = (days: number) => Math.floor(NOW / 1000) - days * DAY;

function model(over: Partial<AiModel> & { name: string }): AiModel {
  return {
    id: `anthropic/${over.name.toLowerCase().replace(/\s+/g, '-')}`,
    vendor: 'anthropic',
    vendorName: 'Anthropic',
    created: ago(10),
    contextLength: 200_000,
    promptPrice: 3,
    completionPrice: 15,
    tools: true,
    vision: false,
    free: false,
    expires: null,
    ...over,
  };
}

const raw = (over: Record<string, unknown>) => ({
  id: 'anthropic/claude-sonnet-5.5',
  name: 'Anthropic: Claude Sonnet 5.5',
  created: ago(5),
  context_length: 1_000_000,
  architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
  pricing: { prompt: '0.000003', completion: '0.000015' },
  supported_parameters: ['tools', 'temperature'],
  expiration_date: null,
  ...over,
});

describe('normalizeOpenRouterModels', () => {
  it('maps a live item', () => {
    const [m] = normalizeOpenRouterModels({ data: [raw({})] }, NOW);
    expect(m).toEqual({
      id: 'anthropic/claude-sonnet-5.5',
      name: 'Claude Sonnet 5.5',
      vendor: 'anthropic',
      vendorName: 'Anthropic',
      created: ago(5),
      contextLength: 1_000_000,
      promptPrice: 3,
      completionPrice: 15,
      tools: true,
      vision: true,
      free: false,
      expires: null,
    });
  });

  it('takes the vendor name from the name prefix for unknown vendors', () => {
    const [m] = normalizeOpenRouterModels(
      { data: [raw({ id: 'inclusionai/ling-3.1', name: 'inclusionAI: Ling 3.1' })] },
      NOW,
    );
    expect(m?.vendorName).toBe('inclusionAI');
    expect(m?.name).toBe('Ling 3.1');
    expect(railVendor(m as AiModel)).toBe('other');
  });

  it('marks free models and strips the (free) suffix', () => {
    const [m] = normalizeOpenRouterModels(
      {
        data: [
          raw({
            id: 'apodex/mini:free',
            name: 'Apodex: Apodex 1.1 Mini (free)',
            pricing: { prompt: '0', completion: '0' },
          }),
        ],
      },
      NOW,
    );
    expect(m?.free).toBe(true);
    expect(m?.name).toBe('Apodex 1.1 Mini');
  });

  it('drops batch, non-text, expired and malformed items without failing the list', () => {
    const list = normalizeOpenRouterModels(
      {
        data: [
          raw({ id: 'a/b:batch' }),
          raw({ id: 'a/img', architecture: { output_modalities: ['image'] } }),
          raw({ id: 'a/old', expiration_date: '2026-01-01' }),
          raw({ id: 'a/soon', expiration_date: '2027-01-01' }),
          { nope: true },
          null,
          raw({ id: 'a/ok' }),
        ],
      },
      NOW,
    );
    expect(list.map((m) => m.id)).toEqual(['a/soon', 'a/ok']);
    expect(list[0]?.expires).toBe(Math.floor(Date.UTC(2027, 0, 1) / 1000));
  });

  it('treats a negative price (router) as unknown and handles junk bodies', () => {
    const [m] = normalizeOpenRouterModels(
      { data: [raw({ pricing: { prompt: '-1', completion: '-1' } })] },
      NOW,
    );
    expect(m?.promptPrice).toBeNull();
    expect(normalizeOpenRouterModels('x', NOW)).toEqual([]);
    expect(normalizeOpenRouterModels({ data: 5 }, NOW)).toEqual([]);
  });

  it('reports tools false when the parameter is missing', () => {
    const [m] = normalizeOpenRouterModels({ data: [raw({ supported_parameters: [] })] }, NOW);
    expect(m?.tools).toBe(false);
  });
});

describe('normalizeLocalModels', () => {
  it('lists ids, skips junk and duplicates', () => {
    const list = normalizeLocalModels({ data: [{ id: 'llama3.1' }, { id: 'llama3.1' }, {}, 4] });
    expect(list.map((m) => m.id)).toEqual(['llama3.1']);
    expect(list[0]?.vendorName).toBe('Local');
    expect(normalizeLocalModels(null)).toEqual([]);
  });
});

describe('modelFamily', () => {
  it.each([
    ['Claude Opus 5.5', 'Claude Opus'],
    ['GPT-6.1 Sol Pro', 'GPT Sol Pro'],
    ['Claude 3.5 Sonnet', 'Claude Sonnet'],
    ['Gemini 2.5 Pro Preview', 'Gemini Pro'],
    ['Llama 3.1 70B Instruct', 'Llama Instruct'],
    ['Qwen3 235B', 'Qwen'],
    ['Foo Bar (2025-05-14)', 'Foo Bar'],
    ['Model Latest', 'Model'],
    ['5.5', '5.5'],
  ])('%s -> %s', (name, family) => {
    expect(modelFamily({ name })).toBe(family);
  });
});

describe('groupForVendor', () => {
  it('keeps the two newest per family from the last year, the rest is legacy', () => {
    const a55 = model({ name: 'Claude Opus 5.5', created: ago(5) });
    const a5 = model({ name: 'Claude Opus 5', created: ago(100) });
    const a4 = model({ name: 'Claude Opus 4', created: ago(200) });
    const sonnet = model({ name: 'Claude Sonnet 5.5', created: ago(8) });
    const ancient = model({ name: 'Claude Haiku 3', created: ago(500) });
    const { latest, legacy } = groupForVendor([a4, ancient, a5, sonnet, a55], NOW);
    expect(latest.map((m) => m.name)).toEqual([
      'Claude Opus 5.5',
      'Claude Sonnet 5.5',
      'Claude Opus 5',
    ]);
    expect(legacy.map((m) => m.name)).toEqual(['Claude Opus 4', 'Claude Haiku 3']);
  });

  it('does not let a free variant use up the paid slots', () => {
    const paid1 = model({ name: 'Foo 2', created: ago(1) });
    const paid2 = model({ name: 'Foo 1', created: ago(2) });
    const free = model({ name: 'Foo 3', created: ago(3), free: true });
    const { latest } = groupForVendor([paid1, paid2, free], NOW);
    expect(latest).toHaveLength(3);
  });
});

describe('isNew', () => {
  it('is true within 30 days only', () => {
    expect(isNew({ created: ago(29) }, NOW)).toBe(true);
    expect(isNew({ created: ago(31) }, NOW)).toBe(false);
    expect(isNew({ created: 0 }, NOW)).toBe(false);
  });
});

describe('searchModels', () => {
  const list = [
    model({ name: 'Claude Sonnet 5.5' }),
    model({ name: 'GPT-6', id: 'openai/gpt-6', vendor: 'openai', vendorName: 'OpenAI' }),
  ];
  it('matches name, id and vendor, every word, any case', () => {
    expect(searchModels(list, 'SONNET').map((m) => m.name)).toEqual(['Claude Sonnet 5.5']);
    expect(searchModels(list, 'openai gpt').map((m) => m.name)).toEqual(['GPT-6']);
    expect(searchModels(list, 'openai sonnet')).toEqual([]);
    expect(searchModels(list, 'anthropic/claude')).toHaveLength(1);
    expect(searchModels(list, '  ')).toHaveLength(2);
  });
  it('recognises id-shaped text', () => {
    expect(looksLikeModelId('acme/model-1:free')).toBe(true);
    expect(looksLikeModelId('claude')).toBe(false);
    expect(looksLikeModelId('a b/c')).toBe(false);
  });
});

describe('formatting', () => {
  it('formats context', () => {
    expect(formatContext(1_000_000)).toBe('1M');
    expect(formatContext(1_048_576)).toBe('1M');
    expect(formatContext(200_000)).toBe('200K');
    expect(formatContext(131_072)).toBe('131K');
    expect(formatContext(null)).toBe('');
  });
  it('formats price', () => {
    expect(formatPrice({ free: false, promptPrice: 3, completionPrice: 15 })).toBe(
      '$3 / $15 per 1M',
    );
    expect(formatPrice({ free: false, promptPrice: 0.075, completionPrice: 0.3 })).toBe(
      '$0.075 / $0.3 per 1M',
    );
    expect(formatPrice({ free: true, promptPrice: 0, completionPrice: 0 })).toBe('Free');
    expect(formatPrice({ free: false, promptPrice: null, completionPrice: null })).toBe('');
  });
  it('formats age and recents and monograms', () => {
    expect(formatAgo(NOW - 2 * 3600_000, NOW)).toBe('2 h ago');
    expect(formatAgo(NOW - 5_000, NOW)).toBe('just now');
    expect(pushRecent(['a', 'b', 'c'], 'b', 3)).toEqual(['b', 'a', 'c']);
    expect(pushRecent(['a', 'b', 'c'], 'd', 3)).toEqual(['d', 'a', 'b']);
    expect(vendorMonogram('Anthropic')).toBe('A');
    expect(vendorMonogram('DeepSeek')).toBe('DS');
    expect(vendorMonogram('OpenAI')).toBe('O');
  });
});
