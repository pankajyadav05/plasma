import { IconButton, Pill } from '@/components/ui/workbench';
import { markAiApplied } from '@/lib/ai-applied';
import { aiConfigured, describeAiSends } from '@/lib/ai-config';
import { buildAgentContext } from '@/lib/ai-context';
import type { AiImage } from '@/lib/ai-images';
import { aiSchemaAllowed } from '@/lib/ai-task';
import { cn } from '@/lib/cn';
import { useMemory } from '@/stores/ai-memory';
import { type AiTurn, useActiveTab, useSession } from '@/stores/session';
import { formatMemoryForPrompt, isMemoryEnabled } from '@shared/ai-memory';
import { isSqlEngine } from '@shared/sql-dialect';
import { BookMarked, Loader2, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AgentActionCard } from './AgentActionCard';
import { AiComposer } from './AiComposer';
import { ImageGrid } from './AiImages';

/**
 * AI sidecar panel. Lives in the RightRail under the 'ai' mode.
 *
 * Wires the OpenRouter chat stream from the store. For the first turn
 * we send the introspected schema as a system prompt so the model can
 * write queries against real table + column names; subsequent turns
 * just continue the conversation — main re-prepends the schema each
 * call so the model never loses it (~free with prompt caching upstream).
 *
 * Code blocks in assistant replies surface "Insert into editor" and
 * "Run" buttons on hover so the user never has to copy-paste.
 */
export function AiPanel() {
  // G3: the conversation belongs to the connection it was started on —
  // switching connections shows a fresh chat instead of leaking context.
  const aiChat = useSession((s) =>
    s.aiChatConnectionId === (s.activeConfig?.id ?? null) ? s.aiChat : EMPTY_CHAT,
  );
  const aiPending = useSession((s) => s.aiPending);
  const aiAsk = useSession((s) => s.aiAsk);
  const aiCancel = useSession((s) => s.aiCancel);
  const aiClear = useSession((s) => s.aiClear);
  const setSql = useSession((s) => s.setSql);
  const runQuery = useSession((s) => s.runQuery);
  const addTab = useSession((s) => s.addTab);
  const setCanvasMode = useSession((s) => s.setCanvasMode);
  const settings = useSession((s) => s.settings);
  const hasApiKey = aiConfigured(settings);
  const local = settings.aiProvider === 'local';
  const sqlEngine = useSession((s) => isSqlEngine(s.activeConfig?.engine ?? 'postgres'));
  const schemaAllowed = useSession((s) => aiSchemaAllowed(s));
  const tableCount = useSession((s) => s.schema?.tables.length ?? 0);
  const hasContext = useSession((s) => buildAgentContext(s) !== undefined);
  const allowAiRowData = useSession((s) => {
    const id = s.activeConfig?.id;
    if (!id) return false;
    return s.settings.connectionAiRowData?.[id] === true;
  });
  const connectionId = useSession((s) => s.activeConfig?.id ?? null);
  const saved = useSession((s) =>
    s.activeConfig ? s.savedConnections.some((c) => c.id === s.activeConfig?.id) : false,
  );
  const memoryOn = useSession((s) => isMemoryEnabled(s.activeConfig?.id, s.settings));
  const memoryNotes = useMemory((s) => (connectionId ? s.notes[connectionId] : undefined));
  const loadMemory = useMemory((s) => s.load);
  const openMemory = useMemory((s) => s.open);
  useEffect(() => {
    if (connectionId && saved) void loadMemory(connectionId);
  }, [connectionId, saved, loadMemory]);
  const memorySent = useMemo(
    () => (memoryOn && memoryNotes ? formatMemoryForPrompt(memoryNotes).included : 0),
    [memoryOn, memoryNotes],
  );
  const [draft, setDraft] = useState('');
  const [images, setImages] = useState<AiImage[]>([]);
  const sends = describeAiSends({
    settings,
    sql: sqlEngine,
    schemaAllowed,
    tableCount,
    hasContext,
    rowData: allowAiRowData,
    images: images.length,
    memory: memorySent,
  });
  const tab = useActiveTab();
  const connectionName = useSession((s) => s.activeConfig?.name ?? 'Not connected');
  const trayContext =
    tab?.kind === 'table' && tab.tableName
      ? `${connectionName} · ${tab.tableSchema}.${tab.tableName}`
      : tab?.kind === 'sql'
        ? `${connectionName} · ${tab.title}`
        : connectionName;

  const scrollerRef = useRef<HTMLDivElement>(null);

  // Autoscroll on new content while streaming. The full chat array is a
  // legit dep — biome's exhaustive-deps wants chat.length, but we want
  // to fire even when content is mutated in place during a stream.
  // biome-ignore lint/correctness/useExhaustiveDependencies: stream mutations don't change identity
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [aiChat, aiChat.length]);

  const submit = () => {
    if ((!draft.trim() && images.length === 0) || aiPending) return;
    const text = draft;
    const sent = images;
    setDraft('');
    setImages([]);
    // A send that does not start puts the draft back (unless the user already typed anew).
    void aiAsk(text, { images: sent }).then((ok) => {
      if (ok) return;
      setDraft((d) => (d.trim() ? d : text));
      setImages((cur) => (cur.length > 0 ? cur : sent));
    });
  };

  // E5: never overwrite the user's work — reuse the active tab only when
  // it is an empty SQL tab, otherwise open a new one. addTab/setSql are
  // synchronous store updates, so the run below sees the new text.
  const handleInsert = (code: string) => {
    if (!tab) return;
    if (tab.kind === 'table' || tab.sql.trim().length > 0) addTab();
    setSql(code);
    markAiApplied(useSession.getState().activeTabId, code);
  };

  // Runs every statement in the block (buffer mode), still through the
  // normal run path so read-only and the prod-tag confirmation apply.
  const handleRun = (code: string) => {
    if (!tab) return;
    handleInsert(code);
    void runQuery({ all: true });
  };

  const empty = aiChat.length === 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[color-mix(in_srgb,var(--wb-text)_8%,transparent)] pl-3 pr-2">
        <Sparkles className="h-3.5 w-3.5 text-[var(--wb-text-2)]" />
        <span className="truncate text-[12px] text-[var(--wb-text-2)]">Assistant</span>
        <div className="flex-1" />
        {connectionId && saved && (
          <button
            type="button"
            data-testid="ai-memory-button"
            aria-label={`Memory: ${memoryNotes?.length ?? 0} ${memoryNotes?.length === 1 ? 'note' : 'notes'}${memoryOn ? '' : ', off'}. Open`}
            title="What the assistant remembers about this database"
            onClick={() => openMemory({ id: connectionId, name: connectionName })}
            className={cn(
              'inline-flex h-6 cursor-pointer items-center gap-1 rounded-[6px] px-1.5 text-[12px] text-[var(--wb-text-2)] transition-colors',
              'hover:bg-[var(--wb-control-hover)] hover:text-[var(--wb-text)]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              !memoryOn && 'opacity-60',
            )}
          >
            <BookMarked className="h-3.5 w-3.5" aria-hidden />
            <span className="tabular-nums">{memoryNotes?.length ?? 0}</span>
          </button>
        )}
        {aiChat.length > 0 && (
          <IconButton variant="plain" label="Clear conversation" onClick={aiClear}>
            <Trash2 />
          </IconButton>
        )}
      </div>

      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {empty && (
          <EmptyState
            hasKey={hasApiKey}
            local={local}
            agent={sqlEngine}
            onOpenSettings={() => setCanvasMode('settings')}
          />
        )}
        {aiChat.map((turn) => (
          <ChatTurn key={turn.id} turn={turn} onInsert={handleInsert} onRun={handleRun} />
        ))}
      </div>

      <AiComposer
        draft={draft}
        onDraft={setDraft}
        onSubmit={submit}
        onStop={() => void aiCancel()}
        pending={aiPending}
        enabled={hasApiKey}
        agent={sqlEngine}
        sends={sends}
        context={trayContext}
        images={images}
        onImages={setImages}
        placeholder={
          !hasApiKey
            ? local
              ? 'Choose a local model in Settings to enable AI'
              : 'Add an OpenRouter API key in Settings to enable AI'
            : sqlEngine
              ? 'Ask anything, or tell the agent what to do: show the latest 10 orders…'
              : 'Ask for a query, paste an error, or describe what you want to find…'
        }
      />
    </div>
  );
}

function EmptyState({
  hasKey,
  local,
  agent,
  onOpenSettings,
}: {
  hasKey: boolean;
  local: boolean;
  agent: boolean;
  onOpenSettings: () => void;
}) {
  if (!hasKey) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
        <Sparkles className="h-6 w-6 text-[var(--wb-text-3)]" />
        <div className="text-[16px] text-[var(--wb-text-2)]">
          {local ? 'No local model' : 'No API key'}
        </div>
        <div className="text-[12px] text-[var(--wb-text-3)]">
          {local
            ? 'Name the model your local server runs (Ollama or LM Studio) in Settings → AI. Everything stays on this machine.'
            : 'The assistant uses your own OpenRouter key (it reaches Claude, GPT, Gemini and other models), or a model on this machine. Set it up in Settings → AI.'}
        </div>
        <Pill className="mt-1" onClick={onOpenSettings} data-testid="ai-open-settings">
          Open Settings
        </Pill>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
      <Sparkles className="h-6 w-6 text-[var(--wb-text-3)]" />
      <div className="text-[16px] text-[var(--wb-text-2)]">Ask anything about this database.</div>
      <div className="text-[12px] text-[var(--wb-text-3)]">
        {agent
          ? 'Try: "show the latest 10 orders, only id, total, created_at", "top 5 customers by revenue last 30 days", or "why might my query be slow on the orders table?" The agent asks before it opens, runs or changes anything.'
          : 'Try: "top 5 customers by revenue last 30 days" or "why might my query be slow on the orders table?"'}
      </div>
    </div>
  );
}

function ChatTurn({
  turn,
  onInsert,
  onRun,
}: {
  turn: AiTurn;
  onInsert: (code: string) => void;
  onRun: (code: string) => void;
}) {
  const isUser = turn.role === 'user';
  const hasCards = Boolean(turn.parts?.some((p) => p.kind === 'action'));
  // A card waiting on the user is not "thinking".
  const waitingOnUser = useSession((s) =>
    Boolean(
      turn.parts?.some((p) => {
        if (p.kind !== 'action') return false;
        const st = s.aiActions[p.actionId]?.status;
        return st === 'pending' || st === 'running';
      }),
    ),
  );
  const parts = turn.parts ?? [{ kind: 'text' as const, text: turn.content }];
  return (
    <div className={cn('mb-4 flex flex-col gap-1', isUser ? 'items-end' : 'items-start')}>
      <div
        className={cn(
          'rounded-[8px] px-3 py-2 text-[13px] text-[var(--wb-text)]',
          hasCards ? 'w-[96%]' : 'max-w-[92%]',
          isUser
            ? 'bg-[var(--wb-selected)]'
            : 'bg-[var(--wb-control)]/60 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--wb-text)_6%,transparent)]',
        )}
      >
        {isUser ? (
          <>
            {turn.images && turn.images.length > 0 && <ImageGrid images={turn.images} />}
            {turn.content && (
              <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{turn.content}</span>
            )}
          </>
        ) : (
          <div className="flex flex-col gap-2">
            {parts.map((p, i) =>
              p.kind === 'action' ? (
                <AgentActionCard key={p.actionId} actionId={p.actionId} />
              ) : p.text.trim() === '' ? null : (
                <AssistantContent
                  // biome-ignore lint/suspicious/noArrayIndexKey: part order is stable
                  key={i}
                  content={p.text.replace(/^\s+/, '')}
                  onInsert={onInsert}
                  onRun={onRun}
                />
              ),
            )}
            {turn.streaming && !waitingOnUser && <StreamingDot />}
          </div>
        )}
        {turn.error && (
          <div className="mt-2 rounded-sm border border-destructive/40 bg-destructive/10 px-2 py-1 font-mono text-[11px] text-destructive">
            {turn.error}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Parses out fenced code blocks from streamed assistant text and renders
 * them with action buttons. Everything outside fences is rendered as
 * plain (whitespace-preserving) prose. We deliberately don't run a full
 * markdown parser — the model is instructed to keep replies short and
 * code-block-centric, and a partial markdown render mid-stream looks
 * worse than plain text + code blocks.
 */
function AssistantContent({
  content,
  onInsert,
  onRun,
}: {
  content: string;
  onInsert: (code: string) => void;
  onRun: (code: string) => void;
}) {
  const parts = parseFences(content);
  return (
    <div className="flex flex-col gap-2">
      {parts.map((p, i) =>
        p.kind === 'code' ? (
          <CodeBlock
            // biome-ignore lint/suspicious/noArrayIndexKey: chunk order is stable
            key={i}
            lang={p.lang}
            code={p.code}
            onInsert={() => onInsert(p.code)}
            onRun={() => onRun(p.code)}
          />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: chunk order is stable
          <p key={i} className="whitespace-pre-wrap leading-relaxed [overflow-wrap:anywhere]">
            {p.text}
          </p>
        ),
      )}
    </div>
  );
}

function StreamingDot() {
  return (
    <span className="inline-flex items-center gap-1 text-[var(--wb-text-2)]">
      <Loader2 className="h-3 w-3 animate-spin" />
      <span className="text-[11px]">thinking…</span>
    </span>
  );
}

function CodeBlock({
  lang,
  code,
  onInsert,
  onRun,
}: {
  lang: string;
  code: string;
  onInsert: () => void;
  onRun: () => void;
}) {
  const isSql = !lang || /^sql$|^postgres/i.test(lang);
  return (
    <div className="overflow-hidden rounded-[6px] bg-[var(--wb-content)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--wb-text)_8%,transparent)]">
      <div className="flex h-7 items-center gap-1 border-b border-[color-mix(in_srgb,var(--wb-text)_8%,transparent)] pl-2 pr-1 font-mono text-[11px] text-[var(--wb-text-3)]">
        <span>{lang || 'sql'}</span>
        <div className="flex-1" />
        {isSql && (
          <>
            <Pill className="h-5 px-1.5 text-[11px]" onClick={onInsert}>
              Insert
            </Pill>
            <Pill className="h-5 px-1.5 text-[11px]" onClick={onRun}>
              Run
            </Pill>
          </>
        )}
      </div>
      <pre className="overflow-x-auto p-2 font-mono text-[12px] leading-relaxed text-[var(--wb-text)]">
        {code}
      </pre>
    </div>
  );
}

interface Part {
  kind: 'text' | 'code';
  text: string;
  lang: string;
  code: string;
}

function parseFences(input: string): Part[] {
  const out: Part[] = [];
  // Capture: ``` then optional lang, newline, body, ``` (closing fence
  // is optional so we render code blocks while they're still streaming).
  const re = /```(\w+)?\s*\n([\s\S]*?)(?:```|$)/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null = re.exec(input);
  while (m !== null) {
    if (m.index > lastIndex) {
      out.push({
        kind: 'text',
        text: input.slice(lastIndex, m.index),
        lang: '',
        code: '',
      });
    }
    out.push({
      kind: 'code',
      text: '',
      lang: m[1] ?? '',
      code: m[2] ?? '',
    });
    lastIndex = m.index + m[0].length;
    m = re.exec(input);
  }
  if (lastIndex < input.length) {
    out.push({ kind: 'text', text: input.slice(lastIndex), lang: '', code: '' });
  }
  return out.length > 0 ? out : [{ kind: 'text', text: input, lang: '', code: '' }];
}

const EMPTY_CHAT: AiTurn[] = [];
