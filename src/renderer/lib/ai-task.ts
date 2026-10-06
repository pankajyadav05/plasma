/**
 * One-shot AI tasks over the existing `ai.chat` stream: send one prompt,
 * collect the streamed text, resolve with the whole answer. Used by
 * Fix with AI, Explain this plan and the natural-language grid filter.
 *
 * The key, the schema policy (`aiSendSchema`, prod opt-in) and the task
 * system prompts live in main; the renderer only narrows the schema to
 * what the prompt is about and never gets to widen what main allows.
 */
import { ipc } from '@/lib/ipc';
import { isAiSchemaAllowed } from '@shared/ai-schema-policy';
import { relevantSchema } from '@shared/ai-tasks';
import type { AiTask } from '@shared/ai-tasks';
import type { AiChatEvent, SchemaInfo } from '@shared/protocol';

interface Pending {
  text: string;
  resolve(text: string): void;
  reject(err: Error): void;
}

const pending = new Map<string, Pending>();
let counter = 0;

/** Feed a `plasma:ai:event`; true when it belonged to a task (so the chat panel skips it). */
export function routeAiTaskEvent(evt: AiChatEvent): boolean {
  const p = pending.get(evt.requestId);
  if (!p) return false;
  if (evt.kind === 'delta') {
    p.text += evt.text;
  } else if (evt.kind === 'done') {
    pending.delete(evt.requestId);
    p.resolve(p.text);
  } else if (evt.kind === 'error') {
    pending.delete(evt.requestId);
    p.reject(new Error(evt.message));
  }
  // `action` events belong to agent chats, never to one-shot tasks.
  return true;
}

export class AiAbortError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'AiAbortError';
  }
}

/** May schema names go to the provider for the active connection (same rule main enforces)? */
export function aiSchemaAllowed(state: {
  activeConfig?: { id: string } | null;
  settings: Parameters<typeof isAiSchemaAllowed>[1];
}): boolean {
  return isAiSchemaAllowed(state.activeConfig?.id, state.settings);
}

/** Narrow `schema` for a task, or null when schema sharing is not allowed. */
export function schemaForTask(
  schema: SchemaInfo | null | undefined,
  allowed: boolean,
  text: string,
): SchemaInfo | null {
  if (!schema || !allowed) return null;
  return relevantSchema(schema, text);
}

export async function runAiTask(opts: {
  task: AiTask;
  prompt: string;
  schema?: SchemaInfo | null;
  signal?: AbortSignal;
}): Promise<string> {
  const requestId = `ai-task-${Date.now().toString(36)}-${counter++}`;
  if (opts.signal?.aborted) throw new AiAbortError();
  const done = new Promise<string>((resolve, reject) => {
    pending.set(requestId, { text: '', resolve, reject });
  });
  const cancel = () => {
    const p = pending.get(requestId);
    if (!p) return;
    pending.delete(requestId);
    void ipc.ai.cancel(requestId).catch(() => undefined);
    p.reject(new AiAbortError());
  };
  opts.signal?.addEventListener('abort', cancel, { once: true });
  try {
    const res = await ipc.ai.chat({
      requestId,
      task: opts.task,
      messages: [{ role: 'user', content: opts.prompt }],
      engine: 'postgres',
      schema: opts.schema ?? null,
    });
    if (!res.accepted) {
      const p = pending.get(requestId);
      pending.delete(requestId);
      p?.reject(
        new Error(
          'The assistant request was rejected. Check Settings, AI: an OpenRouter key, or a local model and its URL.',
        ),
      );
    }
    return await done;
  } catch (err) {
    pending.delete(requestId);
    throw err;
  } finally {
    opts.signal?.removeEventListener('abort', cancel);
  }
}
