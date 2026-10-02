import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useSession } from '@/stores/session';
import {
  type StoredSnippet,
  prefixTaken,
  snippetTabStops,
  suggestPrefix,
  upsertSnippet,
  validateSnippet,
} from '@shared/snippets';
import { useEffect, useState } from 'react';
import { type SnippetDraft, useSnippetEditor } from './snippet-editor-store';

let counter = 0;
const newId = () => `sn-${Date.now().toString(36)}-${(counter++).toString(36)}`;

/** Create / edit a user snippet. Mounted once in the app shell. */
export function SnippetEditorDialog() {
  const draft = useSnippetEditor((s) => s.draft);
  const close = useSnippetEditor((s) => s.close);
  return (
    <Dialog open={draft !== null} onOpenChange={(o) => !o && close()}>
      {draft && <SnippetForm initial={draft} onClose={close} />}
    </Dialog>
  );
}

function SnippetForm({ initial, onClose }: { initial: SnippetDraft; onClose: () => void }) {
  const stored = useSession((s) => s.settings.snippets) as StoredSnippet[];
  const updateSettings = useSession((s) => s.updateSettings);
  const [draft, setDraft] = useState(initial);
  const [prefixTouched, setPrefixTouched] = useState(Boolean(initial.prefix));
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    setDraft(initial);
    setPrefixTouched(Boolean(initial.prefix));
    setTouched(false);
  }, [initial]);

  const problem =
    validateSnippet(draft) ??
    (prefixTaken(stored, draft.prefix, draft.id)
      ? 'Another of your snippets already uses this prefix'
      : null);
  const stops = snippetTabStops(draft.body);

  const save = async () => {
    setTouched(true);
    if (problem) return;
    await updateSettings({ snippets: upsertSnippet(stored, draft, Date.now(), newId) });
    onClose();
  };

  return (
    <DialogContent className="max-w-xl">
      <DialogHeader>
        <DialogTitle>{initial.id ? 'Edit snippet' : 'New snippet'}</DialogTitle>
        <DialogDescription>
          Type the prefix in the editor and pick the snippet from the completions. Use{' '}
          <code className="font-mono">$1</code>, <code className="font-mono">${'{2:default}'}</code>{' '}
          for tab stops and <code className="font-mono">$0</code> for the final cursor.
        </DialogDescription>
      </DialogHeader>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="grid grid-cols-[1fr_140px] gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="snip-name">Name</Label>
            <Input
              id="snip-name"
              autoFocus
              value={draft.name}
              onChange={(e) => {
                const name = e.target.value;
                setDraft((d) => ({
                  ...d,
                  name,
                  prefix: prefixTouched ? d.prefix : suggestPrefix(name),
                }));
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="snip-prefix">Prefix</Label>
            <Input
              id="snip-prefix"
              value={draft.prefix}
              className="font-mono"
              onChange={(e) => {
                setPrefixTouched(true);
                setDraft((d) => ({ ...d, prefix: e.target.value }));
              }}
            />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="snip-desc">Description</Label>
          <Input
            id="snip-desc"
            value={draft.description}
            placeholder="Shown next to the completion"
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="snip-body">Body</Label>
          <textarea
            id="snip-body"
            value={draft.body}
            spellCheck={false}
            rows={9}
            onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
            className="w-full resize-y rounded-[7px] border-0 bg-[var(--wb-field)] p-2 font-mono text-[12px] text-[var(--wb-text)] shadow-[inset_0_0_0_1px_var(--wb-toolbar-group-edge)] outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--ring)]"
          />
          {stops.length > 0 && (
            <div className="text-[11px] text-[var(--wb-text-3)]">
              Tab stops: {stops.map((s) => `$${s}`).join(' → ')}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 pt-1">
          <span
            className="min-w-0 flex-1 text-[12px] text-destructive"
            role={touched && problem ? 'alert' : undefined}
          >
            {touched ? problem : null}
          </span>
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="sm">
            Save
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}
