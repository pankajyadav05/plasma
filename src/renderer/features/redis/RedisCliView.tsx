import { Button } from '@/components/ui/button';
import { ipc } from '@/lib/ipc';
import type { RedisCommandResult } from '@shared/protocol';
import { Loader2, Send, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

interface CliEntry {
  id: string;
  command: string;
  result: RedisCommandResult | null;
  error: string | null;
  durationMs: number | null;
}

/**
 * Minimal redis-cli — split user input on whitespace (with rudimentary
 * quoting), forward to ipc.redis.command, render replies bottom-up.
 *
 * Design intent: feel like a real terminal, not a form. Commands echo
 * inline above their output, the input stays at the bottom, and Up/Down
 * walks the local history stack.
 */
export function RedisCliView() {
  const [input, setInput] = useState('');
  const [entries, setEntries] = useState<CliEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [cursor, setCursor] = useState(-1);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const scrollToBottom = () => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  };

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = async () => {
    const cmd = input.trim();
    if (!cmd) return;
    const parts = tokenize(cmd);
    if (parts.length === 0) return;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setEntries((prev) => [
      ...prev,
      { id, command: cmd, result: null, error: null, durationMs: null },
    ]);
    setHistory((prev) => [...prev, cmd]);
    setCursor(-1);
    setInput('');
    setBusy(true);
    // Defer to next paint so the new entry has been laid out before we
    // read scrollHeight.
    requestAnimationFrame(scrollToBottom);
    try {
      const result = await ipc.redis.command(parts);
      setEntries((prev) =>
        prev.map((e) => (e.id === id ? { ...e, result, durationMs: result.durationMs } : e)),
      );
    } catch (err) {
      setEntries((prev) =>
        prev.map((e) =>
          e.id === id ? { ...e, error: err instanceof Error ? err.message : String(err) } : e,
        ),
      );
    } finally {
      setBusy(false);
      requestAnimationFrame(scrollToBottom);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length === 0) return;
      const next = cursor < 0 ? history.length - 1 : Math.max(0, cursor - 1);
      setCursor(next);
      setInput(history[next] ?? '');
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (cursor < 0) return;
      const next = cursor + 1;
      if (next >= history.length) {
        setCursor(-1);
        setInput('');
      } else {
        setCursor(next);
        setInput(history[next] ?? '');
      }
    }
  };

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="font-mono text-sm font-semibold">redis-cli</span>
        <span className="font-display text-[11px] italic text-muted-foreground">
          press ↑/↓ to recall, ⏎ to send
        </span>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setEntries([])}
          disabled={entries.length === 0}
        >
          <Trash2 />
          Clear
        </Button>
      </div>

      {/* Transcript */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3 font-mono text-xs">
        {entries.length === 0 ? (
          <div className="flex h-full flex-col items-start gap-2 font-display italic text-muted-foreground">
            <span className="text-sm">try: INFO server</span>
            <span className="text-[11px]">PING · DBSIZE · CLIENT LIST · CONFIG GET maxmemory</span>
          </div>
        ) : (
          <ul className="space-y-3">
            {entries.map((e) => (
              <li key={e.id} className="rounded-md border border-border bg-muted/20">
                <div className="border-b border-border/60 px-3 py-1.5">
                  <span className="text-muted-foreground">›</span>{' '}
                  <span className="text-foreground">{e.command}</span>
                  {e.durationMs !== null && (
                    <span className="ml-2 font-display text-[11px] italic text-muted-foreground">
                      {e.durationMs}ms
                    </span>
                  )}
                </div>
                <div className="px-3 py-2">
                  {e.error ? (
                    <span className="text-destructive">{e.error}</span>
                  ) : e.result ? (
                    <pre className="whitespace-pre-wrap break-all leading-5">
                      {formatReply(e.result.reply)}
                    </pre>
                  ) : (
                    <span className="flex items-center gap-1 text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" /> waiting…
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Input */}
      <div className="shrink-0 border-t border-border bg-muted/20 px-4 py-2">
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <span className="font-mono text-sm text-muted-foreground">›</span>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={busy}
            placeholder="GET myKey"
            className="flex-1 bg-transparent font-mono text-sm outline-none placeholder:text-muted-foreground/60"
          />
          <Button type="submit" size="sm" variant="primary" disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Send />}
            Send
          </Button>
        </form>
      </div>
    </main>
  );
}

/**
 * Whitespace-split with simple double-quote support so commands like
 * `SET foo "hello world"` parse correctly. We don't try to be a full
 * shell — backslash escapes etc. are out of scope; users with exotic
 * payloads can use the inline-edit dialogs.
 */
function tokenize(input: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inQuote = false;
  for (const ch of input) {
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && /\s/.test(ch)) {
      if (buf) {
        out.push(buf);
        buf = '';
      }
      continue;
    }
    buf += ch;
  }
  if (buf) out.push(buf);
  return out;
}

function formatReply(reply: unknown): string {
  if (reply === null || reply === undefined) return '(nil)';
  if (typeof reply === 'string' || typeof reply === 'number' || typeof reply === 'boolean') {
    return String(reply);
  }
  if (Array.isArray(reply)) {
    if (reply.length === 0) return '(empty array)';
    return reply
      .map((row, i) => `${(i + 1).toString().padStart(3, ' ')}) ${formatReply(row)}`)
      .join('\n');
  }
  return JSON.stringify(reply, null, 2);
}
