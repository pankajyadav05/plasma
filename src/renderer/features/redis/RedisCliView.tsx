import { EmptyState, ViewFooter, ViewTitle, ViewToolbar } from '@/components/ui/view-parts';
import { IconButton, Pill } from '@/components/ui/workbench';
import { cleanIpcError } from '@/lib/errors';
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import type { RedisCommandResult } from '@shared/protocol';
import { CornerDownLeft, Loader2, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

interface CliEntry {
  id: string;
  /** Prompt as it read when the command was sent (`host:port[db]>`). */
  prompt: string;
  command: string;
  result: RedisCommandResult | null;
  error: string | null;
  durationMs: number | null;
}

/**
 * Minimal redis-cli — split user input on whitespace (with rudimentary
 * quoting), forward to ipc.redis.command, render replies bottom-up.
 *
 * Design intent: feel like a real terminal inside the workbench. Each
 * command echoes after a `127.0.0.1:6379[0]>` prompt with its reply
 * underneath, the input stays pinned at the bottom, and Up/Down walks
 * the local history stack.
 */
export function RedisCliView() {
  const activeConfig = useSession((s) => s.activeConfig);
  const [input, setInput] = useState('');
  const [entries, setEntries] = useState<CliEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [cursor, setCursor] = useState(-1);
  // Tracks `SELECT n` so the prompt shows the db the worker is on.
  const [db, setDb] = useState<string>(() => activeConfig?.database || '0');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const host = activeConfig ? `${activeConfig.host}:${activeConfig.port}` : 'redis';
  const prompt = `${host}[${db}]>`;

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
    if (!cmd || busy) return;
    const parts = tokenize(cmd);
    if (parts.length === 0) return;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setEntries((prev) => [
      ...prev,
      { id, prompt, command: cmd, result: null, error: null, durationMs: null },
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
      const [verb, arg] = parts;
      if (verb?.toUpperCase() === 'SELECT' && arg !== undefined && /^\d+$/.test(arg)) {
        setDb(arg);
      }
    } catch (err) {
      setEntries((prev) =>
        prev.map((e) =>
          e.id === id
            ? { ...e, error: cleanIpcError(err instanceof Error ? err.message : String(err)) }
            : e,
        ),
      );
    } finally {
      setBusy(false);
      requestAnimationFrame(() => {
        scrollToBottom();
        inputRef.current?.focus();
      });
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

  // Clicking empty transcript space puts the caret back in the prompt,
  // unless the user is selecting text to copy.
  const focusInput = () => {
    if (window.getSelection()?.toString()) return;
    inputRef.current?.focus();
  };

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--wb-content)]">
      <ViewToolbar>
        <ViewTitle
          title={<span className="font-mono">redis-cli</span>}
          meta="↑/↓ history · ⏎ run"
        />
        <div className="flex-1" />
        {entries.length > 0 && (
          <span className="text-[12px] tabular-nums text-[var(--wb-text-2)]">
            {entries.length.toLocaleString()} {entries.length === 1 ? 'command' : 'commands'}
          </span>
        )}
        <IconButton
          label="Clear output"
          onClick={() => setEntries([])}
          disabled={entries.length === 0}
        >
          <Trash2 />
        </IconButton>
      </ViewToolbar>

      {/* Transcript */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: convenience only — the input is keyboard reachable */}
      <div
        ref={scrollRef}
        onClick={focusInput}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-[13px] leading-5 text-[var(--grid-text)]"
      >
        {entries.length === 0 ? (
          <EmptyState
            title="Type a Redis command below"
            hint="PING · INFO server · DBSIZE · CLIENT LIST · CONFIG GET maxmemory"
          />
        ) : (
          <ul className="space-y-2.5">
            {entries.map((e) => (
              <li key={e.id}>
                <div className="flex items-baseline gap-2">
                  <span className="shrink-0 text-[var(--wb-text-2)]">{e.prompt}</span>
                  <span className="min-w-0 flex-1 break-all text-[var(--wb-text)]">
                    {e.command}
                  </span>
                  {e.durationMs !== null && (
                    <span className="shrink-0 text-[11px] tabular-nums text-[var(--wb-text-3)]">
                      {e.durationMs}ms
                    </span>
                  )}
                </div>
                <div className="select-text">
                  {e.error ? (
                    <span className="whitespace-pre-wrap break-all text-destructive">
                      (error) {e.error}
                    </span>
                  ) : e.result ? (
                    e.result.reply === null || e.result.reply === undefined ? (
                      <span className="text-[var(--grid-null)]">(nil)</span>
                    ) : (
                      <pre className="whitespace-pre-wrap break-all font-mono">
                        {formatReply(e.result.reply)}
                      </pre>
                    )
                  ) : (
                    <span className="flex items-center gap-1.5 text-[var(--wb-text-3)]">
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
      <ViewFooter className="px-3">
        <form
          className="flex min-w-0 flex-1 items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <span className="shrink-0 font-mono text-[13px] text-[var(--wb-text-2)]">{prompt}</span>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            // Never disable while a command runs: a disabled input drops
            // keystrokes typed right after Enter (and loses focus).
            // submit() refuses to send while busy instead.
            placeholder="GET myKey"
            aria-label="Redis command"
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-[var(--wb-text)] outline-none placeholder:text-[var(--wb-text-3)]"
          />
          <Pill type="submit" disabled={busy || input.trim() === ''} aria-label="Send">
            {busy ? <Loader2 className="animate-spin" /> : <CornerDownLeft />}
            Run
          </Pill>
        </form>
      </ViewFooter>
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
