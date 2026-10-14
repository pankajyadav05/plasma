import { execFile } from 'node:child_process';
import type { AiCliProvider, AiCliStatus } from '@shared/ai-cli';
import { cliPlanLabel, cliProviderName } from '@shared/ai-cli';
import type { AiModel, AiModelsResult } from '@shared/ai-models';
import { redactCliMessage } from './claude';
import { type CliExit, cliEnv, codexEnv, spawnCli } from './proc';
import { type CliName, type ResolveDeps, defaultResolveDeps, resolveBinary } from './resolve';
import { launchSpec } from './resolve';
import { ensureShellEnv } from './shell-env';

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

/**
 * Codex `account/read` result. Signed out ONLY when it says so: no account and
 * the server asks for an OpenAI login. No account and no login required is a
 * custom provider (nothing to sign in to).
 */
export function parseCodexAccount(result: unknown): { signedIn: boolean; plan?: string } {
  const r = result as { account?: unknown; requiresOpenaiAuth?: unknown } | null;
  const account = r?.account;
  if (!account || typeof account !== 'object') {
    return { signedIn: !!r && r.requiresOpenaiAuth === false };
  }
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

/** `initialize` answers `userAgent: "codex_cli_rs/0.162.1 (Mac OS ...)"`: the version after the slash. */
export function versionFromUserAgent(userAgent: unknown): string | undefined {
  if (typeof userAgent !== 'string') return undefined;
  const v = /\/([^\s]+)/.exec(userAgent)?.[1];
  return v && /^\d+\.\d+/.test(v) ? v : undefined;
}

/**
 * Why a program did not answer, in a few redacted words: the spawn error, the
 * `env: node: No such file or directory` of an npm script without node, or the
 * exit code and the last line of stderr.
 */
export function failureReason(
  exit: Pick<CliExit, 'code' | 'signal' | 'stderrTail' | 'spawnError' | 'timedOut'> | null,
): string {
  if (!exit) return 'no answer';
  if (exit.spawnError) {
    return exit.spawnError === 'ENOENT'
      ? 'the program was not found (ENOENT)'
      : `could not start (${exit.spawnError})`;
  }
  if (exit.timedOut) return 'no answer in time';
  const lines = redactCliMessage(exit.stderrTail)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const envLine = lines.find((l) => /^env: .*No such file or directory/i.test(l));
  if (envLine) return envLine;
  const last = lines.at(-1)?.slice(0, 160);
  const how = exit.signal ? `stopped by ${exit.signal}` : `exited with code ${exit.code ?? '?'}`;
  return last ? `${how}: ${last}` : how;
}

type RunResult = { ok: boolean; stdout: string; stderr: string; code: unknown };

function run(file: string, args: string[], timeoutMs: number): Promise<RunResult> {
  const spec = launchSpec(file, args);
  return new Promise((resolve) => {
    execFile(
      spec.command,
      spec.args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 256 * 1024, env: cliEnv() },
      (err, stdout, stderr) =>
        resolve({
          ok: !err,
          stdout: String(stdout),
          stderr: String(stderr),
          code: (err as NodeJS.ErrnoException | null)?.code,
        }),
    );
  });
}

/** Why `run` failed: spawn error or exit code, plus an `env: node:` style line. */
function runFailure(r: RunResult): string {
  return failureReason({
    code: typeof r.code === 'number' ? r.code : null,
    signal: null,
    stderrTail: r.stderr,
    spawnError: typeof r.code === 'string' ? r.code : undefined,
    timedOut: false,
  });
}

export type CodexAnswer =
  | {
      ok: true;
      userAgent?: string;
      /** One entry per asked method, in order: its result, or null when that method errored. */
      results: Array<unknown | null>;
      /** The error text of each method that errored (same order, '' when none). */
      errors: string[];
    }
  | { ok: false; reason: string };

/** Ask a Codex app-server a few things and stop it. `ok: false` says why it could not answer. */
export async function codexQuery(
  file: string,
  cwd: string,
  methods: Array<[string, unknown]>,
  timeoutMs = 15_000,
): Promise<CodexAnswer> {
  await ensureShellEnv();
  const spec = launchSpec(file, ['app-server']);
  const ctl = new AbortController();
  const pending = new Map<number, (m: Record<string, unknown>) => void>();
  const proc = spawnCli({
    command: spec.command,
    args: spec.args,
    env: codexEnv(),
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
  let exited: CliExit | null = null;
  const gone = proc.done.then((x) => {
    exited = x;
    return null;
  });
  const give = new Promise<null>((r) => {
    const t = setTimeout(() => r(null), timeoutMs);
    t.unref?.();
  });
  try {
    const out = await Promise.race([
      (async (): Promise<CodexAnswer | null> => {
        const init = await ask(1, 'initialize', {
          clientInfo: { name: 'plasma', title: 'Plasma', version: '0' },
          capabilities: null,
        });
        if (init.error) {
          const msg = (init.error as { message?: unknown }).message;
          return { ok: false, reason: redactCliMessage(String(msg ?? 'initialize failed')) };
        }
        proc.write({ method: 'initialized' });
        const results: unknown[] = [];
        const errors: string[] = [];
        let id = 1;
        for (const [method, params] of methods) {
          const r = await ask(++id, method, params);
          const msg = (r.error as { message?: unknown } | undefined)?.message;
          results.push(r.error ? null : r.result);
          errors.push(r.error ? redactCliMessage(String(msg ?? 'failed')) : '');
        }
        const ua = (init.result as { userAgent?: unknown } | null)?.userAgent;
        return { ok: true, ...(typeof ua === 'string' ? { userAgent: ua } : {}), results, errors };
      })(),
      gone,
      give,
    ]);
    if (out) return out;
    // Nobody answered: the program ended (why?) or the wait ran out.
    return {
      ok: false,
      reason: failureReason(
        (exited as CliExit | null) ?? { code: null, signal: null, stderrTail: '', timedOut: true },
      ),
    };
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
  deps?: ResolveDeps,
): Promise<AiCliStatus> {
  const name = BIN[provider];
  const human = cliProviderName(provider);
  await ensureShellEnv();
  const found = await resolveBinary(name, override, deps ?? defaultResolveDeps());
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
  const fromVersionFlag = async () => {
    const ver = await run(found.path, ['--version'], 8_000);
    return ver.ok ? parseVersion(ver.stdout) : undefined;
  };
  if (provider === 'claude-code') {
    const version = await fromVersionFlag();
    const r = await run(found.path, ['auth', 'status'], 10_000);
    // A non-zero exit is normal when signed out: only output that is not the JSON answer means it could not run.
    const answered = /^\s*\{/.test(r.stdout);
    if (!answered) {
      return {
        provider,
        installed: true,
        ...(version ? { version } : {}),
        signedIn: false,
        unreachable: true,
        path: found.path,
        error: `${human} did not answer: ${runFailure(r)}`,
      };
    }
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
  if (!res.ok) {
    const version = await fromVersionFlag();
    return {
      provider,
      installed: true,
      ...(version ? { version } : {}),
      signedIn: false,
      unreachable: true,
      path: found.path,
      error: `${human} did not answer: ${res.reason}`,
    };
  }
  const version = versionFromUserAgent(res.userAgent) ?? (await fromVersionFlag());
  if (res.errors[0]) {
    return {
      provider,
      installed: true,
      ...(version ? { version } : {}),
      signedIn: false,
      unreachable: true,
      path: found.path,
      error: `${human} did not answer: ${res.errors[0]}`,
    };
  }
  const auth = parseCodexAccount(res.results[0]);
  return {
    provider,
    installed: true,
    ...(version ? { version } : {}),
    signedIn: auth.signedIn,
    ...(auth.plan ? { plan: auth.plan } : {}),
    path: found.path,
    ...(auth.signedIn ? {} : { error: 'Not signed in. Run `codex login` in a terminal.' }),
  };
}

export async function listCliModels(
  provider: AiCliProvider,
  override: string | undefined,
  cwd: string,
  deps?: ResolveDeps,
): Promise<AiModelsResult> {
  await ensureShellEnv();
  if (provider === 'claude-code') {
    return { models: CLAUDE_MODELS, fetchedAt: Date.now(), source: 'live' };
  }
  const found = await resolveBinary('codex', override, deps ?? defaultResolveDeps());
  if (!found) {
    return {
      models: [],
      fetchedAt: 0,
      source: 'none',
      error: 'Codex is not installed. Add it in Settings, AI.',
    };
  }
  const res = await codexQuery(found.path, cwd, [['model/list', {}]]);
  const models = res.ok ? codexModelsFrom(res.results[0]) : [];
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
