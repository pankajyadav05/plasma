import { execFile } from 'node:child_process';
import type { AiCliProvider, AiCliStatus } from '@shared/ai-cli';
import { cliPlanLabel, cliProviderName } from '@shared/ai-cli';
import type { AiModel, AiModelsResult } from '@shared/ai-models';
import { cliEnv, spawnCli } from './proc';
import { type CliName, type ResolveDeps, defaultResolveDeps, resolveBinary } from './resolve';
import { launchSpec } from './resolve';

/**
 * Is the CLI installed, which version, is the user signed in, and the models it
 * offers. Everything here reads: it never starts a chat and never returns the
 * account's e-mail address.
 */

const BIN: Record<AiCliProvider, CliName> = { codex: 'codex', 'claude-code': 'claude' };

export function parseVersion(text: string): string | undefined {
  return /\d+\.\d+\.\d+(?:[-+.\w]*)?/.exec(text)?.[0];
}

/** `claude auth status` (JSON). */
export function parseClaudeAuth(text: string): { signedIn: boolean; plan?: string } {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const signedIn = j.loggedIn === true;
    const plan =
      typeof j.subscriptionType === 'string' && j.subscriptionType
        ? cliPlanLabel('claude-code', j.subscriptionType)
        : j.authMethod === 'claude.ai'
          ? 'Claude plan'
          : signedIn
            ? 'API key'
            : undefined;
    return { signedIn, ...(plan && signedIn ? { plan } : {}) };
  } catch {
    return { signedIn: false };
  }
}

/** Codex `account/read` result. */
export function parseCodexAccount(result: unknown): { signedIn: boolean; plan?: string } {
  const account = (result as { account?: unknown } | null)?.account;
  if (!account || typeof account !== 'object') return { signedIn: false };
  const a = account as { type?: unknown; planType?: unknown };
  if (a.type === 'chatgpt') {
    return {
      signedIn: true,
      plan:
        typeof a.planType === 'string' && a.planType
          ? cliPlanLabel('codex', a.planType)
          : 'ChatGPT',
    };
  }
  if (a.type === 'apiKey') return { signedIn: true, plan: 'API key' };
  return { signedIn: true };
}

function run(
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string }> {
  const spec = launchSpec(file, args);
  return new Promise((resolve) => {
    execFile(
      spec.command,
      spec.args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 256 * 1024, env: cliEnv() },
      (err, stdout) => resolve({ ok: !err, stdout: String(stdout) }),
    );
  });
}

/** Ask a Codex app-server a few things and stop it. Null when it could not answer. */
export async function codexQuery(
  file: string,
  cwd: string,
  methods: Array<[string, unknown]>,
  timeoutMs = 15_000,
): Promise<unknown[] | null> {
  const spec = launchSpec(file, ['app-server']);
  const ctl = new AbortController();
  const pending = new Map<number, (m: Record<string, unknown>) => void>();
  const proc = spawnCli({
    command: spec.command,
    args: spec.args,
    env: cliEnv(),
    cwd,
    signal: ctl.signal,
    timeoutMs,
    onLine(line) {
      try {
        const m = JSON.parse(line) as Record<string, unknown>;
        if (typeof m.id === 'number') pending.get(m.id)?.(m);
      } catch {
        /* not ours */
      }
    },
  });
  const ask = (id: number, method: string, params: unknown) =>
    new Promise<Record<string, unknown>>((resolve) => {
      pending.set(id, resolve);
      proc.write({ id, method, params });
    });
  const give = new Promise<null>((r) => {
    const t = setTimeout(() => r(null), timeoutMs);
    t.unref?.();
    void proc.done.then(() => r(null));
  });
  try {
    const out = await Promise.race([
      (async () => {
        const init = await ask(1, 'initialize', {
          clientInfo: { name: 'plasma', title: 'Plasma', version: '0' },
          capabilities: null,
        });
        if (init.error) return null;
        proc.write({ method: 'initialized' });
        const results: unknown[] = [];
        let id = 1;
        for (const [method, params] of methods) {
          const r = await ask(++id, method, params);
          results.push(r.error ? null : r.result);
        }
        return results;
      })(),
      give,
    ]);
    return out;
  } finally {
    ctl.abort();
    await proc.done;
  }
}

export function codexModelsFrom(result: unknown): AiModel[] {
  const data = (result as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: AiModel[] = [];
  for (const raw of data) {
    const m = raw as { id?: unknown; model?: unknown; displayName?: unknown; hidden?: unknown };
    const id = typeof m.model === 'string' && m.model ? m.model : m.id;
    if (typeof id !== 'string' || !id || m.hidden === true) continue;
    out.push(
      cliModel('openai', 'OpenAI', id, typeof m.displayName === 'string' ? m.displayName : id),
    );
  }
  return out;
}

export const CLAUDE_MODELS: AiModel[] = [
  cliModel('anthropic', 'Anthropic', 'sonnet', 'sonnet'),
  cliModel('anthropic', 'Anthropic', 'opus', 'opus'),
  cliModel('anthropic', 'Anthropic', 'haiku', 'haiku'),
];

function cliModel(vendor: string, vendorName: string, id: string, name: string): AiModel {
  return {
    id,
    name,
    vendor,
    vendorName,
    created: 0,
    contextLength: null,
    promptPrice: null,
    completionPrice: null,
    tools: true,
    vision: true,
    free: false,
    expires: null,
  };
}

export async function getCliStatus(
  provider: AiCliProvider,
  override: string | undefined,
  cwd: string,
  deps: ResolveDeps = defaultResolveDeps(),
): Promise<AiCliStatus> {
  const name = BIN[provider];
  const human = cliProviderName(provider);
  const found = await resolveBinary(name, override, deps);
  if (!found) {
    return {
      provider,
      installed: false,
      signedIn: false,
      error: override?.trim()
        ? `${human} was not found at the path you set.`
        : `${human} is not installed.`,
    };
  }
  const ver = await run(found.path, ['--version'], 8_000);
  const version = ver.ok ? parseVersion(ver.stdout) : undefined;
  if (provider === 'claude-code') {
    const r = await run(found.path, ['auth', 'status'], 10_000);
    const auth = parseClaudeAuth(r.stdout);
    return {
      provider,
      installed: true,
      ...(version ? { version } : {}),
      signedIn: auth.signedIn,
      ...(auth.plan ? { plan: auth.plan } : {}),
      path: found.path,
      ...(auth.signedIn ? {} : { error: 'Not signed in. Run `claude` in a terminal and sign in.' }),
    };
  }
  const res = await codexQuery(found.path, cwd, [['account/read', {}]]);
  const auth = res ? parseCodexAccount(res[0]) : { signedIn: false as const };
  return {
    provider,
    installed: true,
    ...(version ? { version } : {}),
    signedIn: auth.signedIn,
    ...('plan' in auth && auth.plan ? { plan: auth.plan } : {}),
    path: found.path,
    ...(res
      ? auth.signedIn
        ? {}
        : { error: 'Not signed in. Run `codex login` in a terminal.' }
      : { error: 'Codex did not answer. Update Codex and try again.' }),
  };
}

export async function listCliModels(
  provider: AiCliProvider,
  override: string | undefined,
  cwd: string,
  deps: ResolveDeps = defaultResolveDeps(),
): Promise<AiModelsResult> {
  if (provider === 'claude-code') {
    return { models: CLAUDE_MODELS, fetchedAt: Date.now(), source: 'live' };
  }
  const found = await resolveBinary('codex', override, deps);
  if (!found) {
    return {
      models: [],
      fetchedAt: 0,
      source: 'none',
      error: 'Codex is not installed. Add it in Settings, AI.',
    };
  }
  const res = await codexQuery(found.path, cwd, [['model/list', {}]]);
  const models = res ? codexModelsFrom(res[0]) : [];
  if (models.length === 0) {
    return {
      models: [],
      fetchedAt: 0,
      source: 'none',
      error: 'Could not read the model list from Codex. Type a model name instead.',
    };
  }
  return { models, fetchedAt: Date.now(), source: 'live' };
}
