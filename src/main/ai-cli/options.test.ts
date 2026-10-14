import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiModelsResult } from '@shared/ai-models';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCodexModels } from './cli-models';
import { BUNDLED_MANIFEST } from './model-manifest';
import {
  cachedCliModels,
  memoizedCliModels,
  resetCliOptionsForTests,
  resolveCliRunChoices,
  seedCliModelsForTests,
} from './options';
import { resetClaudeCliInfoForTests } from './status';

// The shared manifest store must not reach the network or write into the working folder here.
process.env.PLASMA_CLI_MODEL_MANIFEST_URL = 'http://127.0.0.1:9/cli-model-manifest.json';

const FIXTURE_PAGE = {
  data: [
    {
      model: 'gpt-6-luna',
      displayName: 'GPT-6-Luna',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low' },
        { reasoningEffort: 'medium' },
        { reasoningEffort: 'high' },
      ],
      defaultReasoningEffort: 'medium',
      serviceTiers: [{ id: 'priority', name: 'Fast', description: '' }],
      isDefault: true,
    },
  ],
};

describe('what a chat starts with', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plasma-options-'));
    resetCliOptionsForTests();
    resetClaudeCliInfoForTests();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const script = (name: string, body: string) => {
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  };

  it('Codex without a list in memory: never starts a program, passes the saved values on', async () => {
    const marker = join(dir, 'started');
    const codex = script('codex', `touch '${marker}'\nexit 1`);
    const r = await resolveCliRunChoices({
      provider: 'codex',
      model: 'gpt-6-luna',
      effort: 'high',
      serviceTier: 'priority',
      binaryOverride: codex,
    });
    expect(r).toEqual({ model: 'gpt-6-luna', effort: 'high', serviceTier: 'priority' });
    expect(existsSync(marker)).toBe(false);
    // Nothing safe to send is dropped, not forwarded.
    const bad = await resolveCliRunChoices({
      provider: 'codex',
      model: 'gpt-6-luna',
      effort: '--oops',
      serviceTier: 'default',
      binaryOverride: codex,
    });
    expect(bad).toEqual({ model: 'gpt-6-luna' });
    expect(existsSync(marker)).toBe(false);
  });

  it('Codex with a list in memory (any age): checks the pick against the model', async () => {
    const result: AiModelsResult = {
      models: buildCodexModels([FIXTURE_PAGE], BUNDLED_MANIFEST),
      fetchedAt: 1,
      source: 'live',
    };
    seedCliModelsForTests('codex', '', result, Date.now() - 24 * 3600_000);
    expect(memoizedCliModels('codex', '')).toBe(result);
    const ok = await resolveCliRunChoices({
      provider: 'codex',
      model: 'gpt-6-luna',
      effort: 'medium',
      serviceTier: 'priority',
      binaryOverride: '',
    });
    // An explicit pick is sent even when it is the model's default.
    expect(ok).toEqual({ model: 'gpt-6-luna', effort: 'medium', serviceTier: 'priority' });
    const unoffered = await resolveCliRunChoices({
      provider: 'codex',
      model: 'gpt-6-luna',
      effort: 'max',
      serviceTier: 'turbo',
      binaryOverride: '',
    });
    expect(unoffered).toEqual({ model: 'gpt-6-luna' });
    const dflt = await resolveCliRunChoices({
      provider: 'codex',
      model: '',
      effort: '',
      serviceTier: '',
      binaryOverride: '',
    });
    expect(dflt).toEqual({ model: '' });
  });

  it('a list with an error is not kept', async () => {
    const claude = script(
      'claude',
      'if [ "$1" = "--version" ]; then exit 1; fi\necho "--effort <level>"',
    );
    const first = await cachedCliModels('claude-code', claude, dir);
    expect(first.error).toMatch(/version/);
    // Not unfiltered-and-forgotten for 5 minutes: the next ask reads the program again.
    expect(memoizedCliModels('claude-code', claude)).toBeNull();
  });

  it('Claude: --effort only when this Claude Code has the flag', async () => {
    const withFlag = script(
      'claude',
      'if [ "$1" = "--version" ]; then echo "2.1.296 (Claude Code)"; else echo "  --effort <level>  Effort"; fi',
    );
    const a = await resolveCliRunChoices({
      provider: 'claude-code',
      model: 'haiku',
      effort: 'medium',
      serviceTier: '',
      binaryOverride: withFlag,
    });
    // Picked effort equal to the model's default is still sent.
    expect(a).toEqual({ model: 'claude-haiku-5-5', effort: 'medium' });

    resetClaudeCliInfoForTests();
    const noFlag = script(
      'claude',
      'if [ "$1" = "--version" ]; then echo "2.1.296 (Claude Code)"; else echo "Usage: claude"; fi',
    );
    const b = await resolveCliRunChoices({
      provider: 'claude-code',
      model: 'haiku',
      effort: 'high',
      serviceTier: '',
      binaryOverride: noFlag,
    });
    expect(b).toEqual({ model: 'claude-haiku-5-5' });
  });

  it('Claude: an alias the installed version cannot run goes through unchanged', async () => {
    const old = script(
      'claude',
      'if [ "$1" = "--version" ]; then echo "2.1.270 (Claude Code)"; else echo "--effort <level>"; fi',
    );
    const r = await resolveCliRunChoices({
      provider: 'claude-code',
      model: 'sonnet',
      effort: '',
      serviceTier: '',
      binaryOverride: old,
    });
    expect(r.model).toBe('sonnet');
  });
});
