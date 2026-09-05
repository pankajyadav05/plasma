import type {
  AiChatEvent,
  AiChatRequest,
  AiMessage,
  ConnectionEngine,
  SchemaInfo,
} from '@shared/protocol';
import type { BrowserWindow } from 'electron';
import { logger } from './logger';

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
 * from the connected Postgres. We only allow read-only SELECT/EXPLAIN/
 * SHOW so the model can't accidentally mutate state. Each tool round
 * non-streams to collect tool_calls, then the next round streams again.
 * Bounded by MAX_TOOL_ROUNDS so a misbehaving model can't loop forever.
 */

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const REFERER = 'https://plasma.sh';
const TITLE = 'Plasma';
const MAX_TOOL_ROUNDS = 5;

const inflight = new Map<string, AbortController>();

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

const TOOLS_REDIS = [
  {
    type: 'function',
    function: {
      name: 'redis_command',
      description:
        'Execute a read-only Redis command and return the reply as JSON. Allow-list: GET, MGET, EXISTS, TYPE, TTL, PTTL, OBJECT, STRLEN, HGET, HGETALL, HKEYS, HLEN, HMGET, LRANGE, LLEN, SMEMBERS, SCARD, ZRANGE, ZSCORE, ZCARD, XLEN, XRANGE, XREVRANGE, INFO, DBSIZE, KEYS (avoid in prod), SCAN, MEMORY USAGE, CONFIG GET, CLIENT LIST, SLOWLOG GET. Anything else is rejected.',
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
  if (engine === 'postgres') return TOOLS_POSTGRES;
  if (engine === 'redis') return TOOLS_REDIS;
  return TOOLS_OPENSEARCH;
}

/**
 * Allow-list of read-only Redis commands. Tool calls outside this set
 * are rejected before they hit the worker. We're deliberately
 * conservative — the AI's job is observation, not mutation.
 */
const REDIS_READ_ONLY = new Set([
  'GET',
  'MGET',
  'EXISTS',
  'TYPE',
  'TTL',
  'PTTL',
  'OBJECT',
  'STRLEN',
  'HGET',
  'HGETALL',
  'HKEYS',
  'HLEN',
  'HMGET',
  'LRANGE',
  'LLEN',
  'SMEMBERS',
  'SCARD',
  'SISMEMBER',
  'ZRANGE',
  'ZRANGEBYSCORE',
  'ZSCORE',
  'ZCARD',
  'ZCOUNT',
  'XLEN',
  'XRANGE',
  'XREVRANGE',
  'INFO',
  'DBSIZE',
  'KEYS',
  'SCAN',
  'HSCAN',
  'SSCAN',
  'ZSCAN',
  'MEMORY',
  'CONFIG',
  'CLIENT',
  'SLOWLOG',
  'COMMAND',
  'PING',
  'TIME',
]);

/**
 * Whitelist for `CONFIG` / `CLIENT` / `MEMORY` / `SLOWLOG` subcommands.
 * Each of these is technically allow-listed above by their head verb,
 * but the second token must be a known read sub-action.
 */
const REDIS_READ_ONLY_SUBCOMMANDS = new Map<string, Set<string>>([
  ['CONFIG', new Set(['GET'])],
  ['CLIENT', new Set(['LIST', 'GETNAME', 'ID', 'INFO'])],
  ['MEMORY', new Set(['USAGE', 'STATS', 'DOCTOR'])],
  ['SLOWLOG', new Set(['GET', 'LEN', 'HELP'])],
  ['OBJECT', new Set(['ENCODING', 'IDLETIME', 'FREQ', 'REFCOUNT'])],
]);

export function isReadOnlyRedisCommand(parts: readonly string[]): boolean {
  if (parts.length === 0) return false;
  const head = (parts[0] ?? '').toUpperCase();
  if (!REDIS_READ_ONLY.has(head)) return false;
  const subAllow = REDIS_READ_ONLY_SUBCOMMANDS.get(head);
  if (subAllow) {
    const sub = (parts[1] ?? '').toUpperCase();
    return subAllow.has(sub);
  }
  return true;
}

export async function startAiChat(
  win: BrowserWindow | null,
  req: AiChatRequest,
  apiKey: string,
  defaultModel: string,
): Promise<{ accepted: boolean; reason?: string }> {
  if (!apiKey || apiKey.trim().length === 0) {
    return { accepted: false, reason: 'no OpenRouter API key configured' };
  }
  if (!win || win.isDestroyed()) {
    return { accepted: false, reason: 'no renderer window' };
  }

  // Pre-cancel any prior request reusing the same id (rare, but the
  // renderer may submit on enter twice via key repeat).
  const existing = inflight.get(req.requestId);
  if (existing) existing.abort();

  const controller = new AbortController();
  inflight.set(req.requestId, controller);

  // Fire the SSE pump asynchronously — caller awaits the queueing only,
  // not the full completion.
  void pump(win, req, apiKey, defaultModel, controller);
  return { accepted: true };
}

export function cancelAiChat(requestId: string): void {
  const ctl = inflight.get(requestId);
  if (ctl) {
    ctl.abort();
    inflight.delete(requestId);
  }
}

async function pump(
  win: BrowserWindow,
  req: AiChatRequest,
  apiKey: string,
  defaultModel: string,
  controller: AbortController,
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
    | { role: 'system' | 'user'; content: string }
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
  const messages: InternalMsg[] = buildMessages(
    req.messages,
    engine,
    req.schema,
    req.engineContext,
  );
  const model = req.model?.trim() ? req.model : defaultModel;
  const tools = toolsForEngine(engine);

  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const isLastAllowedRound = round === MAX_TOOL_ROUNDS;
      // Stream the final round (when we want text streaming for UX).
      // For tool-call rounds we still stream so partial deltas appear
      // for any text the model emits before/after tool calls.
      const body = JSON.stringify({
        model,
        messages,
        stream: true,
        max_tokens: req.maxTokens,
        tools: toolExecutor && !isLastAllowedRound ? tools : undefined,
      });

      const res = await fetch(ENDPOINT, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': REFERER,
          'X-Title': TITLE,
        },
        body,
      });

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        send({
          kind: 'error',
          requestId: req.requestId,
          message: `OpenRouter HTTP ${res.status}: ${text || res.statusText}`,
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
            logger.warn('[plasma-ai] could not parse SSE chunk:', payload, err);
          }
        }
      }

      if (toolCalls.size === 0 || finishReason !== 'tool_calls' || !toolExecutor) {
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
        let parsedArgs: Record<string, unknown>;
        try {
          parsedArgs = JSON.parse(call.arguments || '{}');
        } catch {
          parsedArgs = {};
        }
        let result: string;
        try {
          result = await toolExecutor(call.name, parsedArgs);
        } catch (err) {
          result = JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          });
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
      // Cosmetic delta so the user sees something happened between rounds.
      send({
        kind: 'delta',
        requestId: req.requestId,
        text: assistantText.endsWith('\n') ? '' : '\n',
      });
    }

    // Hit MAX_TOOL_ROUNDS — finalize anyway.
    send({ kind: 'done', requestId: req.requestId });
  } catch (err) {
    if (controller.signal.aborted) return;
    const message = err instanceof Error ? err.message : String(err);
    send({ kind: 'error', requestId: req.requestId, message });
  } finally {
    inflight.delete(req.requestId);
  }
}

/**
 * Build the OpenRouter messages array. Prepends an engine-specific
 * system prompt + any optional context the renderer prepared (compact
 * Postgres DDL, Redis keyspace overview, OpenSearch cluster summary).
 */
function buildMessages(
  messages: AiMessage[],
  engine: ConnectionEngine,
  schema?: SchemaInfo | null,
  engineContext?: string,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const out: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];

  let systemContent: string | null = null;

  if (engine === 'postgres' && schema) {
    const ddl = compactSchema(schema);
    if (ddl) {
      systemContent = `You are Plasma's SQL assistant. The user is exploring a Postgres database. Use the schema below to write correct, concise SQL. When the user asks for a query, return JUST the SQL inside a \`\`\`sql code block — no prose around it unless they explicitly ask for an explanation. Prefer LIMIT clauses on exploratory queries. You may call the \`query_database\` tool to inspect actual data when an answer requires it (e.g. counts, samples, distinct values) — but never run mutations.\n\n--- SCHEMA ---\n${ddl}`;
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

  if (systemContent) {
    out.push({ role: 'system', content: systemContent });
  }

  for (const m of messages) out.push({ role: m.role, content: m.content });
  return out;
}

const MAX_TABLES = 80;
const MAX_COLS_PER_TABLE = 24;

function compactSchema(schema: SchemaInfo): string {
  const tables = schema.tables.slice(0, MAX_TABLES);
  const colByTable = new Map<string, SchemaInfo['columns']>();
  for (const c of schema.columns) {
    const key = `${c.schema}.${c.table}`;
    const arr = colByTable.get(key) ?? [];
    arr.push(c);
    colByTable.set(key, arr);
  }
  const fkByTable = new Map<string, string[]>();
  for (const fk of schema.foreignKeys) {
    const key = `${fk.schema}.${fk.table}`;
    const arr = fkByTable.get(key) ?? [];
    arr.push(`${fk.column} -> ${fk.refSchema}.${fk.refTable}.${fk.refColumn}`);
    fkByTable.set(key, arr);
  }
  const lines: string[] = [];
  for (const t of tables) {
    const key = `${t.schema}.${t.name}`;
    const cols = (colByTable.get(key) ?? [])
      .sort((a, b) => a.ordinal - b.ordinal)
      .slice(0, MAX_COLS_PER_TABLE);
    const colSig = cols
      .map(
        (c) =>
          `${c.name} ${c.dataType}${c.isPrimaryKey ? ' PK' : ''}${c.isNullable ? '' : ' NOT NULL'}`,
      )
      .join(', ');
    lines.push(`${key} (${colSig})`);
    const fks = fkByTable.get(key);
    if (fks && fks.length > 0) {
      lines.push(`  FK: ${fks.join('; ')}`);
    }
  }
  if (schema.tables.length > MAX_TABLES) {
    lines.push(`-- … ${schema.tables.length - MAX_TABLES} more tables omitted for brevity`);
  }
  const enums = schema.enums ?? [];
  for (const e of enums.slice(0, 40)) {
    lines.push(`ENUM ${e.schema}.${e.name} (${e.labels.join(' | ')})`);
  }
  if (enums.length > 40) {
    lines.push(`-- … ${enums.length - 40} more enums omitted`);
  }
  const functions = schema.functions ?? [];
  for (const f of functions.slice(0, 40)) {
    const args = f.identityArgs ? `(${f.identityArgs})` : '()';
    lines.push(`${f.kind.toUpperCase()} ${f.schema}.${f.name}${args} → ${f.returnType || 'void'}`);
  }
  if (functions.length > 40) {
    lines.push(`-- … ${functions.length - 40} more functions omitted`);
  }
  return lines.join('\n');
}

/**
 * Read-only check for tool-driven queries. Allow EXPLAIN / SELECT / SHOW
 * / WITH (CTE for SELECT) / VALUES. Reject anything else even when
 * embedded after a leading comment.
 */
export function isReadOnlySql(sql: string): boolean {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*--.*$/gm, '')
    .trim()
    .toLowerCase();
  return /^(select|explain|show|with|values|table)\b/.test(stripped);
}
