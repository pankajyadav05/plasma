import { type DataColumn, DataTable } from '@/components/ui/data-table';
import { Badge, EmptyState, ViewFooter, ViewToolbar } from '@/components/ui/view-parts';
import { IconButton, Pill } from '@/components/ui/workbench';
import { matchesTailFilter } from '@/features/live-tail/live-tail';
import { cn } from '@/lib/cn';
import { useWorkbench } from '@/stores/workbench';
import { isKeyeventPattern, parseKeyeventChannel } from '@shared/redis-keyspace';
import { Loader2, Pause, Play, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { KeyspaceBanner } from './KeyspaceBanner';
import {
  PUBSUB_MAX_MESSAGES,
  type PubsubRow,
  type PubsubStatus,
  useRedisTabs,
} from './redis-store';

const MAX_MESSAGES = PUBSUB_MAX_MESSAGES;

type Status = PubsubStatus;
type Row = PubsubRow;

interface PubsubViewProps {
  tabId: string;
  channel: string;
  pattern: boolean;
}

/**
 * Live tail of a Redis pub/sub channel (or PSUBSCRIBE pattern).
 *
 * The subscription and the message buffer belong to the *tab* (R13):
 * they live in the Redis tab store, so switching to another tab keeps
 * the tail running and the messages; closing the tab unsubscribes.
 * Messages render newest-on-top capped at MAX_MESSAGES. Pause drops new
 * messages without unsubscribing; Unsubscribe keeps what was captured.
 */
export function RedisPubsubView({ tabId, channel, pattern }: PubsubViewProps) {
  const st = useRedisTabs((s) => s.pubsub[tabId]);
  const pubsubStart = useRedisTabs((s) => s.pubsubStart);
  const pubsubStop = useRedisTabs((s) => s.pubsubStop);
  const pubsubPatch = useRedisTabs((s) => s.pubsubPatch);
  const allMessages = st?.messages ?? [];
  const filter = st?.filter ?? '';
  const dropped = st?.dropped ?? 0;
  const keyspace = pattern && isKeyeventPattern(channel);
  const messages = useMemo(
    () =>
      filter
        ? allMessages.filter((m) => matchesTailFilter(m.channel, m.message, filter))
        : allMessages,
    [allMessages, filter],
  );
  const paused = st?.paused ?? false;
  const status: Status = st?.status ?? 'subscribing';
  const error = st?.error ?? null;
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);

  // First open of the tab subscribes; later mounts just re-attach.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only on first mount of this tab
  useEffect(() => {
    if (!useRedisTabs.getState().pubsub[tabId]) void pubsubStart(tabId, channel, pattern);
  }, [tabId]);

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
      keyspace
        ? {
            key: 'event',
            label: 'event',
            width: 130,
            render: (m) => parseKeyeventChannel(m.channel)?.event ?? m.channel,
            titleOf: (m) => m.channel,
          }
        : {
            key: 'channel',
            label: 'channel',
            width: 180,
            render: (m) => m.channel,
            titleOf: (m) => m.channel,
          },
      {
        key: keyspace ? 'key' : 'payload',
        label: keyspace ? 'key' : 'payload',
        render: (m) => m.message,
        titleOf: (m) => (m.message.length > 400 ? `${m.message.slice(0, 400)}…` : m.message),
      },
    ],
    [keyspace],
  );

  const active = status === 'live' || status === 'subscribing';
  const toggleSubscription = () => {
    if (active) void pubsubStop(tabId);
    else void pubsubStart(tabId, channel, pattern);
  };
  const setPaused = (fn: (v: boolean) => boolean) => pubsubPatch(tabId, { paused: fn(paused) });
  const clearMessages = () => pubsubPatch(tabId, { messages: [], dropped: 0 });

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--wb-content)]">
      <ViewToolbar>
        <Badge tone={pattern ? 'accent' : 'neutral'}>{pattern ? 'psub' : 'sub'}</Badge>
        <span className="min-w-0 truncate font-mono font-semibold" title={channel}>
          {channel}
        </span>
        <StatusChip status={status} paused={paused} />
        <div className="flex-1" />
        <input
          aria-label="Filter messages"
          className="h-[26px] w-[170px] min-w-0 rounded-[7px] border-0 bg-[var(--wb-field)] px-2.5 font-mono text-[13px] text-[var(--wb-text)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--wb-text)_10%,transparent)] outline-none placeholder:text-[var(--wb-text-3)] focus:shadow-[0_0_0_2px_color-mix(in_srgb,var(--wb-accent)_55%,transparent)]"
          placeholder="filter  (!not  channel:x)"
          value={filter}
          onChange={(e) => pubsubPatch(tabId, { filter: e.target.value })}
          spellCheck={false}
        />
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
          onClick={clearMessages}
          disabled={allMessages.length === 0}
        >
          <Trash2 />
        </IconButton>
        <Pill onClick={toggleSubscription} disabled={status === 'subscribing'}>
          {active ? 'Unsubscribe' : 'Subscribe'}
        </Pill>
      </ViewToolbar>

      {keyspace && <KeyspaceBanner />}

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
              keyspace ? (
                <>
                  Change any key, e.g. <span className="font-mono">SET demo 1</span>, to see its
                  event here.
                </>
              ) : (
                <>
                  Publish with <span className="font-mono">PUBLISH {channel} hello</span> to see it
                  here.
                </>
              )
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
          {messages.length.toLocaleString()}
          {messages.length !== allMessages.length
            ? ` of ${allMessages.length.toLocaleString()}`
            : ''}{' '}
          {allMessages.length === 1 ? 'message' : 'messages'}
        </span>
        <span className="text-[12px] text-[var(--wb-text-3)]">
          · newest first, capped at {MAX_MESSAGES.toLocaleString()}
        </span>
        {dropped > 0 && (
          <span className="text-[12px] text-[var(--status-staging)]" data-testid="tail-dropped">
            · {dropped.toLocaleString()} dropped
          </span>
        )}
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
