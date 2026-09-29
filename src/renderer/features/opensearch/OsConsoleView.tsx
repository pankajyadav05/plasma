import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { EmptyState, ViewFooter, ViewToolbar } from '@/components/ui/view-parts';
import { MenuItem, Pill } from '@/components/ui/workbench';
import { ipc } from '@/lib/ipc';
import { kbd } from '@/lib/platform';
import { OS_HTTP_METHODS, type OsHttpMethod, isOsReadRequest } from '@shared/os-write-policy';
import { ChevronDown, Lock } from 'lucide-react';
import { useCallback, useState } from 'react';
import { OsCodeEditor } from './OsCodeEditor';
import { formatMs, isDestructiveRequest } from './os-format';
import {
  JsonBody,
  OsBadge,
  QueryErrorPanel,
  QueryLibraryMenu,
  RunPill,
  RunningState,
  TimeoutMenu,
  errMessage,
  isRunShortcut,
} from './os-parts';
import {
  type OsConsoleTabState,
  defaultConsoleState,
  newOsId,
  useConsoleTab,
  useOsStore,
} from './os-store';
import { confirmOsWrite, useOsWriteAccess } from './os-write';

const EXAMPLES: Array<{ method: OsHttpMethod; path: string; label: string }> = [
  { method: 'GET', path: '/_cluster/health', label: 'Cluster health' },
  { method: 'GET', path: '/_cat/indices?v&s=index', label: 'Indices' },
  { method: 'GET', path: '/_cat/nodes?v', label: 'Nodes' },
  { method: 'GET', path: '/_cat/shards?v', label: 'Shards' },
  { method: 'GET', path: '/_cluster/settings?include_defaults=false', label: 'Cluster settings' },
  { method: 'GET', path: '/_tasks?detailed', label: 'Tasks' },
];

/**
 * Dev Tools console (O14): method + path + JSON body → raw response.
 * Reads run freely; anything else needs edit mode on a writable
 * connection (main and the worker refuse writes on read-only
 * connections too) and destructive / prod calls are confirmed.
 */
export function OsConsoleView({ tabId }: { tabId: string }) {
  const st = useConsoleTab(tabId);
  const patch = useCallback(
    (p: Partial<OsConsoleTabState>) => useOsStore.getState().patchConsole(tabId, p),
    [tabId],
  );
  const getSt = useCallback(
    () => useOsStore.getState().console[tabId] ?? defaultConsoleState(),
    [tabId],
  );
  const addHistory = useOsStore((s) => s.addHistory);
  const access = useOsWriteAccess();
  const [methodMenu, setMethodMenu] = useState(false);
  const [exampleMenu, setExampleMenu] = useState(false);

  const body = st.body.trim() ? st.body : undefined;
  const isRead = isOsReadRequest(st.method, st.path, body);

  const run = async () => {
    const cur = getSt();
    if (cur.running || !cur.path.trim()) return;
    const curBody = cur.body.trim() ? cur.body : undefined;
    if (!isOsReadRequest(cur.method, cur.path, curBody)) {
      if (!access.canWrite) {
        patch({ error: access.reason ?? 'writes are disabled', response: null });
        return;
      }
      const ok = await confirmOsWrite({
        title: `${cur.method} ${cur.path}?`,
        description: 'This request can change the cluster.',
        confirmLabel: 'Send request',
        destructive: isDestructiveRequest(cur.method, cur.path),
      });
      if (!ok) return;
    }
    const requestId = newOsId('console');
    patch({ running: true, requestId, error: null });
    try {
      const response = await ipc.os.request({
        method: cur.method,
        path: cur.path.trim(),
        body: curBody,
        timeoutMs: cur.timeoutMs,
        requestId,
      });
      if (getSt().requestId !== requestId) return;
      patch({ running: false, requestId: null, response });
      addHistory({
        kind: 'console',
        text: cur.body,
        method: cur.method,
        path: cur.path.trim(),
        ok: response.status < 400,
      });
    } catch (err) {
      if (getSt().requestId !== requestId) return;
      const msg = errMessage(err);
      patch({
        running: false,
        requestId: null,
        response: null,
        error: /request cancelled/i.test(msg) ? 'Request cancelled' : msg,
      });
      addHistory({
        kind: 'console',
        text: cur.body,
        method: cur.method,
        path: cur.path.trim(),
        ok: false,
      });
    }
  };

  const cancel = () => {
    const id = getSt().requestId;
    if (id) void ipc.os.cancel(id).catch(() => undefined);
  };

  const status = st.response?.status;

  return (
    <main
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--wb-content)]"
      onKeyDown={(e) => {
        if (isRunShortcut(e)) {
          e.preventDefault();
          void run();
        }
      }}
    >
      <ViewToolbar className="min-w-0 overflow-hidden">
        <Popover open={methodMenu} onOpenChange={setMethodMenu}>
          <PopoverTrigger asChild>
            <Pill aria-label={`Method ${st.method}`} className="w-[88px] justify-between font-mono">
              {st.method}
              <ChevronDown className="opacity-70" />
            </Pill>
          </PopoverTrigger>
          <PopoverContent align="start" sideOffset={4} className="w-[140px] p-1" role="menu">
            {OS_HTTP_METHODS.map((m) => (
              <MenuItem
                key={m}
                label={<span className="font-mono">{m}</span>}
                checked={st.method === m}
                onClick={() => {
                  patch({ method: m });
                  setMethodMenu(false);
                }}
              />
            ))}
          </PopoverContent>
        </Popover>
        <form
          className="min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <input
            value={st.path}
            onChange={(e) => patch({ path: e.target.value })}
            aria-label="Request path"
            spellCheck={false}
            placeholder="/_cat/indices?v"
            className="h-6 w-full rounded-[6px] border-0 bg-[var(--wb-field)] px-2 font-mono text-[13px] text-[var(--wb-text)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--wb-text)_8%,transparent)] outline-none placeholder:text-[var(--wb-text-3)] focus:shadow-[0_0_0_2px_color-mix(in_srgb,var(--wb-accent)_55%,transparent)]"
          />
        </form>
        {!isRead && (
          <span
            className="flex shrink-0 items-center gap-1 text-[12px] text-[var(--wb-text-2)]"
            title={access.reason ?? 'This request writes to the cluster'}
          >
            {!access.canWrite && <Lock className="h-3.5 w-3.5" />}
            <OsBadge tone={access.canWrite ? 'warn' : 'neutral'}>write</OsBadge>
          </span>
        )}
        <Popover open={exampleMenu} onOpenChange={setExampleMenu}>
          <PopoverTrigger asChild>
            <Pill>
              Examples
              <ChevronDown className="opacity-70" />
            </Pill>
          </PopoverTrigger>
          <PopoverContent align="end" sideOffset={4} className="w-[260px] p-1" role="menu">
            {EXAMPLES.map((ex) => (
              <MenuItem
                key={ex.path}
                label={ex.label}
                hint={ex.method}
                onClick={() => {
                  patch({ method: ex.method, path: ex.path, body: '' });
                  setExampleMenu(false);
                }}
              />
            ))}
          </PopoverContent>
        </Popover>
        <QueryLibraryMenu
          kinds={['console']}
          current={{ kind: 'console', text: st.body, method: st.method, path: st.path }}
          onPick={(e) =>
            patch({
              method: (e.method as OsHttpMethod) ?? 'GET',
              path: e.path ?? st.path,
              body: e.text,
            })
          }
        />
        <TimeoutMenu value={st.timeoutMs} onChange={(ms) => patch({ timeoutMs: ms })} />
        <RunPill
          running={st.running}
          disabled={!st.path.trim()}
          onRun={() => void run()}
          onCancel={cancel}
        />
      </ViewToolbar>

      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <section
          className="flex min-h-0 min-w-0 flex-1 flex-col border-r border-[var(--wb-separator)]"
          aria-label="Request body"
        >
          <div className="flex h-7 shrink-0 items-center px-2.5 text-[12px] text-[var(--wb-text-2)]">
            Body (JSON, or NDJSON for _bulk / _msearch)
          </div>
          <OsCodeEditor
            value={st.body}
            onChange={(v) => patch({ body: v })}
            onRun={() => void run()}
            language="json"
            ariaLabel="Request body"
            className="min-h-0 flex-1"
          />
        </section>
        <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Response">
          <div className="flex h-7 shrink-0 items-center gap-2 whitespace-nowrap px-2.5 text-[12px] text-[var(--wb-text-2)]">
            <span>Response</span>
            {status !== undefined && (
              <OsBadge tone={status >= 500 ? 'danger' : status >= 400 ? 'warn' : 'neutral'}>
                {status}
              </OsBadge>
            )}
          </div>
          {st.error ? (
            <QueryErrorPanel message={st.error} title="Request failed" />
          ) : st.running ? (
            <RunningState label="Sending…" />
          ) : st.response ? (
            <JsonBody value={st.response.body} />
          ) : (
            <EmptyState
              title="No response yet"
              hint={`Pick a method and path, then press Run (${kbd('⏎')}).`}
            />
          )}
        </section>
      </div>

      {st.response && !st.error && (
        <ViewFooter className="whitespace-nowrap">
          <span className="tabular-nums">HTTP {st.response.status}</span>
          <span className="tabular-nums">{formatMs(st.response.durationMs)}</span>
          <div className="flex-1" />
          <Pill
            onClick={() =>
              void navigator.clipboard.writeText(JSON.stringify(st.response?.body, null, 2))
            }
          >
            Copy response
          </Pill>
        </ViewFooter>
      )}
    </main>
  );
}
