import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AiCliProvider } from '@shared/ai-cli';
import { cliProviderName } from '@shared/ai-cli';
import { type AiContent, contentText } from '@shared/ai-images';
import type { AiChatEvent } from '@shared/protocol';
import { claudeMcpConfig, runClaude } from './claude';
import { runCodex } from './codex';
import {
  type ResolveDeps,
  type Resolved,
  defaultResolveDeps,
  launchSpec,
  resolveBinary,
} from './resolve';
import { ensureShellEnv } from './shell-env';
import { type ToolEndpoint, createToolEndpoint, mcpToolsFromOpenAi } from './tool-endpoint';
import type { CliRun, CliRunResult } from './types';

/**
 * One chat through a CLI: find the program, offer Plasma's tools on the loopback
 * endpoint, run it, stream its text as `delta` events, and finish with `done` or
 * `error`. Plasma keeps no CLI session: the whole conversation travels in every
 * request, as a compact transcript ahead of the latest message.
 */

export const CLI_TRANSCRIPT_MAX_CHARS = 60_000;
export const CLI_CALLS_PER_ROUND = 3;

export type HistoryMessage = { role: 'system' | 'user' | 'assistant'; content: AiContent };

let sharedEndpoint: ToolEndpoint | null = null;
function endpoint(version: string): ToolEndpoint {
  sharedEndpoint ??= createToolEndpoint({ version });
  return sharedEndpoint;
}
export async function closeCliEndpoint(): Promise<void> {
  const e = sharedEndpoint;
  sharedEndpoint = null;
  await e?.close();
}

/** The folder the CLI runs in: empty, owned by Plasma, readable by nobody else. */
export async function ensureEmptyDir(userData: string): Promise<string> {
  const dir = join(userData, 'ai-cli', 'empty');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(dir, 0o700).catch(() => undefined);
  return dir;
}

const roleLabel = (r: string) => (r === 'user' ? 'User' : 'Assistant');

/**
 * The latest user message (text, images) and, ahead of it, the earlier turns as a
 * plain transcript. Old turns are dropped first when the transcript is long.
 */
export function buildCliPrompt(history: readonly HistoryMessage[]): {
  prompt: string;
  images: Array<{ mediaType: string; data: string; url: string }>;
} {
  const turns = history.filter((m) => m.role !== 'system');
  let last = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]?.role === 'user') {
      last = i;
      break;
    }
  }
  const latest = last >= 0 ? (turns[last] as HistoryMessage) : null;
  const before = last >= 0 ? turns.slice(0, last) : turns;
  const lines: string[] = [];
  for (const m of before) {
    const text = contentText(m.content).trim();
    const imgs =
      typeof m.content === 'string' ? 0 : m.content.filter((p) => p.type === 'image_url').length;
    const extra = imgs ? ` [${imgs} image${imgs === 1 ? '' : 's'} not repeated]` : '';
    if (text || extra) lines.push(`${roleLabel(m.role)}: ${text}${extra}`);
  }
  let transcript = lines.join('\n\n');
  if (transcript.length > CLI_TRANSCRIPT_MAX_CHARS) {
    transcript = `[earlier messages left out]\n\n${transcript.slice(-CLI_TRANSCRIPT_MAX_CHARS)}`;
  }
  const latestText = latest ? contentText(latest.content) : '';
  const images: Array<{ mediaType: string; data: string; url: string }> = [];
  if (latest && typeof latest.content !== 'string') {
    for (const p of latest.content) {
      if (p.type !== 'image_url') continue;
      const m = /^data:(image\/[a-z]+);base64,(.+)$/s.exec(p.image_url.url);
      if (m?.[1] && m[2]) images.push({ mediaType: m[1], data: m[2], url: p.image_url.url });
    }
  }
  const prompt = transcript
    ? `Conversation so far:\n\n${transcript}\n\n---\nThe user's latest message (answer this one):\n\n${latestText}`
    : latestText;
  return { prompt, images };
}

export interface CliChatInput {
  provider: AiCliProvider;
  requestId: string;
  send(evt: AiChatEvent): void;
  model: string;
  /** Settings override of the program's path ('' = find it). */
  binaryOverride: string;
  userData: string;
  appVersion: string;
  system: string;
  history: readonly HistoryMessage[];
  /** The tools `pump` would offer, OpenAI function specs. Empty = a task, no tools. */
  tools: readonly unknown[];
  maxRounds: number;
  /** Runs one offered tool call; the same dispatch every provider uses. */
  executeCall(
    call: { id: string; name: string; arguments: string },
    signal: AbortSignal,
  ): Promise<string>;
  signal: AbortSignal;
  timeoutMs?: number;
}

export interface CliChatDeps {
  endpoint?: ToolEndpoint;
  resolve?: ResolveDeps;
  runner?: (provider: AiCliProvider, run: CliRun) => Promise<CliRunResult>;
}

const NOT_INSTALLED = (p: AiCliProvider) =>
  `${cliProviderName(p)} is not installed. Install it, sign in, and try again (Settings, AI).`;

export async function runCliChat(input: CliChatInput, deps: CliChatDeps = {}): Promise<void> {
  const { provider, requestId, send, signal } = input;
  const fail = (message: string) => {
    if (!signal.aborted) send({ kind: 'error', requestId, message });
  };
  const bin = provider === 'codex' ? 'codex' : 'claude';
  let found: Resolved | null;
  try {
    await ensureShellEnv();
    found = await resolveBinary(bin, input.binaryOverride, deps.resolve ?? defaultResolveDeps());
  } catch {
    found = null;
  }
  if (!found) {
    fail(
      input.binaryOverride.trim()
        ? `${cliProviderName(provider)} was not found at the path set in Settings, AI.`
        : NOT_INSTALLED(provider),
    );
    return;
  }
  if (signal.aborted) return;

  let registration: Awaited<ReturnType<ToolEndpoint['register']>> | null = null;
  let configPath: string | undefined;
  let systemPath: string | undefined;
  try {
    const cwd = await ensureEmptyDir(input.userData);
    const offered = new Set(
      (input.tools as ReadonlyArray<{ function: { name: string } }>).map((t) => t.function.name),
    );
    if (offered.size > 0) {
      let calls = 0;
      registration = await (deps.endpoint ?? endpoint(input.appVersion)).register({
        tools: mcpToolsFromOpenAi(input.tools),
        async call(name, args, callSignal) {
          // SC-05: never run a tool the chat did not offer.
          if (!offered.has(name))
            return JSON.stringify({ error: `rejected: ${name} is not available` });
          calls++;
          // One Codex exec script may make several calls: the cap is per call, 3 per round.
          if (calls > input.maxRounds * CLI_CALLS_PER_ROUND) {
            return JSON.stringify({
              error:
                'rejected: too many tool calls in this chat. Answer the user now with what you already have.',
            });
          }
          return input.executeCall(
            { id: `cli-${randomUUID()}`, name, arguments: JSON.stringify(args) },
            AbortSignal.any([signal, callSignal]),
          );
        },
      });
    }
    const ep = registration ? { url: registration.url, token: registration.token } : null;
    if (provider === 'claude-code') {
      configPath = join(input.userData, 'ai-cli', `mcp-${randomUUID()}.json`);
      await writeFile(configPath, claudeMcpConfig(ep), { mode: 0o600 });
      systemPath = join(input.userData, 'ai-cli', `system-${randomUUID()}.txt`);
      await writeFile(systemPath, input.system, { mode: 0o600 });
    }
    const { prompt, images } = buildCliPrompt(input.history);
    const run: CliRun = {
      launch: launchSpec(found.path, []),
      cwd,
      model: input.model,
      system: input.system,
      prompt,
      images,
      endpoint: ep,
      ...(configPath ? { mcpConfigPath: configPath } : {}),
      ...(systemPath ? { systemPromptPath: systemPath } : {}),
      toolNames: [...offered],
      onDelta: (text) => {
        if (!signal.aborted) send({ kind: 'delta', requestId, text });
      },
      signal,
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      appVersion: input.appVersion,
    };
    const result = await (deps.runner
      ? deps.runner(provider, run)
      : provider === 'codex'
        ? runCodex(run)
        : runClaude(run));
    if (signal.aborted) return;
    if (result.ok) send({ kind: 'done', requestId });
    else fail(result.message || `${cliProviderName(provider)} stopped.`);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  } finally {
    registration?.revoke();
    if (configPath) await rm(configPath, { force: true }).catch(() => undefined);
    if (systemPath) await rm(systemPath, { force: true }).catch(() => undefined);
  }
}
