import { Button } from '@/components/ui/button';
import { IconButton, Pill } from '@/components/ui/workbench';
import { cn } from '@/lib/cn';
import { type AiTurn, useActiveTab, useSession } from '@/stores/session';
import { Loader2, Send, Sparkles, Square, Trash2 } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';

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
  const hasApiKey = useSession((s) =>
    Boolean(s.settings.hasOpenrouterApiKey || s.settings.hasClaudeApiKey),
  );
  const model = useSession((s) => s.settings.openrouterModel);
  const allowAiRowData = useSession((s) => {
    const id = s.activeConfig?.id;
    if (!id) return false;
    return s.settings.connectionAiRowData?.[id] === true;
  });
  const tab = useActiveTab();

  const [draft, setDraft] = useState('');
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

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const submit = () => {
    if (!draft.trim() || aiPending) return;
    void aiAsk(draft);
    setDraft('');
  };

  // E5: never overwrite the user's work — reuse the active tab only when
  // it is an empty SQL tab, otherwise open a new one. addTab/setSql are
  // synchronous store updates, so the run below sees the new text.
  const handleInsert = (code: string) => {
    if (!tab) return;
    if (tab.kind === 'table' || tab.sql.trim().length > 0) addTab();
    setSql(code);
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
        <span
          className="truncate text-[12px] text-[var(--wb-text-2)]"
          title={`${model} via OpenRouter (your API key)`}
        >
          {modelLabel(model)}
        </span>
        <div className="flex-1" />
        {aiChat.length > 0 && (
          <IconButton variant="plain" label="Clear conversation" onClick={aiClear}>
            <Trash2 />
          </IconButton>
        )}
      </div>

      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {empty && (
          <EmptyState hasKey={hasApiKey} onOpenSettings={() => setCanvasMode('settings')} />
        )}
        {aiChat.map((turn) => (
          <ChatTurn key={turn.id} turn={turn} onInsert={handleInsert} onRun={handleRun} />
        ))}
      </div>

      <div className="shrink-0 border-t border-[color-mix(in_srgb,var(--wb-text)_8%,transparent)] p-2.5">
        <div className="relative">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            placeholder={
              hasApiKey
                ? 'Ask for a query, paste an error, or describe what you want to find…'
                : 'Add an OpenRouter API key in Settings to enable AI'
            }
            disabled={!hasApiKey}
            rows={3}
            className="w-full resize-none rounded-[7px] border-0 bg-[var(--wb-field)] px-2.5 py-1.5 pr-9 text-[13px] text-[var(--wb-text)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--wb-text)_8%,transparent)] outline-none transition-shadow placeholder:text-[var(--wb-text-3)] focus:shadow-[0_0_0_2px_color-mix(in_srgb,var(--wb-accent)_55%,transparent)] disabled:cursor-not-allowed disabled:opacity-60"
          />
          {aiPending ? (
            <Button
              variant="destructive"
              size="icon-xs"
              onClick={() => void aiCancel()}
              className="absolute bottom-2 right-1.5 h-6 w-6 rounded-[6px]"
              title="Stop"
              aria-label="Stop"
            >
              <Square className="fill-current" />
            </Button>
          ) : (
            <IconButton
              label="Send"
              title="Send (Enter)"
              onClick={submit}
              disabled={!draft.trim() || !hasApiKey}
              className="absolute bottom-2 right-1.5"
            >
              <Send />
            </IconButton>
          )}
        </div>
        <p className="mt-1.5 px-1 text-[11px] leading-snug text-[var(--wb-text-3)]">
          {allowAiRowData
            ? 'Schema + capped tool row samples may be sent to OpenRouter when tools run.'
            : 'Schema sent as system prompt. Enable "Allow AI tools to read row data" on this connection to let tools send capped row samples.'}
        </p>
      </div>
    </div>
  );
}

function EmptyState({ hasKey, onOpenSettings }: { hasKey: boolean; onOpenSettings: () => void }) {
  if (!hasKey) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
        <Sparkles className="h-6 w-6 text-[var(--wb-text-3)]" />
        <div className="text-[16px] text-[var(--wb-text-2)]">No API key</div>
        <div className="text-[12px] text-[var(--wb-text-3)]">
          The assistant uses your own OpenRouter key (it reaches Claude, GPT, Gemini and other
          models). Add it in Settings → AI.
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
        Try: "top 5 customers by revenue last 30 days" or "why might my query be slow on the orders
        table?"
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
  return (
    <div className={cn('mb-4 flex flex-col gap-1', isUser ? 'items-end' : 'items-start')}>
      <div
        className={cn(
          'max-w-[92%] rounded-[8px] px-3 py-2 text-[13px] text-[var(--wb-text)]',
          isUser
            ? 'bg-[var(--wb-selected)]'
            : 'bg-[var(--wb-control)]/60 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--wb-text)_6%,transparent)]',
        )}
      >
        {isUser ? (
          <span className="whitespace-pre-wrap">{turn.content}</span>
        ) : (
          <AssistantContent
            content={turn.content}
            streaming={turn.streaming}
            onInsert={onInsert}
            onRun={onRun}
          />
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
  streaming,
  onInsert,
  onRun,
}: {
  content: string;
  streaming?: boolean;
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
          <p key={i} className="whitespace-pre-wrap leading-relaxed">
            {p.text}
          </p>
        ),
      )}
      {streaming && <StreamingDot />}
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
      <div className="flex h-7 items-center gap-1 border-b border-[color-mix(in_srgb,var(--wb-text)_8%,transparent)] pl-2 pr-1 font-mono text-[10px] uppercase text-[var(--wb-text-3)]">
        <span>{lang || 'sql'}</span>
        <div className="flex-1" />
        {isSql && (
          <>
            <Pill className="h-5 px-1.5 text-[11px] normal-case" onClick={onInsert}>
              Insert
            </Pill>
            <Pill className="h-5 px-1.5 text-[11px] normal-case" onClick={onRun}>
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

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  'meta-llama': 'Meta',
  mistralai: 'Mistral',
  qwen: 'Qwen',
  deepseek: 'DeepSeek',
  'x-ai': 'xAI',
};

/**
 * Badge label for an OpenRouter model id: "anthropic/claude-sonnet-4.5" →
 * "Anthropic · claude-sonnet-4.5". The request always goes through
 * OpenRouter; the prefix names the model's actual provider (G3).
 */
export function modelLabel(model: string): string {
  const slash = model.indexOf('/');
  if (slash === -1) return model;
  const vendor = model.slice(0, slash);
  return `${PROVIDER_NAMES[vendor] ?? vendor} · ${model.slice(slash + 1)}`;
}
