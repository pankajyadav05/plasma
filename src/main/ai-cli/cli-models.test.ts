import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AiModelsResultSchema } from '@shared/ai-models';
import { effectiveOption } from '@shared/cli-models';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SERVICE_TIER_ID,
  applyPreferredCodexDefaultModel,
  buildCodexModels,
  claudeCatalog,
  claudeEffortArg,
  claudeModelsForVersion,
  codexEffortArg,
  codexModelFamily,
  codexServiceTierArg,
  formatCodexModelName,
  mapCodexModelCapabilities,
  parseCodexModelListPage,
  resolveClaudeSlug,
} from './cli-models';
import { BUNDLED_MANIFEST, type Manifest } from './model-manifest';

// A real `model/list` answer from Codex 0.162.1 (one page).
const PAGES = JSON.parse(
  readFileSync(join(__dirname, 'codex-model-list.fixture.json'), 'utf8'),
) as unknown[];

const manifestWith = (mutate: (m: Manifest) => void): Manifest => {
  const m = structuredClone(BUNDLED_MANIFEST);
  mutate(m);
  return m;
};

describe('Codex names', () => {
  it('formats display names like T3', () => {
    expect(formatCodexModelName('gpt-6.1-sol')).toBe('GPT-6.1-Sol');
    expect(formatCodexModelName('GPT-5.6-Luna')).toBe('GPT-5.6-Luna');
    expect(codexModelFamily('openai.gpt-6-luna')).toBe('gpt-6-luna');
    expect(codexModelFamily('gpt-6-luna')).toBe('gpt-6-luna');
  });
});

describe('Codex model/list parsing', () => {
  it('maps the real shape: slug, default, efforts with labels, the Fast tier', () => {
    const models = parseCodexModelListPage(PAGES[0]);
    expect(models.map((m) => m.id)).toEqual([
      'gpt-6.1-sol',
      'gpt-6-astra',
      'gpt-6-sol',
      'gpt-6-luna',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ]);
    const sol = models[0]!;
    expect(sol).toMatchObject({ name: 'GPT-6.1-Sol', vendor: 'openai', isDefault: true });
    const efforts = sol.capabilities?.optionDescriptors.find((d) => d.id === 'effort');
    expect(efforts).toMatchObject({ label: 'Reasoning', type: 'select', currentValue: 'medium' });
    if (efforts?.type !== 'select') throw new Error('select expected');
    // Ultra needs sub-agents, which Plasma runs Codex without.
    expect(efforts.options.map((o) => o.label)).toEqual([
      'Low',
      'Medium',
      'High',
      'Extra High',
      'Max',
    ]);
    expect(efforts.options.find((o) => o.isDefault)?.id).toBe('medium');
    const tier = sol.capabilities?.optionDescriptors.find((d) => d.id === 'serviceTier');
    if (tier?.type !== 'select') throw new Error('select expected');
    expect(tier.options).toEqual([
      { id: DEFAULT_SERVICE_TIER_ID, label: 'Standard', isDefault: true },
      { id: 'priority', label: 'Fast', description: '2x speed, increased usage' },
    ]);
  });

  it('skips hidden models and entries without a name', () => {
    const models = parseCodexModelListPage({
      data: [
        { model: 'a', displayName: 'A', hidden: true },
        { model: 'gpt-x', displayName: 'gpt-x' },
        { nothing: true },
      ],
    });
    expect(models.map((m) => m.id)).toEqual(['gpt-x']);
    expect(models[0]?.name).toBe('GPT-X');
    expect(parseCodexModelListPage(null)).toEqual([]);
  });

  it('falls back to additionalSpeedTiers (Fast) and honours a catalog default tier', () => {
    const caps = mapCodexModelCapabilities({
      model: 'm',
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
      defaultReasoningEffort: 'low',
      additionalSpeedTiers: ['fast'],
    });
    const tier = caps.optionDescriptors.find((d) => d.id === 'serviceTier');
    if (tier?.type !== 'select') throw new Error('select expected');
    expect(tier.options.map((o) => [o.id, o.label])).toEqual([
      ['default', 'Standard'],
      ['fast', 'Fast'],
    ]);
    const dflt = mapCodexModelCapabilities({
      model: 'm',
      serviceTiers: [{ id: 'priority', name: 'Fast', description: '' }],
      defaultServiceTier: 'priority',
    });
    const t2 = dflt.optionDescriptors.find((d) => d.id === 'serviceTier');
    if (t2?.type !== 'select') throw new Error('select expected');
    expect(t2.options.find((o) => o.isDefault)?.id).toBe('priority');
    expect(t2.currentValue).toBe('priority');
  });

  it('GPT-6 Astra defaults to medium whatever Codex says', () => {
    const caps = mapCodexModelCapabilities({
      model: 'gpt-6-astra',
      supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }],
      defaultReasoningEffort: 'high',
    });
    const d = caps.optionDescriptors[0];
    if (d?.type !== 'select') throw new Error('select expected');
    expect(d.options.find((o) => o.isDefault)?.id).toBe('medium');
  });
});

describe('Codex list: pagination, legacy, default', () => {
  it('merges pages and drops a repeated model', () => {
    const page1 = { data: [{ model: 'gpt-6-luna', displayName: 'GPT-6-Luna' }], nextCursor: 'c2' };
    const page2 = {
      data: [{ model: 'gpt-6-luna' }, { model: 'gpt-6-sol', displayName: 'GPT-6-Sol' }],
    };
    expect(buildCodexModels([page1, page2], BUNDLED_MANIFEST).map((m) => m.id)).toEqual([
      'gpt-6-luna',
      'gpt-6-sol',
    ]);
  });

  it('marks legacy from the manifest and uses its readable names', () => {
    const models = buildCodexModels(PAGES, BUNDLED_MANIFEST);
    const byId = new Map(models.map((m) => [m.id, m]));
    expect(byId.get('gpt-6.1-sol')).toMatchObject({ name: 'GPT-6.1 Sol' });
    expect(byId.get('gpt-6.1-sol')?.isLegacy).toBeUndefined();
    expect(byId.get('gpt-6-luna')?.isLegacy).toBeUndefined();
    for (const legacy of ['gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      expect(byId.get(legacy)?.isLegacy).toBe(true);
    }
  });

  it('prefers GPT-6 Astra over Codex`s own default, then the 5.6 ranking, then Codex', () => {
    const models = buildCodexModels(PAGES, BUNDLED_MANIFEST);
    expect(models.filter((m) => m.isDefault).map((m) => m.id)).toEqual(['gpt-6-astra']);
    const withoutAstra = {
      data: (PAGES[0] as { data: Array<{ model: string }> }).data.filter(
        (m) => m.model !== 'gpt-6-astra',
      ),
    };
    expect(
      buildCodexModels([withoutAstra], BUNDLED_MANIFEST)
        .filter((m) => m.isDefault)
        .map((m) => m.id),
    ).toEqual(['gpt-5.6-sol']);
    const onlyOther = {
      data: [
        { model: 'zz-1', displayName: 'zz-1', isDefault: true },
        { model: 'zz-2', displayName: 'zz-2' },
      ],
    };
    expect(
      buildCodexModels([onlyOther], BUNDLED_MANIFEST)
        .filter((m) => m.isDefault)
        .map((m) => m.id),
    ).toEqual(['zz-1']);
    expect(applyPreferredCodexDefaultModel([])).toEqual([]);
  });

  it('the manifest`s own default wins when the list has it', () => {
    const m = manifestWith((x) => {
      x.providers.codex.defaults = { chat: 'gpt-6-luna' };
    });
    expect(
      buildCodexModels(PAGES, m)
        .filter((x) => x.isDefault)
        .map((x) => x.id),
    ).toEqual(['gpt-6-luna']);
  });

  it('the result passes the IPC schema', () => {
    const models = buildCodexModels(PAGES, BUNDLED_MANIFEST);
    expect(() =>
      AiModelsResultSchema.parse({
        models,
        fetchedAt: 1,
        source: 'live',
        origin: { kind: 'codex' },
      }),
    ).not.toThrow();
  });
});

describe('Claude Code catalog', () => {
  it('builds canonical slugs, names, aliases, default, legacy, badge', () => {
    const all = claudeCatalog(BUNDLED_MANIFEST).map((c) => c.model);
    const opus = all.find((m) => m.id === 'claude-opus-5-5');
    expect(opus).toMatchObject({ name: 'Claude Opus 5.5', vendor: 'anthropic' });
    expect(opus?.aliases).toContain('opus');
    expect(all.filter((m) => m.isDefault).map((m) => m.id)).toEqual(['claude-fable-5-1']);
    expect(all.find((m) => m.id === 'claude-haiku-5-5')?.badge).toBe('new');
    expect(all.find((m) => m.id === 'claude-opus-4-8')?.isLegacy).toBe(true);
  });

  it('filters by the installed version and reports update-required models', () => {
    const old = claudeModelsForVersion(BUNDLED_MANIFEST, '2.1.270');
    const ids = old.models.map((m) => m.id);
    expect(ids).not.toContain('claude-opus-5-5');
    expect(ids).not.toContain('claude-sonnet-5-5');
    expect(ids).toContain('claude-fable-5-1');
    expect(old.updateRequired.map((u) => [u.slug, u.minVersion])).toEqual([
      ['claude-opus-5-5', '2.1.280'],
      ['claude-sonnet-5-5', '2.1.284'],
      ['claude-haiku-5-5', '2.1.293'],
    ]);
    // Legacy models too old for this version are simply hidden, not "update required".
    expect(old.updateRequired.every((u) => !u.slug.includes('4-'))).toBe(true);

    const current = claudeModelsForVersion(BUNDLED_MANIFEST, '2.1.296');
    expect(current.updateRequired).toEqual([]);
    expect(current.models.map((m) => m.id)).toContain('claude-haiku-5-5');
  });

  it('compares versions numerically, honours maxVersionExclusive, hides gated models without a version', () => {
    const m = manifestWith((x) => {
      x.providers['claude-code'].models[0]!.adapter = {
        claudeCode: { minVersion: '2.1.9', maxVersionExclusive: '2.1.100' },
      };
    });
    const slug = m.providers['claude-code'].models[0]!.slug;
    const has = (v: string | undefined) =>
      claudeModelsForVersion(m, v).models.some((x) => x.id === slug);
    expect(has('2.1.10')).toBe(true);
    expect(has('2.1.8')).toBe(false);
    expect(has('2.1.100')).toBe(false);
    expect(has(undefined)).toBe(false);
  });

  it('resolves a saved alias to the canonical slug, and "" to the default', () => {
    expect(resolveClaudeSlug(BUNDLED_MANIFEST, 'sonnet')).toBe('claude-sonnet-5-5');
    expect(resolveClaudeSlug(BUNDLED_MANIFEST, 'Opus')).toBe('claude-opus-5-5');
    expect(resolveClaudeSlug(BUNDLED_MANIFEST, 'haiku')).toBe('claude-haiku-5-5');
    expect(resolveClaudeSlug(BUNDLED_MANIFEST, 'claude-opus-4-7')).toBe('claude-opus-4-7');
    expect(resolveClaudeSlug(BUNDLED_MANIFEST, '')).toBe('claude-fable-5-1');
    // Not in the list: sent as typed.
    expect(resolveClaudeSlug(BUNDLED_MANIFEST, 'claude-opus-9-9')).toBe('claude-opus-9-9');
  });

  it('effort: the pick maps through the profile; a default, unknown or unoffered pick sends nothing', () => {
    // opus-4-7 shows "Extra High" but the CLI wants max.
    expect(claudeEffortArg(BUNDLED_MANIFEST, 'claude-opus-4-7', 'xhigh')).toBeUndefined(); // its default
    expect(claudeEffortArg(BUNDLED_MANIFEST, 'claude-opus-4-7', 'low')).toBe('low');
    expect(claudeEffortArg(BUNDLED_MANIFEST, 'claude-sonnet-4-6', 'high')).toBeUndefined();
    // sonnet-4-6 has no xhigh: a saved xhigh falls back to the default (nothing sent).
    expect(claudeEffortArg(BUNDLED_MANIFEST, 'claude-sonnet-4-6', 'xhigh')).toBeUndefined();
    expect(claudeEffortArg(BUNDLED_MANIFEST, 'claude-sonnet-4-6', 'max')).toBe('high');
    expect(claudeEffortArg(BUNDLED_MANIFEST, 'claude-opus-5-5', 'high')).toBe('high');
    expect(claudeEffortArg(BUNDLED_MANIFEST, 'opus', 'max')).toBe('max');
    expect(claudeEffortArg(BUNDLED_MANIFEST, 'claude-opus-5-5', '')).toBeUndefined();
    expect(claudeEffortArg(BUNDLED_MANIFEST, 'claude-haiku-4-5', 'high')).toBeUndefined();
  });
});

describe('effort and tier fallback', () => {
  const luna = buildCodexModels(PAGES, BUNDLED_MANIFEST).find((m) => m.id === 'gpt-6-luna');
  const sol = buildCodexModels(PAGES, BUNDLED_MANIFEST).find((m) => m.id === 'gpt-6.1-sol');

  it('a saved value the model does not offer falls back to its default', () => {
    expect(effectiveOption(luna, 'effort', 'high')).toBe('high');
    expect(effectiveOption(luna, 'effort', 'ultra')).toBe('medium');
    expect(effectiveOption(luna, 'effort', '')).toBe('medium');
    expect(effectiveOption(undefined, 'effort', 'high')).toBeUndefined();
    expect(effectiveOption(luna, 'nothing', 'x')).toBeUndefined();
  });

  it('turn/start gets an effort and tier only for a non-default pick the model offers', () => {
    expect(codexEffortArg(sol, 'low')).toBe('low');
    expect(codexEffortArg(sol, 'medium')).toBeUndefined();
    expect(codexEffortArg(sol, 'ultra')).toBeUndefined();
    expect(codexEffortArg(undefined, 'low')).toBeUndefined();
    expect(codexServiceTierArg(sol, 'priority')).toBe('priority');
    expect(codexServiceTierArg(sol, 'default')).toBeUndefined();
    expect(codexServiceTierArg(sol, '')).toBeUndefined();
    expect(codexServiceTierArg(sol, 'turbo')).toBeUndefined();
  });
});
