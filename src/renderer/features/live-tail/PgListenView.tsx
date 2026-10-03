import { type DataColumn, DataTable } from '@/components/ui/data-table';
import { Badge, EmptyState, ViewFooter, ViewToolbar } from '@/components/ui/view-parts';
import { IconButton, Pill } from '@/components/ui/workbench';
import { cleanIpcError } from '@/lib/errors';
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import { useWorkbench } from '@/stores/workbench';
import { PG_NOTIFY_MAX_PAYLOAD_BYTES } from '@shared/pg-listen';
import { Loader2, Pause, Play, Send, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  TAIL_MAX_MESSAGES,
  fmtTailTime,
  isJsonPayload,
  matchesTailFilter,
  prettyPayload,
} from './live-tail';
import { type PgTailRow, usePgListen } from './pg-listen-store';

const FIELD =
  'h-[26px] min-w-0 rounded-[7px] border-0 bg-[var(--wb-field)] px-2.5 font-mono text-[13px] text-[var(--wb-text)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--wb-text)_10%,transparent)] outline-none placeholder:text-[var(--wb-text-3)] focus:shadow-[0_0_0_2px_color-mix(in_srgb,var(--wb-accent)_55%,transparent)]';

const NO_STATE = {
  channels: [] as string[],
  messages: [] as PgTailRow[],
  paused: false,
  filter: '',
  dropped: 0,
  error: null as string | null,
  busy: false,
};

/**
 * Postgres LISTEN/NOTIFY tail. The worker listens on its own connection
 * (the primary keeps serving queries); messages stream in newest-first with
 * the Redis pub/sub controls: pause, clear, filter, a cap and a drop counter.
 * The NOTIFY sender goes through the safe-mode gate like any write.
 */
export function PgListenView({ tabId }: { tabId: string }) {
  const st = usePgListen((s) => s.tabs[tabId]) ?? NO_STATE;
  const listen = usePgListen((s) => s.listen);
  const unlisten = usePgListen((s) => s.unlisten);
  const patch = usePgListen((s) => s.patch);
  const clear = usePgListen((s) => s.clear);
  const readOnly = useSession((s) => s.activeConfig?.readOnly === true);
  const [channelInput, setChannelInput] = useState('');
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [showSend, setShowSend] = useState(false);

  useEffect(() => () => useWorkbench.getState().setInspectedRow(null), []);

  const visible = useMemo(
    () => st.messages.filter((m) => matchesTailFilter(m.channel, m.payload, st.filter)),
    [st.messages, st.filter],
  );
  const selectedIndex = useMemo(() => {
    if (selectedSeq === null) return null;
    const i = visible.findIndex((m) => m.seq === selectedSeq);
    return i < 0 ? null : i;
  }, [visible, selectedSeq]);

  useEffect(() => {
    if (selectedSeq !== null && selectedIndex === null) {
      setSelectedSeq(null);
      useWorkbench.getState().setInspectedRow(null);
    }
  }, [selectedSeq, selectedIndex]);

  const onSelect = (m: PgTailRow, index: number) => {
    setSelectedSeq(m.seq);
    useWorkbench.getState().setInspectedRow({
      tabId,
      rowNumber: index + 1,
      columnIndex: 2,
      columns: [
        { name: 'time', dataTypeID: 0, dataTypeName: 'received' },
        { name: 'channel', dataTypeID: 0, dataTypeName: m.pid ? `from pid ${m.pid}` : 'channel' },
        {
          name: 'payload',
          dataTypeID: 0,
          dataTypeName: isJsonPayload(m.payload) ? 'json' : `${m.payload.length} chars`,
        },
      ],
      row: [new Date(m.timestamp).toISOString(), m.channel, prettyPayload(m.payload)],
    });
  };

  const columns = useMemo<DataColumn<PgTailRow>[]>(
    () => [
      { key: 'time', label: 'time', width: 110, render: (m) => fmtTailTime(m.timestamp) },
      {
        key: 'channel',
        label: 'channel',
        width: 170,
        render: (m) => m.channel,
        titleOf: (m) => m.channel,
      },
      {
        key: 'payload',
        label: 'payload',
        render: (m) => m.payload,
        titleOf: (m) => (m.payload.length > 400 ? `${m.payload.slice(0, 400)}…` : m.payload),
      },
    ],
    [],
  );

  const listening = st.channels.length > 0;
  const add = () => {
    const name = channelInput.trim();
    if (!name) return;
    setChannelInput('');
    void listen(tabId, name);
  };

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--wb-content)]">
      <ViewToolbar>
        <Badge tone="accent">listen</Badge>
        <input
          aria-label="Channel to listen to"
          className={`${FIELD} w-[190px]`}
          placeholder="channel name"
          value={channelInput}
          onChange={(e) => setChannelInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          spellCheck={false}
        />
        <Pill onClick={add} disabled={!channelInput.trim() || st.busy}>
          {st.busy ? 'Listening…' : 'Listen'}
        </Pill>
        <div className="flex min-w-0 items-center gap-1 overflow-hidden">
          {st.channels.map((c) => (
            <span
              key={c}
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--wb-control)] py-0.5 pl-2 pr-1 font-mono text-[12px]"
            >
              {c}
              <button
                type="button"
                aria-label={`Stop listening to ${c}`}
                title={`UNLISTEN ${c}`}
                className="grid h-4 w-4 place-items-center rounded-full hover:bg-[var(--wb-control-hover)]"
                onClick={() => void unlisten(tabId, c)}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
        <div className="flex-1" />
        <input
          aria-label="Filter messages"
          className={`${FIELD} w-[170px]`}
          placeholder="filter  (!not  channel:x)"
          value={st.filter}
          onChange={(e) => patch(tabId, { filter: e.target.value })}
          spellCheck={false}
        />
        <IconButton
          label={st.paused ? 'Resume' : 'Pause'}
          onClick={() => patch(tabId, { paused: !st.paused })}
          disabled={!listening}
          active={st.paused}
        >
          {st.paused ? <Play /> : <Pause />}
        </IconButton>
        <IconButton
          label="Clear messages"
          onClick={() => clear(tabId)}
          disabled={st.messages.length === 0}
        >
          <Trash2 />
        </IconButton>
        <IconButton label="Send a NOTIFY" onClick={() => setShowSend((v) => !v)} active={showSend}>
          <Send />
        </IconButton>
      </ViewToolbar>

      {showSend && <NotifySender defaultChannel={st.channels[0] ?? ''} readOnly={readOnly} />}

      {st.error && (
        <div
          role="alert"
          className="shrink-0 border-b border-[var(--wb-separator)] px-3 py-1.5 text-[13px] text-destructive"
        >
          {st.error}
        </div>
      )}

      {visible.length === 0 ? (
        st.busy ? (
          <EmptyState
            title={
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" /> Connecting the listener…
              </span>
            }
          />
        ) : listening ? (
          <EmptyState
            title={
              st.messages.length > 0
                ? 'No message matches the filter'
                : 'Waiting for notifications…'
            }
            hint={
              st.messages.length > 0 ? undefined : (
                <>
                  Run <span className="font-mono">NOTIFY {st.channels[0]}, 'hello'</span> from any
                  session.
                </>
              )
            }
          />
        ) : (
          <EmptyState
            title="Not listening"
            hint="Enter a channel name above. Plasma listens on its own connection, so your queries are not affected."
          />
        )
      ) : (
        <DataTable
          ariaLabel="Notifications"
          columns={columns}
          rows={visible}
          rowKey={(m) => String(m.seq)}
          selectedIndex={selectedIndex}
          onSelect={onSelect}
        />
      )}

      <ViewFooter>
        <span className="tabular-nums">
          {visible.length.toLocaleString()}
          {visible.length !== st.messages.length
            ? ` of ${st.messages.length.toLocaleString()}`
            : ''}{' '}
          {st.messages.length === 1 ? 'message' : 'messages'}
        </span>
        <span className="text-[12px] text-[var(--wb-text-3)]">
          · newest first, capped at {TAIL_MAX_MESSAGES.toLocaleString()}
        </span>
        {st.dropped > 0 && (
          <span className="text-[12px] text-[var(--status-staging)]" data-testid="tail-dropped">
            · {st.dropped.toLocaleString()} dropped
          </span>
        )}
        <div className="flex-1" />
        {st.paused && (
          <span className="text-[12px] text-[var(--wb-text-2)]">
            Paused — incoming messages are dropped
          </span>
        )}
      </ViewFooter>
    </main>
  );
}

function NotifySender({ defaultChannel, readOnly }: { defaultChannel: string; readOnly: boolean }) {
  const [channel, setChannel] = useState(defaultChannel);
  const [payload, setPayload] = useState('');
  const [note, setNote] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [sending, setSending] = useState(false);
  const tooBig = new TextEncoder().encode(payload).length > PG_NOTIFY_MAX_PAYLOAD_BYTES;

  const send = async () => {
    const name = channel.trim();
    if (!name || tooBig) return;
    setNote(null);
    setSending(true);
    try {
      // pg_notify wakes every listener: it goes through the same gate as any write.
      const gate = await useSession
        .getState()
        .confirmUserSqlDetailed(
          `SELECT pg_notify('${name.replace(/'/g, "''")}', '${payload.replace(/'/g, "''")}')`,
          { force: true, summary: `NOTIFY ${name}` },
        );
      if (!gate.ok) {
        setNote({ tone: 'err', text: gate.message });
        return;
      }
      await ipc.pgListen.notify(name, payload);
      setNote({ tone: 'ok', text: `Sent to ${name}.` });
    } catch (err) {
      setNote({
        tone: 'err',
        text: cleanIpcError(err instanceof Error ? err.message : String(err)),
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-[var(--wb-separator)] bg-[var(--wb-sidebar)] px-2.5 py-1.5 text-[13px]">
      <span className="text-[12px] text-[var(--wb-text-2)]">NOTIFY</span>
      <input
        aria-label="NOTIFY channel"
        className={`${FIELD} w-[160px]`}
        placeholder="channel"
        value={channel}
        onChange={(e) => setChannel(e.target.value)}
        spellCheck={false}
      />
      <input
        aria-label="NOTIFY payload"
        className={`${FIELD} min-w-0 flex-1`}
        placeholder='payload, e.g. {"id": 1}'
        value={payload}
        onChange={(e) => setPayload(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void send()}
        spellCheck={false}
      />
      <Pill onClick={() => void send()} disabled={!channel.trim() || sending || tooBig || readOnly}>
        {sending ? 'Sending…' : 'Send'}
      </Pill>
      {readOnly && (
        <span className="text-[12px] text-[var(--wb-text-2)]">Read-only connection</span>
      )}
      {tooBig && <span className="text-[12px] text-destructive">Payload over 8000 bytes</span>}
      {note && (
        <span
          className={
            note.tone === 'ok'
              ? 'text-[12px] text-[var(--wb-text-2)]'
              : 'text-[12px] text-destructive'
          }
        >
          {note.text}
        </span>
      )}
    </div>
  );
}
