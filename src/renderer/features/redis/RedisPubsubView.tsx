import { type DataColumn, DataTable } from '@/components/ui/data-table';
import { Badge, EmptyState, ViewFooter, ViewToolbar } from '@/components/ui/view-parts';
import { IconButton, Pill } from '@/components/ui/workbench';
import { cn } from '@/lib/cn';
import { cleanIpcError } from '@/lib/errors';
import { ipc } from '@/lib/ipc';
import { useActiveTab } from '@/stores/session';
import { useWorkbench } from '@/stores/workbench';
import type { RedisPubsubMessage } from '@shared/protocol';
import { Loader2, Pause, Play, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

const MAX_MESSAGES = 2000;

type Status = 'subscribing' | 'live' | 'error' | 'stopped';

interface PubsubViewProps {
  channel: string;
  pattern: boolean;
}

/** A received message plus a local sequence number for stable identity. */
interface Row extends RedisPubsubMessage {
  seq: number;
}

/**
 * Live tail of a Redis pub/sub channel (or PSUBSCRIBE pattern).
 *
 * Subscribes on mount via the worker, listens to broadcast events on
 * `plasma:redis:pubsub`, and renders messages newest-on-top capped at
 * MAX_MESSAGES so memory stays bounded on chatty channels. Pause stops
 * accepting new messages without unsubscribing — useful for inspecting
 * a fast feed without dropping the subscription. Unsubscribe drops the
 * subscription (keeping the captured messages); Subscribe re-attaches.
 */
export function RedisPubsubView({ channel, pattern }: PubsubViewProps) {
  const tabId = useActiveTab()?.id ?? null;
  const [messages, setMessages] = useState<Row[]>([]);
  const [paused, setPaused] = useState(false);
  const [active, setActive] = useState(true);
  const [status, setStatus] = useState<Status>('subscribing');
  const [error, setError] = useState<string | null>(null);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const seqRef = useRef(0);

  useEffect(() => {
    if (!active) {
      setStatus('stopped');
      return;
    }
    let cancelled = false;
    setStatus('subscribing');
    setError(null);
    void ipc.redis
      .subscribe(channel, pattern)
      .then(() => {
        if (!cancelled) setStatus('live');
      })
      .catch((err) => {
        if (cancelled) return;
        setStatus('error');
        setError(cleanIpcError(err instanceof Error ? err.message : String(err)));
      });

    const off = window.plasmaEvents.on('plasma:redis:pubsub', (payload: unknown) => {
      const msg = payload as RedisPubsubMessage;
      // Filter for matching channel — the worker forwards every event.
      // Direct subscription uses exact channel match; pattern subs match
      // when the message's channel matches our glob.
      if (!matchesSubscription(channel, pattern, msg.channel)) return;
      if (pausedRef.current) return;
      seqRef.current += 1;
      const row: Row = { ...msg, seq: seqRef.current };
      setMessages((prev) => {
        const next = [row, ...prev];
        if (next.length > MAX_MESSAGES) next.length = MAX_MESSAGES;
        return next;
      });
    });

    return () => {
      cancelled = true;
      off();
      void ipc.redis.unsubscribe(channel, pattern).catch(() => {});
    };
  }, [channel, pattern, active]);

  // Clear the Details pane when leaving the view.
  useEffect(() => () => useWorkbench.getState().setInspectedRow(null), []);

  // Selection follows the message (by seq) as new ones push it down.
  const selectedIndex = useMemo(() => {
    if (selectedSeq === null) return null;
    const i = messages.findIndex((m) => m.seq === selectedSeq);
    return i < 0 ? null : i;
  }, [messages, selectedSeq]);

  // The selected message fell off the cap (or was cleared) → clear Details.
  useEffect(() => {
    if (selectedSeq !== null && selectedIndex === null) {
      setSelectedSeq(null);
      useWorkbench.getState().setInspectedRow(null);
    }
  }, [selectedSeq, selectedIndex]);

  const onSelect = (m: Row, index: number) => {
    setSelectedSeq(m.seq);
    if (!tabId) return;
    useWorkbench.getState().setInspectedRow({
      tabId,
      rowNumber: index + 1,
      columnIndex: 2,
      columns: [
        { name: 'time', dataTypeID: 0, dataTypeName: 'received' },
        { name: 'channel', dataTypeID: 0, dataTypeName: m.pattern ? 'psub match' : 'channel' },
        { name: 'payload', dataTypeID: 0, dataTypeName: `${m.message.length} chars` },
      ],
      row: [new Date(m.timestamp).toISOString(), m.channel, prettyPayload(m.message)],
    });
  };

  const columns = useMemo<DataColumn<Row>[]>(
    () => [
      { key: 'time', label: 'time', width: 110, render: (m) => fmtTime(m.timestamp) },
      {
        key: 'channel',
        label: 'channel',
        width: 180,
        render: (m) => m.channel,
        titleOf: (m) => m.channel,
      },
      {
        key: 'payload',
        label: 'payload',
        render: (m) => m.message,
        titleOf: (m) => (m.message.length > 400 ? `${m.message.slice(0, 400)}…` : m.message),
      },
    ],
    [],
  );

  const toggleSubscription = () => {
    setPaused(false);
    setActive((v) => !v);
  };

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--wb-content)]">
      <ViewToolbar>
        <Badge tone={pattern ? 'accent' : 'neutral'}>{pattern ? 'psub' : 'sub'}</Badge>
        <span className="min-w-0 truncate font-mono font-semibold" title={channel}>
          {channel}
        </span>
        <StatusChip status={status} paused={paused} />
        <div className="flex-1" />
        <IconButton
          label={paused ? 'Resume' : 'Pause'}
          onClick={() => setPaused((v) => !v)}
          disabled={status !== 'live'}
          active={paused}
        >
          {paused ? <Play /> : <Pause />}
        </IconButton>
        <IconButton
          label="Clear messages"
          onClick={() => setMessages([])}
          disabled={messages.length === 0}
        >
          <Trash2 />
        </IconButton>
        <Pill onClick={toggleSubscription} disabled={status === 'subscribing'}>
          {active ? 'Unsubscribe' : 'Subscribe'}
        </Pill>
      </ViewToolbar>

      {error && (
        <div
          role="alert"
          className="shrink-0 border-b border-[var(--wb-separator)] px-3 py-1.5 text-[13px] text-destructive"
        >
          {error}
        </div>
      )}

      {messages.length === 0 ? (
        status === 'subscribing' ? (
          <EmptyState
            title={
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" /> Subscribing…
              </span>
            }
          />
        ) : status === 'live' ? (
          <EmptyState
            title="Waiting for messages…"
            hint={
              <>
                Publish with <span className="font-mono">PUBLISH {channel} hello</span> to see it
                here.
              </>
            }
          />
        ) : status === 'stopped' ? (
          <EmptyState title="Not subscribed" hint="Subscribe again to resume the tail." />
        ) : null
      ) : (
        <DataTable
          ariaLabel={`Messages on ${channel}`}
          columns={columns}
          rows={messages}
          rowKey={(m) => String(m.seq)}
          selectedIndex={selectedIndex}
          onSelect={onSelect}
        />
      )}

      <ViewFooter>
        <span className="tabular-nums">
          {messages.length.toLocaleString()} {messages.length === 1 ? 'message' : 'messages'}
        </span>
        <span className="text-[12px] text-[var(--wb-text-3)]">
          · newest first, capped at {MAX_MESSAGES.toLocaleString()}
        </span>
        <div className="flex-1" />
        {paused && (
          <span className="text-[12px] text-[var(--wb-text-2)]">
            Paused — incoming messages are dropped
          </span>
        )}
      </ViewFooter>
    </main>
  );
}

function StatusChip({ status, paused }: { status: Status; paused: boolean }) {
  const label = paused && status === 'live' ? 'paused' : statusLabel(status);
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-[12px] text-[var(--wb-text-2)]">
      <span
        aria-hidden
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          status === 'live' && !paused && 'bg-[var(--status-local)]',
          status === 'live' && paused && 'bg-[var(--status-staging)]',
          status === 'subscribing' && 'bg-[var(--wb-text-3)]',
          status === 'stopped' && 'bg-[var(--wb-text-3)]',
          status === 'error' && 'bg-destructive',
        )}
      />
      {label}
    </span>
  );
}

function statusLabel(s: Status): string {
  if (s === 'subscribing') return 'subscribing…';
  if (s === 'live') return 'live';
  if (s === 'error') return 'error';
  return 'stopped';
}

/** Pretty-print JSON payloads for the Details pane; others pass through. */
function prettyPayload(message: string): string {
  const t = message.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return message;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return message;
  }
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
