import { randomUUID } from 'node:crypto';
import { normalizeAction } from '@shared/agent-actions';
import { buildAgentSystemPrompt } from '@shared/agent-prompt';
import { type AiContent, capHistoryImages, contentText, countImages } from '@shared/ai-images';
import { memoryActionResult } from '@shared/ai-memory';
import { taskMaxTokens, taskSystemPrompt } from '@shared/ai-tasks';
import {
  AiActionResult,
  type AiChatEvent,
  type AiChatRequest,
  type AiMessage,
  type ConnectionEngine,
  type SchemaInfo,
} from '@shared/protocol';
import { compactSchema } from '@shared/schema-compact';
import { isSqlEngine } from '@shared/sql-dialect';
import type { BrowserWindow } from 'electron';
import type { MemoryToolHooks } from './ai-memory';
import { buildOpenRouterBody } from './ai-policy';
import { logger } from './logger';

export {
  AI_TOOL_MAX_BYTES,
  AI_TOOL_MAX_ROWS,
  buildOpenRouterBody,
  capAiToolJson,
  isAiRowDataAllowed,
  isAiSchemaAllowed,
  isReadOnlyRedisCommand,
  isReadOnlySql,
  serializeAiToolRows,
  shapeAgentActionResult,
} from './ai-policy';

/**
 * OpenRouter client for Plasma's AI sidecar.
 *
 * Key never leaves main — the renderer sends prompts via IPC, main
 * proxies the request to https://openrouter.ai/api/v1/chat/completions
 * with `stream: true` (SSE) and forwards each delta back to the
 * renderer over the `plasma:ai:event` event channel.
 *
 * Cancellation is wired through AbortController, keyed by `requestId`
 * so multiple concurrent completions can run side-by-side (e.g. user
 * runs "explain selection" while a longer NL→SQL is still streaming).
 *
 * Tool use: the model can call `query_database(sql)` to read live data
 * from the connected Postgres when the connection opts in (U06). Keyword
 * `isReadOnlySql` is only a cheap pre-filter — the worker runs AI SQL on a
 * dedicated read-only client (U04). Each tool round streams to collect
 * tool_calls, then the next round continues. Bounded by MAX_TOOL_ROUNDS.
 */

const DEFAULT_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * `PLASMA_AI_ENDPOINT` exists for tests (a local mock server). It carries
 * the user's API key, so only OpenRouter or a loopback address is honoured
 * (C34) — an env var can't redirect the key to an arbitrary host.
 */
export function resolveAiEndpoint(override: string | undefined): string {
  if (!override) return DEFAULT_ENDPOINT;
  try {
    const url = new URL(override);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (loopback && (url.protocol === 'http:' || url.protocol === 'https:')) return override;
    if (url.protocol === 'https:' && url.hostname === 'openrouter.ai') return override;
  } catch {
    /* fall through */
  }
  logger.warn('[plasma-ai] ignoring PLASMA_AI_ENDPOINT — only openrouter.ai or loopback allowed');
  return DEFAULT_ENDPOINT;
}

/**
 * Endpoint of a local OpenAI-compatible server (Ollama, LM Studio). Nothing
 * leaves the machine: only http(s) on localhost / 127.0.0.1 / [::1] is
 * accepted, and a URL that already ends in `/chat/completions` is used as is.
 */
export function resolveLocalAiEndpoint(
  raw: string | undefined,
): { ok: true; endpoint: string } | { ok: false; error: string } {
  const text = (raw ?? '').trim();
  if (!text) return { ok: false, error: 'No local model URL set. Add it in Settings, AI.' };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: `"${text}" is not a valid URL for the local model.` };
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!loopback || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    return {
      ok: false,
      error:
        'The local model URL must be http or https on localhost, 127.0.0.1 or [::1]. Nothing was sent.',
    };
  }
  if (url.username || url.password) {
    return { ok: false, error: 'The local model URL must not contain a user name or password.' };
  }
  const path = url.pathname.replace(/\/+$/, '');
  const full = path.endsWith('/chat/completions') ? path : `${path}/chat/completions`;
  return { ok: true, endpoint: `${url.origin}${full}` };
}

const ENDPOINT = resolveAiEndpoint(process.env.PLASMA_AI_ENDPOINT);
const REFERER = 'https://plasma.sh';
const TITLE = 'Plasma';
const MAX_TOOL_ROUNDS = 5;
/** Agent turns chain more calls: look, propose, adjust. */
const MAX_AGENT_TOOL_ROUNDS = 8;

const inflight = new Map<string, AbortController>();

type PendingAction = { requestId: string; resolve: (res: AiActionResult) => void };
/** Agent actions waiting for the user's click, keyed `requestId:callId`. */
const pendingActions = new Map<string, PendingAction>();
const actionKey = (requestId: string, callId: string) => `${requestId}:${callId}`;

/** Resolve every action of `requestId` that still waits on the user as cancelled. */
function cancelPendingActions(requestId: string): void {
  for (const [key, p] of [...pendingActions.entries()]) {
    if (p.requestId !== requestId) continue;
    pendingActions.delete(key);
    p.resolve({
      requestId,
      callId: key.slice(requestId.length + 1),
      outcome: 'cancelled',
      note: 'The chat was stopped.',
    });
  }
}

/**
 * The renderer went away (reload, crash, window closed): nobody can answer the
 * cards any more. Abort every chat and resolve every waiting action as cancelled.
 */
export function cancelAllAiChats(): void {
  for (const [id, ctl] of [...inflight.entries()]) {
    ctl.abort();
    inflight.delete(id);
  }
  for (const requestId of new Set([...pendingActions.values()].map((p) => p.requestId))) {
    cancelPendingActions(requestId);
  }
}

/**
 * The renderer's answer to an `action` event. Validated here; a result for a
 * key nobody waits on (stale, replayed, forged) is ignored.
 */
export function submitAiActionResult(raw: unknown): boolean {
  const parsed = AiActionResult.safeParse(raw);
  if (!parsed.success) {
    // A result for a card main waits on must never be dropped silently: the
    // loop would hang. Answer the model with a failure instead.
    const r = raw as { requestId?: unknown; callId?: unknown } | null;
    if (r && typeof r.requestId === 'string' && typeof r.callId === 'string') {
      const key = actionKey(r.requestId, r.callId);
      const waiting = pendingActions.get(key);
      if (waiting) {
        pendingActions.delete(key);
        waiting.resolve({
          requestId: r.requestId,
          callId: r.callId,
          outcome: 'failed',
          note: 'The app sent an invalid result for this action.',
        });
        return true;
      }
    }
    return false;
  }
  const key = actionKey(parsed.data.requestId, parsed.data.callId);
  const waiting = pendingActions.get(key);
  if (!waiting) return false;
  pendingActions.delete(key);
  waiting.resolve(parsed.data);
  return true;
}

export type AiChatOptions = {
  /** Where the request goes. Default: OpenRouter. `local` needs no API key. */
  provider?: 'openrouter' | 'local';
  /** Base URL of the local server (provider `local`). */
  localUrl?: string;
  /** Model name on the local server (provider `local`); required. */
  localModel?: string;
  /** When false (default), tools that egress row data are not offered. */
  allowRowData?: boolean;
  /**
   * Re-checked immediately before EVERY agent action is shown to the user:
   * a refusal message when the active connection is no longer the chat's,
   * null when the action may be proposed. (Unlike `toolGuard` this does not
   * depend on the row-data opt-in: actions never egress rows by themselves.)
   */
  actionGuard?: () => string | null;
  /**
   * Turn the renderer's answer to an action into the tool message the model
   * sees. Main supplies this where the connection and settings are known, so
   * rows are masked and capped there and only included while the row-data
   * opt-in holds. The default never includes rows.
   */
  shapeActionResult?: (res: AiActionResult) => string;
  /**
   * SC-20: schema names / sample keys / cluster summaries are sent as the
   * system prompt only when allowed for the connection (default: no).
   */
  allowSchema?: boolean;
  /**
   * SC-05: re-checked immediately before EVERY tool execution. Returns a
   * refusal message when the active connection changed or the row-data
   * opt-in was revoked since the chat started; null when the call may run.
   */
  toolGuard?: () => string | null;
  /**
   * Database memory for the bound connection: the section for the system
   * prompt (null/absent = nothing to send: no notes, or the switch is off).
   */
  memory?: MemorySection | null | (() => MemorySection | null);
  /**
   * Offers `remember` / `forget` to the agent and validates them against the
   * stored notes. Absent when memory is off for the connection.
   */
  memoryTools?: MemoryToolHooks;
  /** Injectable fetch for regression tests that capture the request body. */
  fetchImpl?: typeof fetch;
};

type MemorySection = { text: string; count: number };
export type { MemoryToolHooks } from './ai-memory';

/** Names of the tools offered for `engine` (a model may only call these). */
export function offeredToolNames(engine: ConnectionEngine): Set<string> {
  return namesOf(toolsForEngine(engine));
}

function namesOf(tools: readonly unknown[]): Set<string> {
  return new Set(
    (tools as ReadonlyArray<{ function: { name: string } }>).map((t) => t.function.name),
  );
}

/** Tool names handled by the renderer (the user decides), not by `toolExecutor`. */
const ACTION_TOOL_NAMES = new Set([
  'show_table',
  'run_query',
  'propose_change',
  'open_in_editor',
  'remember',
  'forget',
]);

export type AiToolExecutor = (name: string, args: Record<string, unknown>) => Promise<string>;

let toolExecutor: AiToolExecutor | null = null;

export function setAiToolExecutor(executor: AiToolExecutor | null): void {
  toolExecutor = executor;
}

/**
 * OpenAI-style tool specs. We register a different subset depending on
 * which engine the active connection is using — `query_database` only
 * makes sense for relational stores, while `redis_command` and the
 * OpenSearch tools are no-ops on Postgres.
 */
const TOOLS_POSTGRES = [
  {
    type: 'function',
    function: {
      name: 'query_database',
      description:
        'Execute a read-only SQL query against the connected Postgres database and return up to 50 rows as JSON. SELECT, EXPLAIN, SHOW, WITH, VALUES, TABLE only — writes are rejected. Useful for sampling, counts, or verifying assumptions before answering.',
      parameters: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'A read-only SQL statement.' },
        },
        required: ['sql'],
      },
    },
  },
] as const;

const FILTER_PARAM = {
  type: 'object',
  properties: {
    column: { type: 'string', description: 'Exact column name.' },
    op: {
      type: 'string',
      description:
        'One of: =, !=, >, <, >=, <=, LIKE, ILIKE, NOT LIKE, NOT ILIKE, IN, NOT IN, BETWEEN, IS NULL, IS NOT NULL.',
    },
    value: {
      type: 'string',
      description:
        'Text value. IN takes "a, b, c", BETWEEN takes "low, high", LIKE is wrapped in % by the app. Empty for IS [NOT] NULL.',
    },
  },
  required: ['column', 'op', 'value'],
} as const;

/**
 * Agent tools (AI panel). Offered on SQL engines when the request is an
 * agent turn. Each call becomes a card the user approves in the renderer.
 */
const TOOLS_AGENT = [
  {
    type: 'function',
    function: {
      name: 'show_table',
      description:
        'Open one table in a grid tab with a view the user can review: which columns, sort order, filters and page size. Parts you leave out or set to null stay as they are. Does not change data.',
      parameters: {
        type: 'object',
        properties: {
          schema: { type: 'string' },
          table: { type: 'string' },
          columns: {
            type: ['array', 'null'],
            items: { type: 'string' },
            description: 'Columns to show, in order (exact names, at least one).',
          },
          sort: {
            type: ['array', 'null'],
            items: {
              type: 'object',
              properties: {
                column: { type: 'string' },
                direction: { type: 'string', enum: ['asc', 'desc'] },
              },
              required: ['column', 'direction'],
            },
          },
          filters: { type: ['array', 'null'], items: FILTER_PARAM, description: 'ANDed filters.' },
          limit: { type: ['integer', 'null'], description: 'Rows per page, 1 to 1000.' },
        },
        required: ['schema', 'table'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_query',
      description:
        'Run ONE read-only SQL query (SELECT / WITH / EXPLAIN / SHOW / VALUES / TABLE) in a new editor tab so the user sees the result. The user approves it first. Writes are rejected.',
      parameters: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'Exactly one read-only statement.' },
          title: { type: 'string', description: 'Short tab title.' },
        },
        required: ['sql'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_change',
      description:
        'Propose ONE statement that changes data or schema (INSERT, UPDATE, DELETE, DDL). The user reviews it and decides; on Postgres it is previewed in a transaction first. Read-only SQL is rejected: use run_query.',
      parameters: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'Exactly one statement.' },
          summary: { type: 'string', description: 'One sentence: what it does and how many rows.' },
        },
        required: ['sql', 'summary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_in_editor',
      description: 'Put SQL in a new editor tab without running it.',
      parameters: {
        type: 'object',
        properties: { sql: { type: 'string' } },
        required: ['sql'],
      },
    },
  },
] as const;

/** Offered on top of TOOLS_AGENT while the connection's memory is on. */
const TOOLS_MEMORY = [
  {
    type: 'function',
    function: {
      name: 'remember',
      description:
        'Propose ONE short note to keep about this database: a business rule the user stated or corrected, or what a table or column means. The user can edit it before approving. Never store row values, personal data, passwords or keys. At most one per reply.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'One short sentence, at most 500 characters.' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'forget',
      description: 'Propose removing a note that is wrong or out of date. The user approves first.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The note id from the notes list, e.g. "m:a1b2c3".' },
        },
        required: ['id'],
      },
    },
  },
] as const;

const TOOLS_REDIS = [
  {
    type: 'function',
    function: {
      name: 'redis_command',
      description:
        'Execute a read-only Redis command and return the reply as JSON. Allow-list: GET, MGET, EXISTS, TYPE, TTL, PTTL, OBJECT, STRLEN, HGET, HGETALL, HKEYS, HLEN, HMGET, LRANGE, LLEN, SMEMBERS, SCARD, ZRANGE, ZSCORE, ZCARD, XLEN, XRANGE, XREVRANGE, INFO, DBSIZE, SCAN (use this to list keys), MEMORY USAGE, CLIENT LIST, SLOWLOG GET. Anything else is rejected.',
      parameters: {
        type: 'object',
        properties: {
          parts: {
            type: 'array',
            items: { type: 'string' },
            description: 'The command tokenized into a string array, e.g. ["GET", "myKey"].',
          },
        },
        required: ['parts'],
      },
    },
  },
] as const;

const TOOLS_OPENSEARCH = [
  {
    type: 'function',
    function: {
      name: 'os_search',
      description:
        'Run an OpenSearch query DSL request against an index and return the first 50 hits + total count. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'string' },
          body: {
            type: 'string',
            description: 'JSON-encoded OpenSearch query DSL body. Must include a "query" clause.',
          },
        },
        required: ['index', 'body'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'os_sql',
      description:
        'Run a SELECT through the OpenSearch SQL plugin (`/_plugins/_sql`) and return the result rows. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'A SELECT statement.' },
        },
        required: ['query'],
      },
    },
  },
] as const;

function toolsForEngine(engine: ConnectionEngine): readonly unknown[] {
  if (isSqlEngine(engine)) return TOOLS_POSTGRES;
  if (engine === 'redis') return TOOLS_REDIS;
  return TOOLS_OPENSEARCH;
}

export async function startAiChat(
  win: BrowserWindow | null,
  req: AiChatRequest,
  apiKey: string,
  defaultModel: string,
  options: AiChatOptions = {},
): Promise<{ accepted: boolean; reason?: string }> {
  if (options.provider === 'local') {
    const local = resolveLocalAiEndpoint(options.localUrl);
    if (!local.ok) return { accepted: false, reason: local.error };
    if (!options.localModel?.trim()) {
      return {
        accepted: false,
        reason: 'No local model set. Enter the model name in Settings, AI.',
      };
    }
  } else if (!apiKey || apiKey.trim().length === 0) {
    return { accepted: false, reason: 'no OpenRouter API key configured' };
  }
  if (!win || win.isDestroyed()) {
    return { accepted: false, reason: 'no renderer window' };
  }

  // Pre-cancel any prior request reusing the same id (rare, but the
  // renderer may submit on enter twice via key repeat).
  const existing = inflight.get(req.requestId);
  if (existing) {
    existing.abort();
    cancelPendingActions(req.requestId);
  }

  const controller = new AbortController();
  inflight.set(req.requestId, controller);

  // Fire the SSE pump asynchronously — caller awaits the queueing only,
  // not the full completion.
  void pump(win, req, apiKey, defaultModel, controller, options);
  return { accepted: true };
}

export function cancelAiChat(requestId: string): void {
  const ctl = inflight.get(requestId);
  if (ctl) {
    ctl.abort();
    inflight.delete(requestId);
  }
  // Stop / clear while a card waits: the loop must not hang on the user.
  cancelPendingActions(requestId);
}

async function pump(
  win: BrowserWindow,
  req: AiChatRequest,
  apiKey: string,
  defaultModel: string,
  controller: AbortController,
  options: AiChatOptions = {},
): Promise<void> {
  const send = (evt: AiChatEvent) => {
    if (!win.isDestroyed()) {
      win.webContents.send('plasma:ai:event', evt);
    }
  };

  // Internal message format mirrors OpenAI's: `tool_calls` on assistant
  // turns and `role: 'tool'` for results. We never expose these to the
  // renderer — the chat UI only sees user and assistant text.
  type InternalMsg =
    | { role: 'system'; content: string }
    | { role: 'user'; content: AiContent }
    | {
        role: 'assistant';
        content: string;
        tool_calls?: Array<{
          id: string;
          type: 'function';
          function: { name: string; arguments: string };
        }>;
      }
    | { role: 'tool'; tool_call_id: string; content: string };

  const engine = req.engine ?? 'postgres';
  const allowSchema = options.allowSchema === true;
  const local = options.provider === 'local';
  // One-shot tasks (Fix with AI, Explain plan, NL filter) are Postgres-only,
  // use their own system prompt and never get row-data tools.
  const task = engine === 'postgres' ? req.task : undefined;
  // U06: only offer row-data tools when the active connection opted in.
  const allowRowData = options.allowRowData === true && !task;
  // Agent actions are offered on SQL engines whatever the row-data opt-in
  // says: they put the user's click between the model and every effect, and
  // what they send back is gated separately (`shapeActionResult`).
  const agentMode = req.agent === true && !task && isSqlEngine(engine);
  const readMemory = (): MemorySection | null =>
    typeof options.memory === 'function' ? options.memory() : (options.memory ?? null);
  const build = (mem: string | undefined): InternalMsg[] =>
    task
      ? buildTaskMessages(task, req.messages, allowSchema ? req.schema : null, mem)
      : agentMode
        ? buildAgentMessages(
            req.messages,
            engine,
            allowSchema ? req.schema : null,
            allowSchema ? req.context : undefined,
            allowRowData,
            mem,
            options.memoryTools !== undefined,
          )
        : buildMessages(
            req.messages,
            engine,
            allowSchema ? req.schema : null,
            allowSchema ? req.engineContext : undefined,
            mem,
          );
  let memoryText = readMemory()?.text;
  const messages: InternalMsg[] = build(memoryText);
  const sentImages = !task && req.messages.some((m) => countImages(m.content) > 0);
  const model = local
    ? (options.localModel ?? '').trim()
    : req.model?.trim()
      ? req.model
      : defaultModel;
  const tools: readonly unknown[] = [
    ...(agentMode ? TOOLS_AGENT : []),
    ...(agentMode && options.memoryTools ? TOOLS_MEMORY : []),
    ...(allowRowData ? toolsForEngine(engine) : []),
  ];
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = local
    ? (() => {
        const r = resolveLocalAiEndpoint(options.localUrl);
        return r.ok ? r.endpoint : ENDPOINT;
      })()
    : ENDPOINT;
  const maxRounds = agentMode ? MAX_AGENT_TOOL_ROUNDS : MAX_TOOL_ROUNDS;

  try {
    for (let round = 0; round <= maxRounds; round++) {
      const isLastAllowedRound = round === maxRounds;
      // A note deleted (or the switch turned off) while a card waited must not go out again.
      if (round > 0) {
        const now = readMemory()?.text;
        if (now !== memoryText) {
          memoryText = now;
          const fresh = build(now)[0];
          const hadSystem = messages[0]?.role === 'system';
          if (fresh?.role === 'system') {
            if (hadSystem) messages[0] = fresh as InternalMsg;
            else messages.unshift(fresh as InternalMsg);
          } else if (hadSystem) {
            messages.shift();
          }
        }
      }
      // Stream the final round (when we want text streaming for UX).
      // For tool-call rounds we still stream so partial deltas appear
      // for any text the model emits before/after tool calls.
      const offeredTools = !isLastAllowedRound && tools.length > 0 ? tools : null;
      const body = buildOpenRouterBody({
        model,
        messages,
        maxTokens: req.maxTokens ?? (task ? taskMaxTokens(task) : undefined),
        tools: offeredTools,
        stream: true,
      });

      // A local server gets no key and none of OpenRouter's headers.
      const headers: Record<string, string> = local
        ? { 'Content-Type': 'application/json' }
        : {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': REFERER,
            'X-Title': TITLE,
          };
      let res: Response;
      try {
        res = await fetchImpl(endpoint, {
          method: 'POST',
          signal: controller.signal,
          headers,
          body,
          // A local server must not be able to bounce the request (schema,
          // context, row samples) to another host.
          ...(local ? { redirect: 'error' as const } : {}),
        });
      } catch (err) {
        if (controller.signal.aborted || !local) throw err;
        send({
          kind: 'error',
          requestId: req.requestId,
          message: `Could not reach the local model at ${options.localUrl?.trim() ?? endpoint}. Is Ollama (or LM Studio) running?`,
        });
        return;
      }

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        send({
          kind: 'error',
          requestId: req.requestId,
          message: `${local ? 'Local model' : 'OpenRouter'} HTTP ${res.status}: ${text || res.statusText}${
            local && sentImages
              ? ' (This message has images. The local model may not support images.)'
              : ''
          }`,
        });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let assistantText = '';
      const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
      let finishReason: string | null = null;

      let streamDone = false;
      while (!streamDone) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let nl = buffer.indexOf('\n');
        while (nl !== -1) {
          const line = buffer.slice(0, nl).replace(/\r$/, '');
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf('\n');

          if (line.length === 0) continue;
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') {
            streamDone = true;
            break;
          }
          try {
            const json = JSON.parse(payload);
            const choice = json?.choices?.[0];
            const delta = choice?.delta;
            if (typeof delta?.content === 'string' && delta.content.length > 0) {
              assistantText += delta.content;
              send({ kind: 'delta', requestId: req.requestId, text: delta.content });
            }
            // Tool call accumulation. OpenAI streams tool_calls as a sparse
            // array of partial fragments keyed by `index`. We merge each
            // by index so the final argument string is fully assembled.
            if (Array.isArray(delta?.tool_calls)) {
              for (const part of delta.tool_calls) {
                const idx = typeof part.index === 'number' ? part.index : 0;
                const cur = toolCalls.get(idx) ?? { id: '', name: '', arguments: '' };
                if (part.id) cur.id = part.id;
                if (part.function?.name) cur.name = part.function.name;
                if (typeof part.function?.arguments === 'string') {
                  cur.arguments += part.function.arguments;
                }
                toolCalls.set(idx, cur);
              }
            }
            if (typeof choice?.finish_reason === 'string') {
              finishReason = choice.finish_reason;
            }
          } catch (err) {
            // The payload is model output and may quote database rows: log its size only (SC-27).
            logger.warn('[plasma-ai] could not parse SSE chunk, length', payload.length, err);
          }
        }
      }

      // SC-05: a model (or provider) can return tool_calls nobody offered;
      // those are dropped, never executed.
      const offered = offeredTools ? namesOf(offeredTools) : new Set<string>();
      for (const [idx, c] of [...toolCalls.entries()]) {
        if (!offered.has(c.name)) toolCalls.delete(idx);
      }

      if (controller.signal.aborted) return;
      if (toolCalls.size === 0 || finishReason !== 'tool_calls') {
        // Final turn — done.
        send({ kind: 'done', requestId: req.requestId });
        return;
      }

      // Persist the assistant's tool_calls turn, then run each tool and
      // append the results. Then loop for another round.
      const calls = [...toolCalls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, c]) => c)
        .filter((c) => c.id && c.name);
      messages.push({
        role: 'assistant',
        content: assistantText,
        tool_calls: calls.map((c) => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: c.arguments },
        })),
      });

      for (const call of calls) {
        // SC-05: Stop must also stop tool calls that are still queued.
        if (controller.signal.aborted) return;
        let parsedArgs: Record<string, unknown>;
        try {
          parsedArgs = JSON.parse(call.arguments || '{}');
        } catch {
          parsedArgs = {};
        }
        let result: string;
        try {
          if (ACTION_TOOL_NAMES.has(call.name)) {
            result = await runAgentAction({
              send,
              req,
              call,
              args: parsedArgs,
              options,
              signal: controller.signal,
              windowGone: () => win.isDestroyed(),
            });
          } else {
            const refusal = options.toolGuard?.() ?? null;
            result = refusal
              ? JSON.stringify({ error: `rejected: ${refusal}` })
              : toolExecutor
                ? await toolExecutor(call.name, parsedArgs)
                : JSON.stringify({ error: 'tools are not available' });
          }
        } catch (err) {
          result = JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          });
        }
        if (controller.signal.aborted) return;
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
      // Keep the next round's text off the end of this one. A tool the main
      // process refused shows no card, so the break cannot rely on one (the
      // renderer drops the newline at the start of a part after a card).
      if (assistantText && !assistantText.endsWith('\n')) {
        send({ kind: 'delta', requestId: req.requestId, text: '\n' });
      }
    }

    // Hit MAX_TOOL_ROUNDS — finalize anyway.
    send({ kind: 'done', requestId: req.requestId });
  } catch (err) {
    if (controller.signal.aborted) return;
    const message = err instanceof Error ? err.message : String(err);
    send({ kind: 'error', requestId: req.requestId, message });
  } finally {
    // Only drop our own controller: a retry may have registered a new one.
    if (inflight.get(req.requestId) === controller) inflight.delete(req.requestId);
    cancelPendingActions(req.requestId);
  }
}

/** The tool message for an action result when main supplied no shaper: never rows. */
function defaultActionResult(res: AiActionResult): string {
  return JSON.stringify({
    outcome: res.outcome,
    ...(res.note ? { note: res.note } : {}),
    ...(res.data ? { columns: res.data.columns, rowCount: res.data.rowCount } : {}),
  });
}

/**
 * One agent action: validate the call, re-check the connection, hand it to
 * the renderer as an `action` event and wait for the user's decision. A call
 * that fails validation is answered to the model at once; the user is never
 * asked about it.
 */
async function runAgentAction(input: {
  send: (evt: AiChatEvent) => void;
  req: AiChatRequest;
  call: { id: string; name: string };
  args: Record<string, unknown>;
  options: AiChatOptions;
  signal: AbortSignal;
  windowGone: () => boolean;
}): Promise<string> {
  const { send, req, call, args, options, signal } = input;
  const normalized = normalizeAction(call.name, args);
  if (!normalized.ok) return JSON.stringify({ error: `rejected: ${normalized.error}` });
  const refusal = options.actionGuard?.() ?? null;
  if (refusal) return JSON.stringify({ error: `rejected: ${refusal}` });

  // Memory changes: checked against the stored notes before any card is shown.
  const act = normalized.action;
  let eventArgs = args;
  if (act.name === 'remember' || act.name === 'forget') {
    const hooks = options.memoryTools;
    if (!hooks)
      return JSON.stringify({ error: 'rejected: memory is turned off for this connection' });
    if (act.name === 'remember') {
      const bad = hooks.checkRemember(act.text);
      if (bad) return JSON.stringify({ error: `rejected: ${bad}` });
      eventArgs = { text: act.text };
    } else {
      const found = hooks.resolveForget(act.id);
      if (!found.ok) return JSON.stringify({ error: `rejected: ${found.error}` });
      eventArgs = { id: found.id, text: found.text };
    }
  }

  // Stop can land before the card is even shown: nothing to ask then.
  if (signal.aborted || input.windowGone())
    return JSON.stringify({ outcome: 'cancelled', note: 'The chat was stopped.' });
  const key = actionKey(req.requestId, call.id);
  const answered = new Promise<AiActionResult>((resolve) => {
    pendingActions.set(key, { requestId: req.requestId, resolve });
  });
  send({
    kind: 'action',
    requestId: req.requestId,
    callId: call.id,
    name: normalized.action.name,
    args: eventArgs,
  });
  const res = await answered;
  // Memory answers carry no rows or database errors: the shared wording is the whole reply.
  if (act.name === 'remember' || act.name === 'forget') return memoryActionResult(act.name, res);
  return (options.shapeActionResult ?? defaultActionResult)(res);
}

/** The one MCP proposal waiting for the user (one at a time keeps the panel unambiguous). */
let externalOpen: string | null = null;

export type ExternalChangeResult =
  | { kind: 'answered'; res: AiActionResult }
  | { kind: 'timeout' }
  | { kind: 'cancelled' }
  | { kind: 'refused'; note: string };

/**
 * An external AI tool (MCP) proposes a change. It rides the SAME round-trip as
 * the in-app agent's `propose_change`: the panel gets an `external` event (a
 * thread labelled with the client), then the `action` event; the card runs the
 * statement through the renderer's one write path (prod gate, read-only guard,
 * Safe Run) and answers through `submitAiActionResult`.
 */
export async function requestExternalChange(input: {
  win: BrowserWindow | null;
  client: string;
  connectionId: string;
  sql: string;
  summary: string;
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<ExternalChangeResult> {
  const { win, signal } = input;
  if (!win || win.isDestroyed()) {
    return { kind: 'refused', note: 'Plasma has no open window. Open Plasma and try again.' };
  }
  const args = { sql: input.sql, summary: input.summary };
  const normalized = normalizeAction('propose_change', args);
  if (!normalized.ok) return { kind: 'refused', note: `rejected: ${normalized.error}` };
  if (inflight.size > 0 || externalOpen) {
    return {
      kind: 'refused',
      note: 'The AI panel in Plasma is busy with another request. Try again in a moment.',
    };
  }
  const requestId = `mcp-${randomUUID()}`;
  const callId = 'call-1';
  const key = actionKey(requestId, callId);
  externalOpen = requestId;
  const send = (evt: AiChatEvent) => {
    if (!win.isDestroyed()) win.webContents.send('plasma:ai:event', evt);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const answered = new Promise<ExternalChangeResult>((resolve) => {
      pendingActions.set(key, {
        requestId,
        resolve: (res) => resolve({ kind: 'answered', res }),
      });
      timer = setTimeout(() => resolve({ kind: 'timeout' }), input.timeoutMs);
      onAbort = () => resolve({ kind: 'cancelled' });
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    send({ kind: 'external', requestId, connectionId: input.connectionId, client: input.client });
    send({ kind: 'action', requestId, callId, name: 'propose_change', args });
    return await answered;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
    pendingActions.delete(key);
    externalOpen = null;
    // Closes the thread; a card nobody answered becomes cancelled.
    send({ kind: 'done', requestId });
  }
}

/**
 * Build the OpenRouter messages array. Prepends an engine-specific
 * system prompt + any optional context the renderer prepared (compact
 * Postgres DDL, Redis keyspace overview, OpenSearch cluster summary).
 */
type ChatMsg =
  | { role: 'system' | 'assistant'; content: string }
  | { role: 'user'; content: AiContent };

/** Images ride only on user turns; every other role is plain text. */
function chatMsg(m: AiMessage): ChatMsg {
  return m.role === 'user'
    ? { role: 'user', content: m.content }
    : { role: m.role, content: contentText(m.content) };
}

function buildMessages(
  messages: AiMessage[],
  engine: ConnectionEngine,
  schema?: SchemaInfo | null,
  engineContext?: string,
  memory?: string,
): ChatMsg[] {
  const out: ChatMsg[] = [];

  let systemContent: string | null = null;

  const sqlFlavour: Partial<Record<ConnectionEngine, string>> = {
    postgres: 'Postgres',
    sqlite: 'SQLite',
    mysql: 'MySQL/MariaDB',
    clickhouse: 'ClickHouse',
    duckdb: 'DuckDB',
  };
  if (sqlFlavour[engine] && schema) {
    const ddl = compactSchema(schema);
    if (ddl) {
      systemContent = `You are Plasma's SQL assistant. The user is exploring a ${sqlFlavour[engine]} database. Use the schema below to write correct, concise SQL. When the user asks for a query, return JUST the SQL inside a \`\`\`sql code block — no prose around it unless they explicitly ask for an explanation. Prefer LIMIT clauses on exploratory queries. You may call the \`query_database\` tool to inspect actual data when an answer requires it (e.g. counts, samples, distinct values) — but never run mutations.\n\n--- SCHEMA ---\n${ddl}`;
    }
  } else if (engine === 'redis') {
    systemContent = `You are Plasma's Redis assistant. The user is connected to a Redis instance. When they ask for a command, return JUST the command inside a \`\`\`redis code block (no prose unless they ask). When the user asks WHAT they have, use the \`redis_command\` tool with read-only commands (DBSIZE, INFO, SCAN, TYPE, MEMORY USAGE, etc.) to look around — never use write commands. Redis keys are flat strings, conventionally namespaced with \`:\` separators (\`user:42:profile\`).${
      engineContext ? `\n\n--- INSTANCE ---\n${engineContext}` : ''
    }`;
  } else if (engine === 'opensearch') {
    systemContent = `You are Plasma's OpenSearch assistant. The user is connected to an OpenSearch / Elasticsearch cluster. When they ask for a query, prefer the OpenSearch query DSL inside a \`\`\`json block, or — when SQL fits better — return SELECT inside a \`\`\`sql block (the cluster's SQL plugin will run it). Use the \`os_search\` tool for DSL exploration and \`os_sql\` for SELECT queries. Return raw queries — no surrounding prose unless asked.${
      engineContext ? `\n\n--- CLUSTER ---\n${engineContext}` : ''
    }`;
  }

  // The user's notes go even when the schema does not (they wrote them to be used).
  if (memory) {
    systemContent =
      systemContent ??
      (sqlFlavour[engine]
        ? `You are Plasma's SQL assistant. The user is exploring a ${sqlFlavour[engine]} database. The schema is not available to you. When the user asks for a query, return JUST the SQL inside a \`\`\`sql code block.`
        : "You are Plasma's database assistant.");
    systemContent += `\n\n${memory}`;
  }
  if (systemContent) {
    out.push({ role: 'system', content: systemContent });
  }

  for (const m of capHistoryImages(messages)) out.push(chatMsg(m));
  return out;
}

const SQL_FLAVOUR: Partial<Record<ConnectionEngine, string>> = {
  postgres: 'Postgres',
  sqlite: 'SQLite',
  mysql: 'MySQL/MariaDB',
  clickhouse: 'ClickHouse',
  duckdb: 'DuckDB',
};

/** Messages for an agent turn: the agent prompt (schema and tab context only when allowed), then the chat. */
function buildAgentMessages(
  messages: AiMessage[],
  engine: ConnectionEngine,
  schema: SchemaInfo | null | undefined,
  context: string | undefined,
  rowData: boolean,
  memory?: string,
  memoryTools = false,
): ChatMsg[] {
  const ddl = schema ? compactSchema(schema) : '';
  const system = buildAgentSystemPrompt({
    flavour: SQL_FLAVOUR[engine] ?? 'SQL',
    ddl: ddl || null,
    context: context?.trim() ? context : null,
    rowData,
    memory: memory ?? null,
    memoryTools,
  });
  return [
    { role: 'system', content: system },
    ...capHistoryImages(messages)
      .filter((m) => m.role !== 'system')
      .map(chatMsg),
  ];
}

/**
 * Messages for a one-shot task: the task's system prompt, then (only when
 * the schema is allowed to leave the machine) the relevant schema, then the
 * user turn(s) the renderer built with the prompt builders.
 */
export function buildTaskMessages(
  task: NonNullable<AiChatRequest['task']>,
  messages: AiMessage[],
  schema?: SchemaInfo | null,
  memory?: string,
): ChatMsg[] {
  const ddl = schema ? compactSchema(schema, { withIndexes: task === 'explain-plan' }) : '';
  const system = `${taskSystemPrompt(task)}${ddl ? `\n\n--- SCHEMA ---\n${ddl}` : ''}${
    memory ? `\n\n${memory}` : ''
  }`;
  return [
    { role: 'system', content: system },
    // Tasks are text-only: any image is left out.
    ...messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: contentText(m.content) })),
  ];
}
