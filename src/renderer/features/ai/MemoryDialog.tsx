import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/features/connection-manager/connection-fields';
import { cn } from '@/lib/cn';
import { relativeTime } from '@/lib/relative-time';
import { useMemory } from '@/stores/ai-memory';
import { useSession } from '@/stores/session';
import { useUpdateToasts } from '@/stores/update-toasts';
import {
  MEMORY_MAX_CHARS,
  MEMORY_MAX_NOTES,
  isMemoryEnabled,
  memorySourceLabel,
} from '@shared/ai-memory';
import type { MemoryNote } from '@shared/protocol';
import { BookMarked, Check, Pencil, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

/** Notes beyond this many get a search box. */
const SEARCH_FROM = 8;

/** Mounted once in the app shell: opens for the connection in `useMemory().viewing`. */
export function MemoryDialog() {
  const viewing = useMemory((s) => s.viewing);
  const close = useMemory((s) => s.close);
  return (
    <Dialog open={viewing !== null} onOpenChange={(o) => !o && close()}>
      {viewing && <MemoryBody id={viewing.id} name={viewing.name} />}
    </Dialog>
  );
}

const NO_NOTES: MemoryNote[] = [];

function MemoryBody({ id, name }: { id: string; name: string }) {
  const notes = useMemory((s) => s.notes[id] ?? NO_NOTES);
  const load = useMemory((s) => s.load);
  const add = useMemory((s) => s.add);
  const update = useMemory((s) => s.update);
  const remove = useMemory((s) => s.remove);
  const enabled = useSession((s) => isMemoryEnabled(id, s.settings));
  const updateSettings = useSession((s) => s.updateSettings);
  const map = useSession((s) => s.settings.connectionAiMemory);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  useEffect(() => {
    void load(id);
  }, [id, load]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? notes.filter((n) => n.text.toLowerCase().includes(q)) : notes;
  }, [notes, query]);

  const submit = async () => {
    if (!draft.trim()) return;
    const res = await add(id, draft, 'user');
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setDraft('');
    setError(null);
  };

  const saveEdit = async () => {
    if (!editing) return;
    const res = await update(id, editing.id, editing.text);
    if (!res.ok) {
      setEditError(res.error);
      return;
    }
    setEditing(null);
    setEditError(null);
  };

  const del = async (n: MemoryNote) => {
    await remove(id, n.id);
    const source = n.source === 'user' || n.source === 'agent' ? n.source : 'user';
    useUpdateToasts.getState().push(
      {
        tone: 'info',
        title: 'Note deleted',
        actions: [
          {
            label: 'Undo',
            run: () => {
              // Same text and author; it comes back as the newest note.
              void add(id, n.text, source);
            },
          },
        ],
      },
      8000,
    );
  };

  return (
    <DialogContent className="max-w-[520px]" data-testid="ai-memory-dialog">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <BookMarked className="h-4 w-4 text-[var(--wb-text-2)]" aria-hidden />
          Memory for {name}
        </DialogTitle>
        <DialogDescription>
          Short notes the assistant reads with every request about this database.
        </DialogDescription>
      </DialogHeader>

      <div className="flex items-center justify-between gap-3 rounded-[8px] bg-[var(--wb-control)] px-3 py-2 text-[13px] text-[var(--wb-text)]">
        <span>
          Use memory for this connection
          <span className="block text-[12px] text-[var(--wb-text-2)]">
            {enabled ? 'Notes are sent with AI requests.' : 'Off: no notes are sent.'}
          </span>
        </span>
        <Switch
          data-testid="ai-memory-toggle"
          aria-label="Use memory for this connection"
          checked={enabled}
          onCheckedChange={(v) =>
            void updateSettings({ connectionAiMemory: { ...(map ?? {}), [id]: v } })
          }
        />
      </div>

      <form
        className="flex flex-col gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="flex gap-2">
          <Input
            data-testid="ai-memory-input"
            value={draft}
            maxLength={MEMORY_MAX_CHARS * 2}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            placeholder="Add a note, e.g. orders.amount is in cents"
            aria-label="New note"
            aria-invalid={error ? true : undefined}
          />
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            data-testid="ai-memory-add"
            disabled={!draft.trim() || notes.length >= MEMORY_MAX_NOTES}
          >
            Add note
          </Button>
        </div>
        {error && (
          <div className="text-[12px] text-destructive" role="alert">
            {error}
          </div>
        )}
      </form>

      {notes.length > SEARCH_FROM && (
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search notes"
          aria-label="Search notes"
          data-testid="ai-memory-search"
        />
      )}

      {notes.length === 0 ? (
        <div className="rounded-[8px] border border-dashed border-[var(--wb-toolbar-group-edge)] px-3 py-4 text-[13px] text-[var(--wb-text-2)]">
          <div className="font-medium text-[var(--wb-text)]">No notes yet.</div>
          <div className="mt-1">
            Write what the assistant cannot guess, like “active customer = status 'A' and an order
            in the last 90 days” or “ignore schema legacy_*”. It may also suggest notes as you chat.
          </div>
        </div>
      ) : (
        <ul
          className="flex max-h-[320px] flex-col gap-1.5 overflow-y-auto"
          data-testid="ai-memory-list"
          aria-label="Notes"
        >
          {shown.length === 0 && (
            <li className="px-1 py-2 text-[12px] text-[var(--wb-text-2)]">No note matches.</li>
          )}
          {shown.map((n) => (
            <li
              key={n.id}
              data-testid="ai-memory-item"
              className="group/note rounded-[8px] bg-[var(--wb-field)] px-3 py-2 shadow-[inset_0_0_0_1px_var(--wb-toolbar-group-edge)]"
            >
              {editing?.id === n.id ? (
                <form
                  className="flex flex-col gap-1.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveEdit();
                  }}
                >
                  <Input
                    autoFocus
                    value={editing.text}
                    onChange={(e) => {
                      setEditing({ id: n.id, text: e.target.value });
                      setEditError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.stopPropagation();
                        setEditing(null);
                        setEditError(null);
                      }
                    }}
                    aria-label="Edit note"
                    aria-invalid={editError ? true : undefined}
                  />
                  {editError && (
                    <div className="text-[12px] text-destructive" role="alert">
                      {editError}
                    </div>
                  )}
                  <div className="flex gap-1.5">
                    <Button type="submit" size="sm" variant="secondary" aria-label="Save note">
                      <Check />
                      Save
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditing(null);
                        setEditError(null);
                      }}
                    >
                      <X />
                      Cancel
                    </Button>
                  </div>
                </form>
              ) : (
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] leading-snug text-[var(--wb-text)] [overflow-wrap:anywhere]">
                      {n.text}
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 text-[11px] text-[var(--wb-text-3)]">
                      <span
                        className={cn(
                          'rounded-[4px] bg-[var(--wb-control)] px-1.5 py-px text-[var(--wb-text-2)]',
                        )}
                        data-testid="ai-memory-source"
                      >
                        {memorySourceLabel(n.source)}
                      </span>
                      <span>{relativeTime(n.updatedAt)}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="h-6 w-6 text-[var(--wb-text-2)]"
                      aria-label={`Edit note: ${n.text.slice(0, 40)}`}
                      title="Edit"
                      onClick={() => setEditing({ id: n.id, text: n.text })}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="h-6 w-6 text-[var(--wb-text-2)]"
                      aria-label={`Delete note: ${n.text.slice(0, 40)}`}
                      title="Delete"
                      onClick={() => void del(n)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="text-[11px] text-[var(--wb-text-3)]">
        {notes.length} of {MEMORY_MAX_NOTES} notes. Passwords and keys are never kept.
      </div>
    </DialogContent>
  );
}
