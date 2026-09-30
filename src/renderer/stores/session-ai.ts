/** AI assistant slice (bring-your-own-key chat streamed from main). */
import { ipc } from '@/lib/ipc';
import type { AiMessage } from '@shared/protocol';
import { freshId } from './session-tab-model';
import type { AiTurn, SessionState, SliceCreator } from './session-types';

export interface AiSlice {
  // ── AI chat (OpenRouter sidecar) ──
  aiChat: AiTurn[];
  aiPending: boolean;
  /** Active streaming request id, used to route deltas + cancel. */
  aiRequestId: string | null;
  /** Connection the current `aiChat` belongs to (G3: chat is per connection). */
  aiChatConnectionId: string | null;
  aiAsk(prompt: string, opts?: { withSchema?: boolean }): Promise<void>;
  aiCancel(): Promise<void>;
  aiClear(): void;
  /** Apply a streamed delta event from the main process. */
  aiApplyEvent(
    evt:
      | { kind: 'delta'; requestId: string; text: string }
      | { kind: 'done'; requestId: string }
      | { kind: 'error'; requestId: string; message: string },
  ): void;
}

export const createAiSlice: SliceCreator<AiSlice> = (set, get) => ({
  aiChat: [],
  aiPending: false,
  aiRequestId: null,
  aiChatConnectionId: null,

  async aiAsk(prompt, opts) {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    const state = get();
    if (state.aiPending) return; // single-flight per chat
    // G3: a different connection starts a fresh conversation.
    const connectionId = state.activeConfig?.id ?? null;
    const history = state.aiChatConnectionId === connectionId ? state.aiChat : [];

    const userTurn: AiTurn = {
      id: freshId(),
      role: 'user',
      content: trimmed,
    };
    const placeholder: AiTurn = {
      id: freshId(),
      role: 'assistant',
      content: '',
      streaming: true,
    };
    const requestId = freshId();
    set({
      aiChat: [...history, userTurn, placeholder],
      aiChatConnectionId: connectionId,
      aiPending: true,
      aiRequestId: requestId,
      rightPanelMode: 'ai',
    });

    // Strip Plasma-only fields before sending — main only needs role +
    // content per OpenAI/OpenRouter chat shape.
    const messages: AiMessage[] = [...history, userTurn].map((t) => ({
      role: t.role,
      content: t.content,
    }));

    const engine = state.activeConfig?.engine ?? 'postgres';
    const engineContext = buildEngineContext(state);

    try {
      const res = await ipc.ai.chat({
        requestId,
        messages,
        engine,
        engineContext,
        schema:
          engine === 'postgres'
            ? opts?.withSchema === false
              ? null
              : (state.schema ?? null)
            : null,
        model: state.settings.openrouterModel || undefined,
      });
      if (!res.accepted) {
        set((s) => ({
          aiChat: s.aiChat.map((t) =>
            t.id === placeholder.id ? { ...t, streaming: false, error: 'request rejected' } : t,
          ),
          aiPending: false,
          aiRequestId: null,
        }));
      }
    } catch (err) {
      set((s) => ({
        aiChat: s.aiChat.map((t) =>
          t.id === placeholder.id
            ? {
                ...t,
                streaming: false,
                error: err instanceof Error ? err.message : String(err),
              }
            : t,
        ),
        aiPending: false,
        aiRequestId: null,
      }));
    }
  },

  async aiCancel() {
    const id = get().aiRequestId;
    if (!id) return;
    try {
      await ipc.ai.cancel(id);
    } finally {
      set((s) => ({
        aiPending: false,
        aiRequestId: null,
        aiChat: s.aiChat.map((t) => (t.streaming ? { ...t, streaming: false } : t)),
      }));
    }
  },

  aiClear() {
    void get().aiCancel();
    set({ aiChat: [] });
  },

  aiApplyEvent(evt) {
    const state = get();
    if (state.aiRequestId !== evt.requestId) return; // stale stream
    if (evt.kind === 'delta') {
      // Append delta to the last assistant turn (streaming placeholder).
      const idx = [...state.aiChat]
        .reverse()
        .findIndex((t) => t.streaming && t.role === 'assistant');
      if (idx === -1) return;
      const realIdx = state.aiChat.length - 1 - idx;
      set({
        aiChat: state.aiChat.map((t, i) =>
          i === realIdx ? { ...t, content: t.content + evt.text } : t,
        ),
      });
      return;
    }
    if (evt.kind === 'done') {
      set({
        aiPending: false,
        aiRequestId: null,
        aiChat: state.aiChat.map((t) => (t.streaming ? { ...t, streaming: false } : t)),
      });
      return;
    }
    if (evt.kind === 'error') {
      set({
        aiPending: false,
        aiRequestId: null,
        aiChat: state.aiChat.map((t) =>
          t.streaming ? { ...t, streaming: false, error: evt.message } : t,
        ),
      });
    }
  },
});

/**
 * Compose a short, engine-specific context blob for the AI system
 * prompt. Keeps the renderer in charge of what's worth surfacing —
 * main just forwards the string. Returns undefined when there's
 * nothing useful to send (postgres uses the schema field instead).
 */
export function buildEngineContext(state: SessionState): string | undefined {
  const cfg = state.activeConfig;
  if (!cfg) return undefined;
  const engine = cfg.engine ?? 'postgres';

  if (engine === 'redis' && state.redisOverview) {
    const o = state.redisOverview;
    const lines: string[] = [`version: ${o.redisVersion}`, `role: ${o.role}`, `mode: ${o.mode}`];
    const total = o.keyspace.reduce((acc, k) => acc + k.keys, 0);
    if (total > 0) lines.push(`total keys: ${total.toLocaleString()}`);
    for (const k of o.keyspace.slice(0, 4)) {
      lines.push(
        `db${k.db}: ${k.keys.toLocaleString()} keys (${k.expires.toLocaleString()} with TTL)`,
      );
    }
    if (state.redisKeys && state.redisKeys.keys.length > 0) {
      const sample = state.redisKeys.keys
        .slice(0, 12)
        .map((k) => `  ${k.key} (${k.type})`)
        .join('\n');
      lines.push('sample keys:', sample);
    }
    return lines.join('\n');
  }

  if (engine === 'opensearch' && state.osOverview) {
    const o = state.osOverview;
    const lines: string[] = [
      `cluster: ${o.clusterName}`,
      `${o.distribution} v${o.version}`,
      `health: ${o.health}`,
      `${o.nodes} node(s) · ${o.indices.length} indices`,
    ];
    if (o.indices.length > 0) {
      lines.push('top indices:');
      for (const idx of [...o.indices].sort((a, b) => b.docsCount - a.docsCount).slice(0, 12)) {
        lines.push(`  ${idx.index} — ${idx.docsCount.toLocaleString()} docs, ${idx.health}`);
      }
    }
    return lines.join('\n');
  }

  return undefined;
}
