import { Button } from '@/components/ui/button';
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
  const setMode = useSession((s) => s.setRightPanelMode);
  const aiChat = useSession((s) => s.aiChat);
  const aiPending = useSession((s) => s.aiPending);
  const aiAsk = useSession((s) => s.aiAsk);
  const aiCancel = useSession((s) => s.aiCancel);
  const aiClear = useSession((s) => s.aiClear);
  const setSql = useSession((s) => s.setSql);
  const runQuery = useSession((s) => s.runQuery);
  const addTab = useSession((s) => s.addTab);
  const apiKey = useSession((s) => s.settings.openrouterApiKey || s.settings.claudeApiKey);
  const model = useSession((s) => s.settings.openrouterModel);
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

  const handleInsert = (code: string) => {
    if (!tab) return;
    if (tab.kind === 'table') {
      // Spawn a fresh SQL tab for the user — don't clobber the table tab.
      addTab();
      // After the next tick, set sql on the new active tab.
      queueMicrotask(() => setSql(code));
      return;
    }
    setSql(code);
  };

  const handleRun = (code: string) => {
    if (!tab) return;
    handleInsert(code);
    // Defer slightly so the new tab + setSql settle before the run.
    setTimeout(() => void runQuery(), 30);
  };

  const empty = aiChat.length === 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-background pl-3 pr-2">
        <Sparkles className="h-3.5 w-3.5 text-primary" />
        <span className="truncate text-sm font-medium text-foreground">AI assistant</span>
        <span
          className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground"
          title="Active OpenRouter model"
        >
          {modelLabel(model)}
        </span>
        <div className="flex-1" />
        {aiChat.length > 0 && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={aiClear}
            title="Clear conversation"
            aria-label="Clear conversation"
          >
            <Trash2 />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setMode(null)}
          aria-label="Close panel"
          title="Close"
        >
          <span className="text-base leading-none">×</span>
        </Button>
      </div>

      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {empty && <EmptyState hasKey={Boolean(apiKey.trim())} />}
        {aiChat.map((turn) => (
          <ChatTurn key={turn.id} turn={turn} onInsert={handleInsert} onRun={handleRun} />
        ))}
      </div>

      <div className="shrink-0 border-t border-border bg-background p-2">
        <div className="relative">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            placeholder={
              apiKey.trim()
                ? 'Ask for a query, paste an error, or describe what you want to find…'
                : 'Add an OpenRouter API key in Settings to enable AI'
            }
            disabled={!apiKey.trim()}
            rows={3}
            className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 pr-9 font-display text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary disabled:cursor-not-allowed disabled:opacity-60"
          />
          {aiPending ? (
            <Button
              variant="destructive"
              size="icon-xs"
              onClick={() => void aiCancel()}
              className="absolute bottom-1.5 right-1.5"
              title="Stop"
              aria-label="Stop"
            >
              <Square className="fill-current" />
            </Button>
          ) : (
            <Button
              variant="primary"
              size="icon-xs"
              onClick={submit}
              disabled={!draft.trim() || !apiKey.trim()}
              className="absolute bottom-1.5 right-1.5"
              title="Send (Enter)"
              aria-label="Send"
            >
              <Send />
            </Button>
          )}
        </div>
        <p className="mt-1.5 px-1 font-display text-[10px] italic text-muted-foreground">
          Schema sent as system prompt. Row data never leaves your machine.
        </p>
      </div>
    </div>
  );
}

function EmptyState({ hasKey }: { hasKey: boolean }) {
  if (!hasKey) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
        <Sparkles className="h-6 w-6 text-muted-foreground" />
        <div className="font-display text-base italic text-foreground">No API key</div>
        <div className="font-display text-xs italic text-muted-foreground">
          Add your OpenRouter key in Settings → AI to start asking questions about this database.
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
      <Sparkles className="h-6 w-6 text-primary/70" />
      <div className="font-display text-base italic text-foreground">
        Ask anything about this database.
      </div>
      <div className="font-display text-xs italic text-muted-foreground">
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
          'max-w-[92%] rounded-lg px-3 py-2 text-sm',
          isUser
            ? 'bg-primary text-primary-foreground'
            : 'border border-border bg-muted/30 text-foreground',
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
    <span className="inline-flex items-center gap-1 text-muted-foreground">
      <Loader2 className="h-3 w-3 animate-spin" />
      <span className="font-display text-[11px] italic">thinking…</span>
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
    <div className="overflow-hidden rounded-md border border-border bg-background">
      <div className="flex h-7 items-center gap-2 border-b border-border bg-muted/40 pl-2 pr-1 font-mono text-[10px] uppercase text-muted-foreground">
        <span>{lang || 'sql'}</span>
        <div className="flex-1" />
        {isSql && (
          <>
            <Button variant="ghost" size="xs" className="h-5 px-1.5" onClick={onInsert}>
              Insert
            </Button>
            <Button variant="primary" size="xs" className="h-5 px-1.5" onClick={onRun}>
              Run
            </Button>
          </>
        )}
      </div>
      <pre className="overflow-x-auto p-2 font-mono text-[12px] leading-relaxed text-foreground">
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

function modelLabel(model: string): string {
  // Trim provider prefix for the badge — "anthropic/claude-sonnet-4.5" → "claude-sonnet-4.5".
  const slash = model.indexOf('/');
  return slash === -1 ? model : model.slice(slash + 1);
}
