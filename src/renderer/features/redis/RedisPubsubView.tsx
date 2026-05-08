import { Button } from '@/components/ui/button';
import { ipc } from '@/lib/ipc';
import type { RedisPubsubMessage } from '@shared/protocol';
import { Loader2, Pause, Play, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

const MAX_MESSAGES = 2000;

interface PubsubViewProps {
  channel: string;
  pattern: boolean;
}

/**
 * Live tail of a Redis pub/sub channel (or PSUBSCRIBE pattern).
 *
 * Subscribes on mount via the worker, listens to broadcast events on
 * `plasma:redis:pubsub`, and renders messages newest-on-top capped at
 * MAX_MESSAGES so memory stays bounded on chatty channels. Pause stops
 * accepting new messages without unsubscribing — useful for inspecting
 * a fast feed without dropping the subscription.
 */
export function RedisPubsubView({ channel, pattern }: PubsubViewProps) {
  const [messages, setMessages] = useState<RedisPubsubMessage[]>([]);
  const [paused, setPaused] = useState(false);
  const [status, setStatus] = useState<'subscribing' | 'live' | 'error' | 'stopped'>(
    'subscribing',
  );
  const [error, setError] = useState<string | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    let cancelled = false;
    void ipc.redis
      .subscribe(channel, pattern)
      .then(() => {
        if (!cancelled) setStatus('live');
      })
      .catch((err) => {
        if (cancelled) return;
        setStatus('error');
        setError(err instanceof Error ? err.message : String(err));
      });

    const off = window.plasmaEvents.on('plasma:redis:pubsub', (payload: unknown) => {
      const msg = payload as RedisPubsubMessage;
      // Filter for matching channel — the worker forwards every event.
      // Direct subscription uses exact channel match; pattern subs match
      // when the message's channel matches our glob.
      if (!matchesSubscription(channel, pattern, msg.channel)) return;
      if (msg.pattern !== pattern) {
        // Direct messages still arrive when one tab is psub and another sub
        // with overlap — keep what's relevant.
      }
      if (pausedRef.current) return;
      setMessages((prev) => {
        const next = [msg, ...prev];
        if (next.length > MAX_MESSAGES) next.length = MAX_MESSAGES;
        return next;
      });
    });

    return () => {
      cancelled = true;
      off();
      void ipc.redis.unsubscribe(channel, pattern).catch(() => {});
    };
  }, [channel, pattern]);

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              {pattern ? 'psub' : 'sub'}
            </span>
            <h1 className="truncate font-mono text-sm">{channel}</h1>
          </div>
          <p className="mt-0.5 font-display text-[11px] italic text-muted-foreground">
            {messages.length.toLocaleString()} messages · {statusLabel(status)}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setPaused((v) => !v)}
          disabled={status !== 'live'}
        >
          {paused ? <Play className="fill-current" /> : <Pause />}
          {paused ? 'Resume' : 'Pause'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setMessages([])}
          disabled={messages.length === 0}
        >
          <Trash2 />
          Clear
        </Button>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto font-mono text-xs">
        {error && (
          <div className="m-3 rounded-md border-l-4 border-destructive bg-muted px-4 py-2 text-foreground">
            {error}
          </div>
        )}
        {status === 'subscribing' && (
          <div className="flex items-center gap-2 px-4 py-3 text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> subscribing…
          </div>
        )}
        {status === 'live' && messages.length === 0 && (
          <div className="px-4 py-3 font-display text-sm italic text-muted-foreground">
            waiting for messages…
          </div>
        )}
        {messages.length > 0 && (
          <ul className="divide-y divide-border/50">
            {messages.map((m) => (
              <li
                key={`${m.timestamp}-${m.channel}-${m.message.slice(0, 8)}`}
                className="grid grid-cols-[120px_140px_1fr] gap-3 px-4 py-1.5 hover:bg-muted/30"
              >
                <span className="text-muted-foreground">{fmtTime(m.timestamp)}</span>
                <span className="truncate text-foreground" title={m.channel}>
                  {m.channel}
                </span>
                <span className="break-all text-foreground">{m.message}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

function statusLabel(s: 'subscribing' | 'live' | 'error' | 'stopped'): string {
  if (s === 'subscribing') return 'subscribing…';
  if (s === 'live') return 'live';
  if (s === 'error') return 'error';
  return 'stopped';
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  const ss = d.getSeconds().toString().padStart(2, '0');
  const ms = d.getMilliseconds().toString().padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

/**
 * Determine whether an incoming pub/sub message matches the
 * subscription set up by this tab.
 */
function matchesSubscription(channel: string, pattern: boolean, incoming: string): boolean {
  if (!pattern) return incoming === channel;
  // Convert Redis glob pattern to RegExp. Supports * and ? and [chars].
  const re = new RegExp(
    `^${channel
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`,
  );
  return re.test(incoming);
}
