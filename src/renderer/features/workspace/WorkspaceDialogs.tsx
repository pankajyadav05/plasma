import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useSession } from '@/stores/session';
import { openConnectionString, useWorkspace } from '@/stores/workspace';
import { X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { applyWorkspaceNotebook } from './WorkspaceSection';

/** Dialogs and notices of the workspace / deep-link features, mounted once in App. */
export function WorkspaceDialogs() {
  return (
    <>
      <PasswordDialog />
      <ConflictDialog />
      <SaveQueryDialog />
      <ConnectionStringDialog />
      <NotebookReplaceDialog />
      <Notice />
    </>
  );
}

function PasswordDialog() {
  const profile = useWorkspace((s) => s.passwordPrompt);
  const submit = useWorkspace((s) => s.submitPassword);
  const cancel = useWorkspace((s) => s.cancelPassword);
  const [password, setPassword] = useState('');
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset whenever a new prompt opens
  useEffect(() => setPassword(''), [profile?.id]);

  return (
    <Dialog open={profile !== null} onOpenChange={(o) => !o && cancel()}>
      <DialogContent className="max-w-[420px]" data-testid="workspace-password">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit(password);
          }}
        >
          <DialogHeader>
            <DialogTitle>Password for {profile?.name}</DialogTitle>
            <DialogDescription>
              {profile?.summary}. It is kept in your OS keychain for this workspace and is never
              written to the workspace folder.
            </DialogDescription>
          </DialogHeader>
          <div className="py-3">
            <Label htmlFor="ws-password">Password</Label>
            <Input
              id="ws-password"
              type="password"
              autoFocus
              autoComplete="off"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Leave empty to connect without a password"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={cancel}>
              Cancel
            </Button>
            <Button type="submit" variant="primary">
              Connect
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ConflictDialog() {
  const conflict = useWorkspace((s) => s.conflict);
  const resolve = useWorkspace((s) => s.resolveConflict);
  return (
    <ConfirmDialog
      open={conflict !== null}
      onOpenChange={(o) => !o && void resolve(false)}
      title="File changed on disk"
      description={`"${conflict?.what}" was edited outside Plasma since you opened it (a teammate, git, or another editor). Overwrite it with your version?`}
      confirmLabel="Overwrite"
      onConfirm={() => void resolve(true)}
    />
  );
}

function SaveQueryDialog() {
  const target = useWorkspace((s) => s.saveDialog);
  const snapshot = useWorkspace((s) => s.snapshot);
  const saveTabAs = useWorkspace((s) => s.saveTabAs);
  const tab = useSession((s) => s.tabs.find((t) => t.id === target?.tabId));
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [description, setDescription] = useState('');
  const folders = useMemo(
    () => [
      ...new Set(
        (snapshot?.queries ?? [])
          .map((q) => q.path.split('/').slice(0, -1).join('/'))
          .filter((f) => f.length > 0),
      ),
    ],
    [snapshot?.queries],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset per opened dialog
  useEffect(() => {
    setName(tab && tab.title !== 'Query' ? tab.title : '');
    setFolder('');
    setDescription('');
  }, [target?.tabId]);

  const close = () => useWorkspace.setState({ saveDialog: null });
  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-[440px]" data-testid="workspace-save-query">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!target || !name.trim()) return;
            void saveTabAs(target.tabId, {
              name: name.trim(),
              folder: folder.trim(),
              description: description.trim() || undefined,
            });
            close();
          }}
        >
          <DialogHeader>
            <DialogTitle>Save to workspace</DialogTitle>
            <DialogDescription>
              Writes a plain .sql file under {snapshot?.name}/.plasma/queries/ that you can commit.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-3">
            <div>
              <Label htmlFor="wsq-name">Name</Label>
              <Input
                id="wsq-name"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="wsq-folder">Folder (optional)</Label>
              <Input
                id="wsq-folder"
                list="wsq-folders"
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                placeholder="reports/monthly"
              />
              <datalist id="wsq-folders">
                {folders.map((f) => (
                  <option key={f} value={f} />
                ))}
              </datalist>
            </div>
            <div>
              <Label htmlFor="wsq-desc">Description (optional)</Label>
              <Input
                id="wsq-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!name.trim()}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ConnectionStringDialog() {
  const open = useWorkspace((s) => s.connectionStringOpen);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setText('');
      setError(null);
    }
  }, [open]);
  const close = () => useWorkspace.setState({ connectionStringOpen: false });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-[480px]" data-testid="connection-string-dialog">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const problem = openConnectionString(text);
            if (problem) setError(problem);
            else close();
          }}
        >
          <DialogHeader>
            <DialogTitle>Open connection string</DialogTitle>
            <DialogDescription>
              Paste a postgres://, mysql://, redis:// or https:// URL, or a plasma:// link. The New
              Connection form opens pre-filled; nothing connects until you press Connect.
            </DialogDescription>
          </DialogHeader>
          <div className="py-3">
            <Input
              autoFocus
              spellCheck={false}
              autoComplete="off"
              aria-label="Connection string"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setError(null);
              }}
              placeholder="postgres://user@host:5432/database?sslmode=require"
            />
            {error && <p className="mt-2 text-[12px] text-[var(--status-prod)]">{error}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!text.trim()}>
              Continue
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function NotebookReplaceDialog() {
  const file = useWorkspace((s) => s.notebookReplace);
  return (
    <ConfirmDialog
      open={file !== null}
      onOpenChange={(o) => !o && useWorkspace.setState({ notebookReplace: null })}
      title="Replace your notebook?"
      description="This connection already has a notebook draft with content. Opening the workspace notebook replaces it."
      confirmLabel="Replace"
      onConfirm={() => file && void applyWorkspaceNotebook(file)}
    />
  );
}

function Notice() {
  const notice = useWorkspace((s) => s.notice);
  const dismiss = useWorkspace((s) => s.dismissNotice);
  if (!notice) return null;
  return (
    <div
      role="alert"
      data-testid="workspace-notice"
      className="fixed bottom-4 right-4 z-[60] flex max-w-[420px] items-start gap-2 rounded-[8px] bg-[var(--wb-sidebar)] px-3 py-2 text-[13px] text-[var(--wb-text)] shadow-lg ring-1 ring-[var(--wb-toolbar-group-edge)]"
    >
      <span className="min-w-0 flex-1 break-words">{notice}</span>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="grid h-5 w-5 shrink-0 cursor-pointer place-items-center text-[var(--wb-text-2)] hover:text-[var(--wb-text)]"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
