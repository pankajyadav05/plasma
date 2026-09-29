import { EmptyState, ViewFooter, ViewTitle, ViewToolbar } from '@/components/ui/view-parts';
import { IconButton, Pill } from '@/components/ui/workbench';
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import { useWorkbench } from '@/stores/workbench';
import {
  type RedisCommandVerdict,
  classifyRedisCommand,
  redisCommandNeedsConfirm,
  tokenizeRedisCommand,
} from '@shared/redis-command-policy';
import { CornerDownLeft, Loader2, Square, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ActionDialog, errMsg } from './redis-dialogs';
import { type CliEntry, useRedisTabs } from './redis-store';
import { useRedisWriteGate } from './use-redis-write';

/**
 * redis-cli inside the workbench.
 *
 *   - redis-cli compatible tokenizer (quotes, escapes, empty args — R17)
 *   - safety (R3/S1): subscriber / connection-state commands are refused
 *     with a hint; writes need edit mode and a writable connection;
 *     destructive or expensive commands (FLUSH*, CONFIG SET, KEYS …)
 *     always confirm, and on prod-tagged connections every write does
 *   - blocking commands run on their own connection and can be cancelled
 *   - `SELECT n` switches this tab's prompt db; every command carries it,
 *     so the rest of the app is never retargeted (R5)
 *   - transcript + db live in the tab store; history is persisted (R18)
 */
export function RedisCliView({ tabId }: { tabId: string }) {
  const activeConfig = useSession((s) => s.activeConfig);
  const sidebarDb = useSession((s) => s.redisDb as number);
  const state = useRedisTabs((s) => s.cli[tabId]);
  const history = useRedisTabs((s) => s.history);
  const updateCli = useRedisTabs((s) => s.updateCli);
  const pushHistory = useRedisTabs((s) => s.pushHistory);
  const { canWrite, readOnly, prod } = useRedisWriteGate();

  const entries = state?.entries ?? [];
  const db = state?.db ?? sidebarDb;
  const busy = state?.busy ?? false;
  const [input, setInput] = useState('');
  const [cursor, setCursor] = useState(-1);
  const [pending, setPending] = useState<{
    parts: string[];
    text: string;
    verdict: RedisCommandVerdict;
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const host = activeConfig ? `${activeConfig.host}:${activeConfig.port}` : 'redis';
  const prompt = `${host}[${db}]>`;

  const scrollToBottom = () => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: focus + scroll once on mount
  useEffect(() => {
    inputRef.current?.focus();
    requestAnimationFrame(scrollToBottom);
  }, []);

  // F28: the latest reply is what Details shows on this tab.
  const last = entries[entries.length - 1];
  useEffect(() => {
    if (!last || (!last.result && !last.error && !last.notice)) return;
    useWorkbench.getState().setInspectedRow({
      tabId,
      rowNumber: entries.length,
      columnIndex: 1,
      columns: [
        { name: 'command', dataTypeID: 0, dataTypeName: last.prompt },
        { name: 'reply', dataTypeID: 0, dataTypeName: last.error ? 'error' : 'reply' },
        { name: 'duration', dataTypeID: 0, dataTypeName: 'ms' },
      ],
      row: [
        last.command,
        last.error ?? last.notice ?? (last.result ? formatReply(last.result.reply) : null),
        last.durationMs,
      ],
    });
  }, [last, tabId, entries.length]);

  const addEntry = (entry: CliEntry) => {
    updateCli(tabId, (s) => ({ entries: [...s.entries, entry].slice(-1000) }));
    requestAnimationFrame(scrollToBottom);
  };
  const patchEntry = (id: string, patch: Partial<CliEntry>) => {
    updateCli(tabId, (s) => ({
      entries: s.entries.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    }));
  };

  const send = async (parts: string[], text: string, verdict: RedisCommandVerdict) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    addEntry({ id, prompt, command: text, result: null, error: null, durationMs: null });
    updateCli(tabId, () => ({ busy: true, db }));
    try {
      const result = await ipc.redis.command(parts, { db });
      patchEntry(id, { result, durationMs: result.durationMs });
      if (verdict.mode === 'select') {
        updateCli(tabId, () => ({ db: Number(parts[1]) }));
      }
    } catch (err) {
      patchEntry(id, { error: errMsg(err) });
    } finally {
      updateCli(tabId, () => ({ busy: false }));
      requestAnimationFrame(() => {
        scrollToBottom();
        inputRef.current?.focus();
      });
    }
  };

  const note = (text: string, notice: string) => {
    addEntry({
      id: `${Date.now()}-n`,
      prompt,
      command: text,
      result: null,
      error: null,
      notice,
      durationMs: null,
    });
  };

  const submit = () => {
    const text = input.trim();
    if (!text || busy) return;
    const parts = tokenizeRedisCommand(text);
    setInput('');
    setCursor(-1);
    pushHistory(text);
    if (parts === null) return note(text, 'Invalid argument(s): unbalanced quotes');
    if (parts.length === 0) return;
    const verdict = classifyRedisCommand(parts);
    if (verdict.mode === 'refuse') return note(text, verdict.reason ?? 'Not supported in the CLI');
    if (verdict.access === 'write' && readOnly) {
      return note(text, `${verdict.verb} writes data — this connection is read-only.`);
    }
    if (verdict.access === 'write' && !canWrite) {
      return note(
        text,
        `${verdict.verb} writes data — turn on edit mode (the pencil in the top bar) to run it.`,
      );
    }
    if (redisCommandNeedsConfirm(verdict, prod)) {
      setPending({ parts, text, verdict });
      return;
    }
    void send(parts, text, verdict);
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
          onClick={() => updateCli(tabId, () => ({ entries: [] }))}
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
            hint={
              canWrite
                ? 'PING · INFO server · DBSIZE · CLIENT LIST · CONFIG GET maxmemory'
                : 'PING · INFO server · DBSIZE · CLIENT LIST — write commands need edit mode'
            }
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
                  {e.notice ? (
                    <span className="whitespace-pre-wrap break-words text-[var(--wb-text-2)]">
                      (not sent) {e.notice}
                    </span>
                  ) : e.error ? (
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
            submit();
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
          {busy ? (
            <Pill
              onClick={() => void ipc.redis.cancel().catch(() => {})}
              aria-label="Cancel"
              title="Cancel a blocking command"
            >
              <Square />
              Cancel
            </Pill>
          ) : (
            <Pill type="submit" disabled={input.trim() === ''} aria-label="Send">
              <CornerDownLeft />
              Run
            </Pill>
          )}
        </form>
      </ViewFooter>

      <ActionDialog
        open={pending !== null}
        onOpenChange={(o) => !o && setPending(null)}
        title={`Run ${pending?.verdict.verb ?? ''}?`}
        description={
          <>
            <span className="block break-all font-mono text-[var(--wb-text)]">{pending?.text}</span>
            <span className="mt-1 block">
              {pending?.verdict.reason ??
                (prod ? 'This connection is tagged production.' : 'This command changes data.')}
            </span>
          </>
        }
        confirmLabel="Run"
        destructive={pending?.verdict.risk !== 'expensive'}
        typeToConfirm={
          prod && pending?.verdict.risk === 'destructive'
            ? pending.verdict.verb.split(' ')[0]
            : null
        }
        onConfirm={() => {
          if (pending) void send(pending.parts, pending.text, pending.verdict);
        }}
      />
    </main>
  );
}

export function formatReply(reply: unknown): string {
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
