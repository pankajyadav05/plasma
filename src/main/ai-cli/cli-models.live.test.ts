import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiModel } from '@shared/ai-models';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUNDLED_MANIFEST, createManifestStore } from './model-manifest';
import { resolveCliRunChoices } from './options';
import { runCliChat } from './run';
import { getCliStatus, listCliModels } from './status';

/**
 * Opt-in live run against the real, signed-in Codex and Claude Code: the model
 * lists the code produces, and a one-line chat with a non-default reasoning effort
 * on the smallest model. No database is involved.
 *
 *   PLASMA_LIVE_AI_CLI=1 npx vitest run src/main/ai-cli/cli-models.live.test.ts
 */
const suite = process.env.PLASMA_LIVE_AI_CLI === '1' ? describe : describe.skip;

const show = (label: string, models: AiModel[]) => {
  const lines = models.map((m) => {
    const d = m.capabilities?.optionDescriptors ?? [];
    const sel = (id: string) => {
      const x = d.find((o) => o.id === id);
      return x?.type === 'select'
        ? x.options.map((o) => `${o.id}${o.isDefault ? '*' : ''}`).join(',')
        : '-';
    };
    return `  ${m.id} | ${m.name} | default=${m.isDefault ? 'yes' : 'no'} | legacy=${m.isLegacy ? 'yes' : 'no'}${
      m.badge ? ` | ${m.badge}` : ''
    } | effort: ${sel('effort')} | tier: ${sel('serviceTier')}${
      m.aliases ? ` | aliases: ${m.aliases.join(',')}` : ''
    }`;
  });
  console.log(`${label}\n${lines.join('\n')}`);
};

suite('model lists, live', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(process.env.PLASMA_LIVE_TMP ?? tmpdir(), 'plasma-cli-models-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const store = () =>
    createManifestStore({
      cachePath: join(dir, 'm.json'),
      bundled: BUNDLED_MANIFEST,
      fetchFn: async () => {
        throw new Error('offline');
      },
    });

  it('Codex list', async () => {
    const status = await getCliStatus('codex', '', dir);
    console.log(
      'Codex status:',
      JSON.stringify({ ...status, path: status.path ? '(set)' : undefined }),
    );
    const r = await listCliModels('codex', '', dir, undefined, store());
    expect(r.error).toBeUndefined();
    show(`Codex (${JSON.stringify(r.origin)}):`, r.models);
    expect(r.models.some((m) => m.isDefault)).toBe(true);
  }, 60_000);

  it('Claude Code list', async () => {
    const status = await getCliStatus('claude-code', '', dir);
    console.log(
      'Claude status:',
      JSON.stringify({ ...status, path: status.path ? '(set)' : undefined }),
    );
    const r = await listCliModels('claude-code', '', dir, undefined, store());
    expect(r.error).toBeUndefined();
    show(
      `Claude Code (${JSON.stringify(r.origin)}) updateRequired=${JSON.stringify(r.updateRequired ?? [])}:`,
      r.models,
    );
    expect(r.models.some((m) => m.isDefault)).toBe(true);
  }, 60_000);

  for (const c of [
    { provider: 'claude-code' as const, model: 'haiku', effort: 'low' },
    { provider: 'codex' as const, model: 'gpt-6-luna', effort: 'low' },
  ]) {
    it(`one-line chat with effort ${c.effort} on ${c.model}`, async () => {
      const choices = await resolveCliRunChoices({
        provider: c.provider,
        model: c.model,
        effort: c.effort,
        serviceTier: '',
        binaryOverride: '',
        cwd: dir,
      });
      console.log(`${c.provider} run choices:`, JSON.stringify(choices));
      const events: Array<{ kind: string; text?: string; message?: string }> = [];
      await runCliChat({
        provider: c.provider,
        requestId: `live-${c.provider}`,
        send: (e) => events.push(e as { kind: string }),
        model: choices.model,
        ...(choices.effort ? { effort: choices.effort } : {}),
        binaryOverride: '',
        userData: dir,
        appVersion: 'live',
        system: 'You are terse.',
        history: [{ role: 'user', content: 'Reply with exactly the word PONG and nothing else.' }],
        tools: [],
        maxRounds: 1,
        executeCall: async () => '{}',
        signal: new AbortController().signal,
        timeoutMs: 90_000,
      });
      const text = events
        .filter((e) => e.kind === 'delta')
        .map((e) => e.text)
        .join('');
      console.log(
        `${c.provider} reply:`,
        JSON.stringify(text),
        events.find((e) => e.kind === 'error')?.message ?? '',
      );
      expect(events.some((e) => e.kind === 'done')).toBe(true);
      expect(text).toMatch(/PONG/i);
    }, 120_000);
  }
});
