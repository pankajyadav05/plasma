import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AiCliProvider, AiCliStatus } from '@shared/ai-cli';
import { cliPlanLabel, cliProviderName } from '@shared/ai-cli';
import type { AiModelsResult } from '@shared/ai-models';
import { redactCliMessage } from './claude';
import { buildCodexModels, claudeModelsForVersion } from './cli-models';
import { type ManifestStore, manifestStore } from './model-manifest';
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

export interface CodexConn {
  ask(method: string, params: unknown): Promise<{ result: unknown } | { error: string }>;
  userAgent?: string;
  /** `initialize`'s codexHome, when Codex says. */
  codexHome?: string;
  /** Epoch ms just before the program was started. */
  spawnedAtMs: number;
}

export type CodexSession<T> =
  | { ok: true; value: T; userAgent?: string }
  | { ok: false; reason: string };

/** Start `codex app-server`, initialize, run `fn`, stop it. `ok: false` says why it could not answer. */
export async function codexSession<T>(
  file: string,
  cwd: string,
  fn: (conn: CodexConn) => Promise<T>,
  timeoutMs = 15_000,
): Promise<CodexSession<T>> {
  await ensureShellEnv();
  const spec = launchSpec(file, ['app-server']);
  const ctl = new AbortController();
  const pending = new Map<number, (m: Record<string, unknown>) => void>();
  const spawnedAtMs = Date.now();
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
  let nextId = 0;
  const raw = (method: string, params: unknown) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const id = ++nextId;
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
      (async (): Promise<CodexSession<T> | null> => {
        const init = await raw('initialize', {
          clientInfo: { name: 'plasma', title: 'Plasma', version: '0' },
          capabilities: null,
        });
        if (init.error) {
          const msg = (init.error as { message?: unknown }).message;
          return { ok: false, reason: redactCliMessage(String(msg ?? 'initialize failed')) };
        }
        proc.write({ method: 'initialized' });
        const info = (init.result ?? {}) as { userAgent?: unknown; codexHome?: unknown };
        const userAgent = typeof info.userAgent === 'string' ? info.userAgent : undefined;
        const value = await fn({
          async ask(method, params) {
            const r = await raw(method, params);
            const msg = (r.error as { message?: unknown } | undefined)?.message;
            return r.error
              ? { error: redactCliMessage(String(msg ?? 'failed')) }
              : { result: r.result };
          },
          ...(userAgent ? { userAgent } : {}),
          ...(typeof info.codexHome === 'string' ? { codexHome: info.codexHome } : {}),
          spawnedAtMs,
        });
        return { ok: true, value, ...(userAgent ? { userAgent } : {}) };
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

/** Ask a Codex app-server a few things and stop it. */
export async function codexQuery(
  file: string,
  cwd: string,
  methods: Array<[string, unknown]>,
  timeoutMs = 15_000,
): Promise<CodexAnswer> {
  const r = await codexSession(
    file,
    cwd,
    async (c) => {
      const results: unknown[] = [];
      const errors: string[] = [];
      for (const [method, params] of methods) {
        const a = await c.ask(method, params);
        results.push('result' in a ? a.result : null);
        errors.push('error' in a ? a.error : '');
      }
      return { results, errors };
    },
    timeoutMs,
  );
  if (!r.ok) return r;
  return { ok: true, ...(r.userAgent ? { userAgent: r.userAgent } : {}), ...r.value };
}

/** All pages of `model/list` (cursor / nextCursor). Null when the first page fails. */
export async function listAllCodexModelPages(c: CodexConn): Promise<unknown[] | null> {
  const pages: unknown[] = [];
  let cursor: string | null | undefined;
  for (let i = 0; i < 20; i++) {
    const r = await c.ask('model/list', cursor ? { cursor } : {});
    if ('error' in r) return pages.length > 0 ? pages : null;
    pages.push(r.result);
    cursor = (r.result as { nextCursor?: unknown } | null)?.nextCursor as string | null | undefined;
    if (!cursor) break;
  }
  return pages;
}

/** When Codex last wrote `models_cache.json` (epoch ms); NaN when unreadable. */
export async function readModelsCacheFetchedAt(codexHome: string): Promise<number> {
  try {
    const j = JSON.parse(await readFile(join(codexHome, 'models_cache.json'), 'utf8')) as {
      fetched_at?: unknown;
    };
    return typeof j.fetched_at === 'string' ? Date.parse(j.fetched_at) : Number.NaN;
  } catch {
    return Number.NaN;
  }
}

/**
 * `model/list` serves `CODEX_HOME/models_cache.json` while it is young, and the backend
 * tailors the catalog to the client's originator. Wait (briefly) until a write newer than
 * this process's start lands; false when none did, and the first answer stands.
 */
export async function waitForModelsCacheRefresh(
  codexHome: string,
  sinceMs: number,
  opts: { timeoutMs?: number; pollMs?: number; read?: (home: string) => Promise<number> } = {},
): Promise<boolean> {
  const end = Date.now() + (opts.timeoutMs ?? 3_000);
  const read = opts.read ?? readModelsCacheFetchedAt;
  for (;;) {
    if ((await read(codexHome)) >= sinceMs) return true;
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 100));
  }
}

function codexHomeOf(conn: CodexConn): string {
  return conn.codexHome || codexEnv().CODEX_HOME || join(homedir(), '.codex');
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
  store: ManifestStore = manifestStore(),
  opts: { cacheWaitMs?: number } = {},
): Promise<AiModelsResult> {
  await ensureShellEnv();
  const human = cliProviderName(provider);
  const found = await resolveBinary(BIN[provider], override, deps ?? defaultResolveDeps());
  if (!found) {
    return {
      models: [],
      fetchedAt: 0,
      source: 'none',
      error: `${human} is not installed. Add it in Settings, AI.`,
    };
  }
  // Never waits on the network: the copy in memory (disk or bundle); the refresh runs behind.
  const manifest = await store.current();
  store.refreshInBackground();

  if (provider === 'claude-code') {
    const ver = await run(found.path, ['--version'], 8_000);
    const version = ver.ok ? parseVersion(ver.stdout) : undefined;
    const { models, updateRequired } = claudeModelsForVersion(manifest, version);
    return {
      models,
      fetchedAt: Date.now(),
      source: 'live',
      ...(updateRequired.length > 0 ? { updateRequired } : {}),
      origin: { kind: 'plasma-list', ...(version ? { cliVersion: version } : {}) },
    };
  }

  const res = await codexSession(
    found.path,
    cwd,
    async (c) => {
      let pages = await listAllCodexModelPages(c);
      if (!pages) return null;
      if (
        await waitForModelsCacheRefresh(codexHomeOf(c), c.spawnedAtMs, {
          ...(opts.cacheWaitMs !== undefined ? { timeoutMs: opts.cacheWaitMs } : {}),
        })
      ) {
        pages = (await listAllCodexModelPages(c)) ?? pages;
      }
      return pages;
    },
    25_000,
  );
  const models = res.ok && res.value ? buildCodexModels(res.value, manifest) : [];
  if (models.length === 0) {
    return {
      models: [],
      fetchedAt: 0,
      source: 'none',
      error: res.ok
        ? 'Could not read the model list from Codex. Type a model name instead.'
        : `Codex did not answer: ${res.reason}`,
    };
  }
  const version = versionFromUserAgent(res.ok ? res.userAgent : undefined);
  return {
    models,
    fetchedAt: Date.now(),
    source: 'live',
    origin: { kind: 'codex', ...(version ? { cliVersion: version } : {}) },
  };
}
