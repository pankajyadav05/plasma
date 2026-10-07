import { buildAgentContext } from '@/lib/ai-context';
/** AI assistant slice (bring-your-own-key chat streamed from main). */
import type { AiImage } from '@/lib/ai-images';
import { ipc } from '@/lib/ipc';
import { actionHistoryLine } from '@shared/agent-actions';
import { AI_MAX_IMAGES_PER_MESSAGE, type AiContent, capHistoryImages } from '@shared/ai-images';
import type { AiChatEvent, AiMessage } from '@shared/protocol';
import { isSqlEngine } from '@shared/sql-dialect';
import { createAgentActions } from './session-ai-actions';
import { freshId } from './session-tab-model';
import type { AgentAction, AiPart, AiTurn, SessionState, SliceCreator } from './session-types';

/**
 * A turn as the model sees it in later requests: its text, and one line per
 * action card with how it ended (`[show_table public.orders: applied]`).
 */
export function turnHistoryContent(turn: AiTurn, actions: Record<string, AgentAction>): string {
  if (turn.role !== 'assistant' || !turn.parts) return turn.content;
  const lines: string[] = [];
  for (const p of turn.parts) {
    if (p.kind === 'text') {
      if (p.text.trim()) lines.push(p.text.trim());
      continue;
    }
    const a = actions[p.actionId];
    if (a)
      lines.push(
        actionHistoryLine(a.action, a.status, a.status === 'rejected' ? a.note : undefined),
      );
  }
  return lines.join('\n');
}

/** The wire content of a turn: its history text, with its images first when it has any. */
export function turnWireContent(turn: AiTurn, actions: Record<string, AgentAction>): AiContent {
  const text = turnHistoryContent(turn, actions);
  const images = turn.images ?? [];
  if (turn.role !== 'user' || images.length === 0) return text;
  return [
    ...images.map((i) => ({ type: 'image_url' as const, image_url: { url: i.dataUrl } })),
    ...(text.trim() ? [{ type: 'text' as const, text }] : []),
  ];
}

/** Append streamed text to the turn's last text part (a new part after a card). */
export function appendTurnText(parts: AiPart[] | undefined, text: string): AiPart[] {
  const list = parts ?? [];
  const last = list[list.length - 1];
  if (last && last.kind === 'text') {
    return [...list.slice(0, -1), { kind: 'text', text: last.text + text }];
  }
  const fresh = text.replace(/^\s+/, '');
  return fresh ? [...list, { kind: 'text', text: fresh }] : list;
}

export interface AiSlice {
  // ── AI chat (OpenRouter sidecar) ──
  aiChat: AiTurn[];
  aiPending: boolean;
  /** Active streaming request id, used to route deltas + cancel. */
  aiRequestId: string | null;
  /** Connection the current `aiChat` belongs to (G3: chat is per connection). */
  aiChatConnectionId: string | null;
  /** The agent's action cards, by id (turns reference them through `parts`). */
  aiActions: Record<string, AgentAction>;
  /**
   * Send a message (text, images or both). Resolves true once the request was
   * accepted, false when it was not sent or failed to start: the caller then
   * keeps the draft.
   */
  aiAsk(prompt: string, opts?: { withSchema?: boolean; images?: AiImage[] }): Promise<boolean>;
  aiCancel(): Promise<void>;
  aiClear(): void;
  /** Apply a streamed delta event from the main process. */
  aiApplyEvent(evt: AiChatEvent): void;
  /** Approve a pending card: the action runs now, through the normal paths. */
  aiApproveAction(id: string): Promise<void>;
  /** Reject a pending card; the optional note goes back to the model. */
  aiRejectAction(id: string, note?: string): void;
  /** Undo an applied view change. */
  aiUndoAction(id: string): Promise<void>;
  /** remember: the user edited the note text on a pending card. */
  aiEditMemoryAction(id: string, text: string): void;
}

export const createAiSlice: SliceCreator<AiSlice> = (set, get, api) => {
  const actions = createAgentActions(api);

  // The connection a card was proposed for is gone: nothing may run on a new one.
  api.subscribe((state, prev) => {
    if (
      prev.connectionGen === state.connectionGen &&
      prev.connectionState === state.connectionState &&
      prev.activeConfig?.id === state.activeConfig?.id
    ) {
      return;
    }
    if (Object.keys(state.aiActions).length > 0) {
      actions.cancelAll('The connection changed.');
    }
  });

  return {
    aiChat: [],
    aiPending: false,
    aiRequestId: null,
    aiChatConnectionId: null,
    aiActions: {},

    async aiAsk(prompt, opts) {
      const trimmed = prompt.trim();
      const images = (opts?.images ?? []).slice(0, AI_MAX_IMAGES_PER_MESSAGE);
      if (!trimmed && images.length === 0) return false;
      const state = get();
      if (state.aiPending) return false; // single-flight per chat
      // G3: a different connection starts a fresh conversation.
      const connectionId = state.activeConfig?.id ?? null;
      const sameChat = state.aiChatConnectionId === connectionId;
      const history = sameChat ? state.aiChat : [];
      const modelHistory = history.filter((t) => !t.external);

      const userTurn: AiTurn = {
        id: freshId(),
        role: 'user',
        content: trimmed,
        ...(images.length > 0 ? { images } : {}),
      };
      const placeholder: AiTurn = {
        id: freshId(),
        role: 'assistant',
        content: '',
        streaming: true,
        parts: [],
      };
      const requestId = freshId();
      set({
        aiChat: [...history, userTurn, placeholder],
        aiActions: sameChat ? state.aiActions : {},
        aiChatConnectionId: connectionId,
        aiPending: true,
        aiRequestId: requestId,
        rightPanelMode: 'ai',
      });

      // Strip Plasma-only fields before sending — main only needs role +
      // content per OpenAI/OpenRouter chat shape. An assistant turn carries
      // one line per action card so the model knows how each one ended.
      const messages: AiMessage[] = capHistoryImages(
        [...modelHistory, userTurn].map((t) => ({
          role: t.role,
          content: turnWireContent(t, state.aiActions),
        })),
      );

      const engine = state.activeConfig?.engine ?? 'postgres';
      const sql = isSqlEngine(engine);
      const engineContext = buildEngineContext(state);
      const rowData = connectionId
        ? state.settings.connectionAiRowData?.[connectionId] === true
        : false;
      const context = sql ? buildAgentContext(state, { rowData }) : undefined;

      try {
        const res = await ipc.ai.chat({
          requestId,
          messages,
          engine,
          engineContext,
          // Main sends the schema only when the policy allows it (SC-20).
          schema: sql ? (opts?.withSchema === false ? null : (state.schema ?? null)) : null,
          model: state.settings.openrouterModel || undefined,
          ...(sql ? { agent: true } : {}),
          ...(context ? { context } : {}),
        });
        if (!res.accepted) {
          set((s) => ({
            aiChat: s.aiChat.map((t) =>
              t.id === placeholder.id ? { ...t, streaming: false, error: 'request rejected' } : t,
            ),
            aiPending: false,
            aiRequestId: null,
          }));
          return false;
        }
        return true;
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
        return false;
      }
    },

    async aiCancel() {
      const id = get().aiRequestId;
      if (!id) return;
      // Cards stop first (main resolves its side of them when it cancels the request).
      actions.cancelAll('The chat was stopped.', { send: false });
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
      actions.cancelAll('The conversation was cleared.', { send: false });
      set({ aiChat: [], aiActions: {} });
    },

    aiApplyEvent(evt) {
      const state = get();
      if (evt.kind === 'external') {
        // An MCP client proposes a change: open a labelled thread bound to its connection.
        const same = state.aiChatConnectionId === evt.connectionId;
        const label: AiTurn = {
          id: freshId(),
          role: 'user',
          content: `${evt.client} wants to change data`,
          external: { client: evt.client },
        };
        const placeholder: AiTurn = {
          id: freshId(),
          role: 'assistant',
          content: '',
          streaming: true,
          parts: [],
          external: { client: evt.client },
        };
        set({
          aiChat: [...(same ? state.aiChat : []), label, placeholder],
          aiActions: same ? state.aiActions : {},
          aiChatConnectionId: evt.connectionId,
          aiPending: true,
          aiRequestId: evt.requestId,
          rightPanelMode: 'ai',
        });
        return;
      }
      if (state.aiRequestId !== evt.requestId) return; // stale stream
      if (evt.kind === 'action') {
        void actions.handleActionEvent(evt);
        return;
      }
      if (evt.kind === 'delta') {
        // Append delta to the last assistant turn (streaming placeholder).
        const idx = [...state.aiChat]
          .reverse()
          .findIndex((t) => t.streaming && t.role === 'assistant');
        if (idx === -1) return;
        const realIdx = state.aiChat.length - 1 - idx;
        set({
          aiChat: state.aiChat.map((t, i) =>
            i === realIdx
              ? { ...t, content: t.content + evt.text, parts: appendTurnText(t.parts, evt.text) }
              : t,
          ),
        });
        return;
      }
      // done / error: nothing may still wait on the user.
      actions.cancelAll(
        evt.kind === 'error' ? 'The assistant stopped with an error.' : 'The chat ended.',
        { send: false },
      );
      if (evt.kind === 'done') {
        set({
          aiPending: false,
          aiRequestId: null,
          aiChat: get().aiChat.map((t) => (t.streaming ? { ...t, streaming: false } : t)),
        });
        return;
      }
      set({
        aiPending: false,
        aiRequestId: null,
        aiChat: get().aiChat.map((t) =>
          t.streaming ? { ...t, streaming: false, error: evt.message } : t,
        ),
      });
    },

    aiApproveAction: (id) => actions.approve(id),
    aiRejectAction: (id, note) => actions.reject(id, note),
    aiUndoAction: (id) => actions.undo(id),
    aiEditMemoryAction: (id, text) => actions.editMemory(id, text),
  };
};

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
