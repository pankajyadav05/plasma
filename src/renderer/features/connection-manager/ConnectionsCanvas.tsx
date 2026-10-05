import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { IconButton } from '@/components/ui/workbench';
import { SidebarSearch } from '@/features/sidebar/sidebar-parts';
import { cn } from '@/lib/cn';
import { ENGINE_ICON } from '@/lib/engine-meta';
import { pickAndOpenDataFiles } from '@/stores/data-files';
import { useSession } from '@/stores/session';
import { useConnectionDraft } from '@/stores/workspace';
import type { ParsedConnectionUrl } from '@shared/connection-url';
import type { ConnectionConfig, ConnectionEngine, SavedConnection } from '@shared/protocol';
import { Check, Copy, Plus, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConnectionEditor, type ConnectionEditorHandle } from './ConnectionEditor';
import { EnginePicker } from './EnginePicker';
import { freshConfig, isPlaceholderName } from './connection-defaults';
import { groupConnections } from './connection-groups';
import { type EnvTag, TAG_COLOR } from './env-tags';

/** Host, port and database - or the file path - for the list's second line. */
function endpointLabel(c: SavedConnection): string {
  const engine = c.engine ?? 'postgres';
  if (engine === 'sqlite' || engine === 'duckdb') return c.database || 'No file';
  const hostPort = `${c.host}:${c.port}`;
  return engine === 'postgres' || engine === 'mysql' || engine === 'clickhouse'
    ? c.database
      ? `${hostPort}/${c.database}`
      : hostPort
    : hostPort;
}

/**
 * The Connections screen: saved connections on the left, and on the right
 * either the engine picker (new connection) or the form (new or saved).
 * Replaces the old modal; `openDialog` / `editConnection` still open it.
 */
export function ConnectionsCanvas() {
  const savedConnections = useSession((s) => s.savedConnections);
  const prefill = useSession((s) => s.dialogPrefill);
  const nonce = useSession((s) => s.dialogNonce);
  const openDialog = useSession((s) => s.openDialog);
  const closeDialog = useSession((s) => s.closeDialog);
  const editConnection = useSession((s) => s.editConnection);
  const activeId = useSession((s) => s.activeConfig?.id ?? null);
  const connected = useSession((s) => s.connectionState === 'connected');
  const tags = useSession((s) => s.settings.connectionTags);
  const draftId = useConnectionDraft((s) => s.draftId);

  // A deep-link / pasted-URL prefill is a NEW connection, not an edit of a saved one.
  const editingSaved = Boolean(prefill) && prefill?.id !== draftId;
  const [query, setQuery] = useState('');

  // New connections start on the picker unless a prefill already chose an engine.
  const [picking, setPicking] = useState(!prefill);
  const [created, setCreated] = useState<ConnectionConfig | null>(null);
  const [urlFocus, setUrlFocus] = useState(0);
  const [status, setStatus] = useState({ name: '', dirty: false });
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const [copied, setCopied] = useState(false);
  const editorRef = useRef<ConnectionEditorHandle>(null);
  const dirtyRef = useRef(false);
  dirtyRef.current = status.dirty;

  // Each openDialog starts over: a prefill goes straight to the form, none to the picker.
  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce is the trigger.
  useEffect(() => {
    setPicking(!prefill);
    setCreated(null);
    setStatus({ name: prefill?.name ?? '', dirty: false });
  }, [nonce]);

  // If the connection being edited disappears (deleted), fall back to a new one.
  const seenSaved = useRef<string | null>(null);
  useEffect(() => {
    if (!editingSaved || !prefill) {
      seenSaved.current = null;
      return;
    }
    const present = savedConnections.some((c) => c.id === prefill.id);
    if (present) seenSaved.current = prefill.id;
    else if (seenSaved.current === prefill.id) {
      seenSaved.current = null;
      openDialog();
    }
  }, [savedConnections, editingSaved, prefill, openDialog]);

  const guard = useCallback((action: () => void) => {
    if (dirtyRef.current) setPendingAction(() => action);
    else action();
  }, []);

  const onStatus = useCallback((s: { name: string; dirty: boolean }) => setStatus(s), []);

  const creating = !editingSaved;
  const editor = editingSaved ? prefill : (created ?? prefill);
  const showPicker = creating && (picking || !editor);

  const pickEngine = (engine: ConnectionEngine) => {
    if (editor && editorRef.current) editorRef.current.applyEngine(engine);
    else setCreated(freshConfig(engine));
    setPicking(false);
    requestAnimationFrame(() => editorRef.current?.focusFirst());
  };

  const pickUrl = (parsed: ParsedConnectionUrl) => {
    if (editor && editorRef.current) editorRef.current.applyParsed(parsed);
    else {
      const base = freshConfig(parsed.engine);
      setCreated({
        ...base,
        ...parsed,
        name: isPlaceholderName(base.name) ? parsed.host : base.name,
      });
    }
    setPicking(false);
    requestAnimationFrame(() => editorRef.current?.focusFirst());
  };

  const startNew = (focusUrl = false) =>
    guard(() => {
      openDialog();
      if (focusUrl) setUrlFocus((n) => n + 1);
    });

  const copyUrl = async () => {
    const url = editorRef.current?.getUrl();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be unavailable (permissions); nothing useful to show.
    }
  };

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      q
        ? savedConnections.filter(
            (c) =>
              c.name.toLowerCase().includes(q) ||
              c.host.toLowerCase().includes(q) ||
              c.database.toLowerCase().includes(q),
          )
        : savedConnections,
    [savedConnections, q],
  );
  const groups = useMemo(() => groupConnections(filtered), [filtered]);

  const title = showPicker
    ? 'New connection'
    : editingSaved
      ? status.name.trim() || 'Connection'
      : 'New connection';

  return (
    <div className="flex min-h-0 min-w-0 flex-1 bg-[var(--wb-content)]">
      <nav
        aria-label="Saved connections"
        className="flex w-[260px] shrink-0 flex-col border-r border-[var(--wb-separator)] bg-[var(--wb-sidebar)]"
      >
        <div className="flex h-[38px] shrink-0 items-center gap-2 border-b border-[var(--wb-separator)] px-3">
          <h1 className="flex-1 text-[15px] font-semibold text-[var(--wb-text)]">Connections</h1>
          <IconButton variant="plain" label="New connection" onClick={() => startNew()}>
            <Plus />
          </IconButton>
        </div>
        <div className="flex shrink-0 px-2.5 py-2">
          <SidebarSearch
            value={query}
            onChange={setQuery}
            placeholder="Search connections…"
            ariaLabel="Search connections"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          {creating && (
            <ul className="mb-1">
              <li>
                <div
                  aria-current="true"
                  className="mx-2 flex h-9 items-center gap-2 rounded-[5px] bg-[var(--wb-selected)] px-2"
                >
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-[6px] bg-[var(--wb-control)] text-[var(--wb-text)]">
                    <Plus className="h-3.5 w-3.5" />
                  </span>
                  <span className="truncate text-[13px] text-[var(--wb-text)]">
                    {created || prefill ? status.name.trim() || 'New connection' : 'New connection'}
                  </span>
                </div>
              </li>
            </ul>
          )}
          {savedConnections.length === 0 ? (
            <p className="px-4 py-3 text-[12px] leading-snug text-[var(--wb-text-2)]">
              No saved connections yet. Pick a database on the right to add one.
            </p>
          ) : filtered.length === 0 ? (
            <p className="px-4 py-3 text-[12px] text-[var(--wb-text-2)]">
              Nothing matches "{query}".
            </p>
          ) : (
            groups.map((g) => (
              <div key={g.group ?? '__ungrouped'}>
                {g.group && (
                  <div className="px-4 pb-0.5 pt-2 text-[11px] font-semibold text-[var(--wb-text-2)]">
                    {g.group}
                  </div>
                )}
                <ul>
                  {g.items.map((c) => (
                    <ConnectionRow
                      key={c.id}
                      c={c}
                      selected={editingSaved && prefill?.id === c.id}
                      live={connected && activeId === c.id}
                      tag={tags?.[c.id] as EnvTag | undefined}
                      onPick={() =>
                        guard(() => {
                          if (!(editingSaved && prefill?.id === c.id)) void editConnection(c.id);
                        })
                      }
                    />
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>

        <div className="flex shrink-0 flex-col items-start gap-0.5 border-t border-[var(--wb-separator)] p-2">
          <Button variant="ghost" size="sm" onClick={() => startNew(true)}>
            Import from URL…
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void pickAndOpenDataFiles()}>
            Open data file…
          </Button>
        </div>
      </nav>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Connection">
        <header className="flex h-[38px] shrink-0 items-center gap-2 border-b border-[var(--wb-separator)] px-4">
          <h1 className="min-w-0 truncate text-[15px] font-semibold text-[var(--wb-text)]">
            {title}
          </h1>
          <div className="flex-1" />
          {!showPicker && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void copyUrl()}
              title="Copy a connection URL (without the password)"
            >
              {copied ? <Check /> : <Copy />}
              {copied ? 'Copied' : 'Copy URL'}
            </Button>
          )}
          <IconButton
            variant="plain"
            label="Close connections"
            title="Close (Esc)"
            onClick={closeDialog}
          >
            <X />
          </IconButton>
        </header>

        {showPicker && (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <EnginePicker
              key={nonce}
              current={editor ? ((editor.engine ?? 'postgres') as ConnectionEngine) : undefined}
              focusNonce={urlFocus}
              onPickEngine={pickEngine}
              onPickUrl={pickUrl}
            />
            {editor && (
              <div className="mx-auto max-w-[720px] px-6 pb-6">
                <Button variant="ghost" size="sm" onClick={() => setPicking(false)}>
                  Back to the form
                </Button>
              </div>
            )}
          </div>
        )}

        {editor && (
          <div className={cn('flex min-h-0 flex-1 flex-col', showPicker && 'hidden')}>
            <ConnectionEditor
              // A new nonce (or a new engine pick before first mount) remounts with fresh state.
              key={`${nonce}:${editor.id}`}
              ref={editorRef}
              initial={editor}
              isEditing={editingSaved}
              focusOnMount={Boolean(created)}
              onChangeEngine={creating ? () => setPicking(true) : undefined}
              onStatus={onStatus}
              guard={guard}
            />
          </div>
        )}
      </section>

      <ConfirmDialog
        open={pendingAction !== null}
        onOpenChange={(o) => !o && setPendingAction(null)}
        title="Discard unsaved changes?"
        description="This connection has changes that are not saved."
        confirmLabel="Discard"
        onConfirm={() => {
          const run = pendingAction;
          setPendingAction(null);
          // Clear first so the switch is not blocked by the same guard.
          dirtyRef.current = false;
          run?.();
        }}
      />
    </div>
  );
}

function ConnectionRow({
  c,
  selected,
  live,
  tag,
  onPick,
}: {
  c: SavedConnection;
  selected: boolean;
  live: boolean;
  tag: EnvTag | undefined;
  onPick: () => void;
}) {
  const Icon = ENGINE_ICON[c.engine ?? 'postgres'];
  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'mx-2 flex h-9 w-[calc(100%-1rem)] cursor-pointer items-center gap-2 rounded-[5px] px-2 text-left transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          selected
            ? 'bg-[var(--wb-selected)]'
            : 'hover:bg-[color-mix(in_srgb,var(--wb-text)_6%,transparent)]',
        )}
      >
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-[6px] bg-[var(--wb-control)] text-[var(--wb-text-2)]">
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] leading-4 text-[var(--wb-text)]">
            {c.name}
          </span>
          <span className="block truncate font-mono text-[11px] leading-4 text-[var(--wb-text-3)]">
            {endpointLabel(c)}
          </span>
        </span>
        {live && (
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--wb-accent)]"
            title="Connected"
            role="img"
            aria-label="Connected"
          />
        )}
        {tag && TAG_COLOR[tag] && (
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: TAG_COLOR[tag] }}
            title={tag}
            role="img"
            aria-label={`Environment: ${tag}`}
          />
        )}
      </button>
    </li>
  );
}
