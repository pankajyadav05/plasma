import type { AiModel } from '@shared/ai-models';
import { describe, expect, it } from 'vitest';
import { type PickerInput, buildPickerItems, modelRows, railEntries } from './model-picker-rows';

const NOW = Date.UTC(2026, 9, 6);
const ago = (days: number) => Math.floor(NOW / 1000) - days * 86_400;

function m(vendor: string, name: string, days: number, over: Partial<AiModel> = {}): AiModel {
  return {
    id: `${vendor}/${name.toLowerCase().replace(/\s+/g, '-')}`,
    name,
    vendor,
    vendorName: vendor,
    created: ago(days),
    contextLength: 8000,
    promptPrice: 1,
    completionPrice: 2,
    tools: true,
    vision: false,
    free: false,
    expires: null,
    ...over,
  };
}

const models = [
  m('anthropic', 'Claude Opus 5.5', 3),
  m('anthropic', 'Claude Opus 5', 90),
  m('anthropic', 'Claude Opus 4', 200),
  m('anthropic', 'Claude Old 1', 600),
  m('openai', 'GPT-6', 10),
  m('acme', 'Acme Fast 2', 20),
];

const base: PickerInput = {
  models,
  tab: 'start',
  query: '',
  favorites: [],
  recents: [],
  currentId: 'anthropic/claude-opus-5.5',
  legacyOpen: new Set(),
  local: false,
  now: NOW,
};

const names = (items: ReturnType<typeof buildPickerItems>) =>
  items.map((i) =>
    i.kind === 'model' ? i.model.name : i.kind === 'header' ? `# ${i.label}` : i.kind,
  );

describe('railEntries', () => {
  it('lists main vendors in order with counts, then Other', () => {
    expect(railEntries(models)).toEqual([
      { id: 'anthropic', name: 'Anthropic', count: 4 },
      { id: 'openai', name: 'OpenAI', count: 1 },
      { id: 'other', name: 'Other', count: 1 },
    ]);
  });
});

describe('buildPickerItems', () => {
  it('shows favourites, recent and newest without repeating a model', () => {
    const items = buildPickerItems({
      ...base,
      favorites: ['openai/gpt-6'],
      recents: ['anthropic/claude-opus-5'],
    });
    expect(names(items)).toEqual([
      '# Favourites',
      'GPT-6',
      '# Recent',
      'Claude Opus 5.5',
      'Claude Opus 5',
    ]);
  });

  it('adds Newest with what is not shown yet', () => {
    const items = buildPickerItems({ ...base, recents: [] });
    expect(names(items)).toEqual([
      '# Recent',
      'Claude Opus 5.5',
      '# Newest',
      'GPT-6',
      'Claude Opus 5',
    ]);
  });

  it('puts the current model in Recent even before it was ever picked, and keeps unknown ids', () => {
    const items = buildPickerItems({ ...base, recents: ['x/gone'] });
    const rows = modelRows(items);
    expect(rows[0]?.id).toBe('anthropic/claude-opus-5.5');
    expect(rows.map((r) => r.id)).toContain('x/gone');
  });

  it('lists a vendor latest, then a collapsed legacy row that expands in place', () => {
    const closed = buildPickerItems({ ...base, tab: 'anthropic' });
    expect(names(closed)).toEqual(['Claude Opus 5.5', 'Claude Opus 5', 'legacy']);
    const legacy = closed.find((i) => i.kind === 'legacy');
    expect(legacy).toMatchObject({ count: 2, open: false });
    const open = buildPickerItems({
      ...base,
      tab: 'anthropic',
      legacyOpen: new Set(['anthropic']),
    });
    expect(names(open)).toEqual([
      'Claude Opus 5.5',
      'Claude Opus 5',
      'legacy',
      'Claude Opus 4',
      'Claude Old 1',
    ]);
  });

  it('puts unknown vendors under Other', () => {
    expect(names(buildPickerItems({ ...base, tab: 'other' }))).toEqual(['Acme Fast 2']);
  });

  it('searches every vendor, ignoring the tab', () => {
    const items = buildPickerItems({ ...base, tab: 'openai', query: 'opus' });
    expect(names(items)).toEqual(['Claude Opus 5.5', 'Claude Opus 5', 'Claude Opus 4']);
  });

  it('offers "Use id" for an id-shaped query that matches nothing, or no exact id', () => {
    const none = buildPickerItems({ ...base, query: 'acme/brand-new' });
    expect(none).toEqual([{ kind: 'use', key: 'use:acme/brand-new', id: 'acme/brand-new' }]);
    const exact = buildPickerItems({ ...base, query: 'openai/gpt-6' });
    expect(exact.some((i) => i.kind === 'use')).toBe(false);
    const word = buildPickerItems({ ...base, query: 'zzz' });
    expect(word).toEqual([]);
  });

  it('local: flat list, any typed name can be used', () => {
    const local = [m('local', 'llama3.1', 0, { id: 'llama3.1' })];
    expect(names(buildPickerItems({ ...base, models: local, local: true }))).toEqual(['llama3.1']);
    const typed = buildPickerItems({ ...base, models: local, local: true, query: 'qwen2.5' });
    expect(typed).toEqual([{ kind: 'use', key: 'use:qwen2.5', id: 'qwen2.5' }]);
  });
});

describe('buildPickerItems, images only', () => {
  const withVision = [
    m('anthropic', 'Claude Opus 5.5', 3, { vision: true }),
    m('anthropic', 'Claude Haiku 5', 4),
    m('openai', 'GPT-6', 10, { vision: true }),
  ];
  const input = { ...base, models: withVision, visionOnly: true };

  it('lists only models that accept images', () => {
    const list = names(buildPickerItems({ ...input, tab: 'anthropic' }));
    expect(list).toContain('Claude Opus 5.5');
    expect(list).not.toContain('Claude Haiku 5');
  });

  it('filters search results and the start tab too', () => {
    expect(names(buildPickerItems({ ...input, query: 'claude' }))).not.toContain('Claude Haiku 5');
    const start = names(
      buildPickerItems({ ...input, recents: ['anthropic/claude-haiku-5'], currentId: '' }),
    );
    expect(start).not.toContain('Claude Haiku 5');
  });
});

describe('Codex / Claude Code list', () => {
  const cliModels: AiModel[] = [
    m('anthropic', 'Claude Opus 5.5', 0, {
      id: 'claude-opus-5-5',
      aliases: ['opus', 'opus-5.5'],
      isDefault: true,
    }),
    m('anthropic', 'Claude Haiku 5.5', 0, {
      id: 'claude-haiku-5-5',
      aliases: ['haiku'],
      badge: 'new',
    }),
    m('anthropic', 'Claude Opus 4.8', 0, { id: 'claude-opus-4-8', isLegacy: true }),
  ];
  const cli = {
    updateRequired: [
      { slug: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', minVersion: '2.1.284' },
    ],
  };
  const input: PickerInput = { ...base, models: cliModels, local: true, cli };

  it('current models first, older models collapsed, update-required rows last', () => {
    const items = buildPickerItems(input);
    expect(items.map((i) => i.kind)).toEqual(['model', 'model', 'legacy', 'header', 'update']);
    expect(items[2]).toMatchObject({ label: 'Older models', count: 1, open: false });
    expect(items[4]).toMatchObject({ slug: 'claude-sonnet-5-5', minVersion: '2.1.284' });
    const open = buildPickerItems({ ...input, legacyOpen: new Set(['cli']) });
    expect(open.map((i) => i.kind)).toEqual([
      'model',
      'model',
      'legacy',
      'model',
      'header',
      'update',
    ]);
  });

  it('search matches the name, the slug and the aliases, and offers no duplicate "Use" row', () => {
    const ids = (q: string) =>
      buildPickerItems({ ...input, query: q })
        .filter((i) => i.kind === 'model')
        .map((i) => (i.kind === 'model' ? i.model.id : ''));
    expect(ids('opus 5.5')).toEqual(['claude-opus-5-5']);
    expect(ids('claude-haiku')).toEqual(['claude-haiku-5-5']);
    expect(ids('haiku')).toEqual(['claude-haiku-5-5']);
    expect(buildPickerItems({ ...input, query: 'opus' }).some((i) => i.kind === 'use')).toBe(false);
  });
});
