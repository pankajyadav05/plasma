import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Pill } from '@/components/ui/workbench';
import { ipc } from '@/lib/ipc';
import { prettyJsonText, topLevelJsonValue } from '@shared/json-bigint';
import { AlertTriangle, Save, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { OsCodeEditor } from './OsCodeEditor';
import { OsBadge, errMessage } from './os-parts';
import { useOsStore } from './os-store';
import { confirmOsWrite, useOsWriteAccess } from './os-write';

const FIELD_CLASS =
  'h-[26px] rounded-[6px] border-0 bg-[var(--wb-field)] px-2 font-mono text-[13px] text-[var(--wb-text)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--wb-text)_12%,transparent)] placeholder:text-[var(--wb-text-3)] focus-visible:ring-0 focus-visible:shadow-[0_0_0_2px_color-mix(in_srgb,var(--wb-accent)_55%,transparent)]';

const DIALOG_CLASS =
  'gap-3 rounded-[10px] border-[var(--wb-separator)] bg-[var(--wb-content)] p-5 text-[13px] text-[var(--wb-text)]';

/** Global OpenSearch dialogs: write confirmation + document editor. */
export function OsDialogs() {
  return (
    <>
      <OsConfirmDialog />
      <OsDocDialog />
    </>
  );
}

/**
 * Write confirmation (S1). Destructive writes always ask; on prod-tagged
 * connections every write asks. `typeToConfirm` adds type-the-name friction.
 */
function OsConfirmDialog() {
  const req = useOsStore((s) => s.confirm);
  const setConfirm = useOsStore((s) => s.setConfirm);
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (req) setTyped('');
  }, [req]);

  if (!req) return null;
  const close = (ok: boolean) => {
    setConfirm(null);
    req.resolve(ok);
  };
  const needsTyping = !!req.typeToConfirm;
  const matches = !needsTyping || typed === req.typeToConfirm;

  return (
    <Dialog open onOpenChange={(o) => !o && close(false)}>
      <DialogContent className={`max-w-[460px] ${DIALOG_CLASS}`}>
        <DialogHeader className="space-y-1">
          <DialogTitle>{req.title}</DialogTitle>
          <DialogDescription>{req.description}</DialogDescription>
        </DialogHeader>
        {req.prod && (
          <div className="flex items-center gap-2 rounded-[6px] bg-[color-mix(in_srgb,var(--destructive)_12%,transparent)] px-2.5 py-2 text-[12px]">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />
            <span>
              This connection is tagged <OsBadge tone="danger">prod</OsBadge>. The change applies to
              production data.
            </span>
          </div>
        )}
        {needsTyping && (
          <form
            className="flex flex-col gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (matches) close(true);
            }}
          >
            <label htmlFor="os-confirm-type" className="text-[12px] text-[var(--wb-text-2)]">
              Type <span className="font-mono text-[var(--wb-text)]">{req.typeToConfirm}</span> to
              confirm
            </label>
            <Input
              id="os-confirm-type"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className={FIELD_CLASS}
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
          </form>
        )}
        <DialogFooter className="gap-2 pt-1 sm:space-x-0">
          <Pill className="h-7 px-3" onClick={() => close(false)}>
            Cancel
          </Pill>
          <Button
            variant={req.destructive ? 'destructive' : 'secondary'}
            className="h-7 gap-1.5 rounded-[6px] px-3 text-[13px] font-normal"
            onClick={() => close(true)}
            disabled={!matches}
            autoFocus={!needsTyping}
          >
            {req.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface LoadedDoc {
  text: string;
  seqNo: number | null;
  primaryTerm: number | null;
}

/**
 * View / edit / create one document as JSON (O13). Saves use optimistic
 * concurrency (`if_seq_no` + `if_primary_term`) so a concurrent change
 * isn't silently overwritten. Editing is disabled unless writes are
 * allowed; deletes and prod writes go through the confirm dialog.
 */
function OsDocDialog() {
  const target = useOsStore((s) => s.doc);
  const openDoc = useOsStore((s) => s.openDoc);
  const access = useOsWriteAccess();
  const [doc, setDoc] = useState<LoadedDoc | null>(null);
  const [text, setText] = useState('');
  const [newId, setNewId] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);

  useEffect(() => {
    setDoc(null);
    setError(null);
    setJsonError(null);
    setNewId('');
    if (!target) return;
    if (target.id === null) {
      setText('{\n  \n}\n');
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const res = await ipc.os.request({
          method: 'GET',
          path: `/${encodeURIComponent(target.index)}/_doc/${encodeURIComponent(target.id ?? '')}`,
        });
        if (cancelled) return;
        const body = res.body as {
          _source?: unknown;
          _seq_no?: number;
          _primary_term?: number;
          found?: boolean;
          error?: unknown;
        };
        if (res.status >= 400 || body.found === false) {
          setError(res.status === 404 ? 'Document not found' : JSON.stringify(body.error ?? body));
          return;
        }
        // A source with an integer beyond 2^53 is read from the raw response text: re-stringifying
        // the parsed body would turn that number into a string.
        const rawSource = res.rawBody ? topLevelJsonValue(res.rawBody, '_source') : null;
        const pretty = `${rawSource ? prettyJsonText(rawSource) : JSON.stringify(body._source ?? {}, null, 2)}\n`;
        setDoc({
          text: pretty,
          seqNo: typeof body._seq_no === 'number' ? body._seq_no : null,
          primaryTerm: typeof body._primary_term === 'number' ? body._primary_term : null,
        });
        setText(pretty);
      } catch (err) {
        if (!cancelled) setError(errMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target]);

  if (!target) return null;
  const creating = target.id === null;
  const dirty = creating ? text.trim() !== '{\n  \n}'.trim() : doc !== null && text !== doc.text;
  const close = () => !busy && openDoc(null);
  const indexPath = encodeURIComponent(target.index);

  const onChange = (v: string) => {
    setText(v);
    try {
      const parsed = JSON.parse(v) as unknown;
      setJsonError(
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? null
          : 'A document must be a JSON object',
      );
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : String(err));
    }
  };

  const onSave = async () => {
    if (jsonError) return;
    const ok = await confirmOsWrite({
      title: creating ? 'Create document?' : 'Save document?',
      description: creating
        ? `A new document will be indexed into ${target.index}.`
        : `Document ${target.id} in ${target.index} will be replaced.`,
      confirmLabel: creating ? 'Create' : 'Save',
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      let method: 'POST' | 'PUT' = 'POST';
      let path = `/${indexPath}/_doc?refresh=wait_for`;
      if (!creating) {
        method = 'PUT';
        const qs = new URLSearchParams({ refresh: 'wait_for' });
        if (doc?.seqNo !== null && doc?.seqNo !== undefined && doc.primaryTerm !== null) {
          qs.set('if_seq_no', String(doc.seqNo));
          qs.set('if_primary_term', String(doc.primaryTerm));
        }
        path = `/${indexPath}/_doc/${encodeURIComponent(target.id ?? '')}?${qs}`;
      } else if (newId.trim()) {
        method = 'PUT';
        path = `/${indexPath}/_create/${encodeURIComponent(newId.trim())}?refresh=wait_for`;
      }
      const res = await ipc.os.request({ method, path, body: text });
      if (res.status >= 400) {
        const body = res.body as { error?: { reason?: string; type?: string } };
        const reason = body.error?.reason ?? JSON.stringify(res.body);
        setError(
          res.status === 409
            ? `Conflict — the document changed since it was loaded, or the id exists. ${reason}`
            : reason,
        );
        return;
      }
      target.onDone?.();
      openDoc(null);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    if (creating || target.id === null) return;
    const ok = await confirmOsWrite({
      title: 'Delete document?',
      description: `Document ${target.id} will be permanently removed from ${target.index}.`,
      confirmLabel: 'Delete document',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const res = await ipc.os.request({
        method: 'DELETE',
        path: `/${indexPath}/_doc/${encodeURIComponent(target.id)}?refresh=wait_for`,
      });
      if (res.status >= 400 && res.status !== 404) {
        setError(JSON.stringify(res.body));
        return;
      }
      target.onDone?.();
      openDoc(null);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent className="flex h-[80vh] w-[min(860px,92vw)] max-w-none flex-col gap-0 rounded-[10px] border-[var(--wb-separator)] bg-[var(--wb-content)] p-0 text-[13px] text-[var(--wb-text)]">
        <DialogHeader className="shrink-0 space-y-1 border-b border-[var(--wb-separator)] px-5 py-3.5">
          <DialogTitle>
            {creating ? 'New document' : access.canWrite ? 'Edit document' : 'Document'}
          </DialogTitle>
          <DialogDescription className="truncate font-mono">
            {target.index}
            {creating ? '' : ` / ${target.id}`}
            {doc?.seqNo !== null && doc?.seqNo !== undefined
              ? ` · seq_no ${doc.seqNo} · primary_term ${doc.primaryTerm}`
              : ''}
          </DialogDescription>
        </DialogHeader>
        {creating && (
          <div className="flex shrink-0 items-center gap-2 border-b border-[var(--wb-separator)] px-5 py-2">
            <label htmlFor="os-doc-id" className="text-[12px] text-[var(--wb-text-2)]">
              Document id
            </label>
            <Input
              id="os-doc-id"
              value={newId}
              onChange={(e) => setNewId(e.target.value)}
              placeholder="auto-generated when empty"
              className={`${FIELD_CLASS} w-72`}
              spellCheck={false}
            />
          </div>
        )}
        {!access.canWrite && (
          <div className="shrink-0 border-b border-[var(--wb-separator)] bg-[var(--wb-sidebar)] px-5 py-1.5 text-[12px] text-[var(--wb-text-2)]">
            {access.reason}
          </div>
        )}
        <div className="min-h-0 flex-1">
          {loading ? (
            <div className="flex h-full items-center justify-center text-[var(--wb-text-2)]">
              Loading document…
            </div>
          ) : (
            <OsCodeEditor
              value={text}
              onChange={onChange}
              language="json"
              ariaLabel="Document JSON"
              readOnly={!access.canWrite}
              onRun={() => void onSave()}
              className="h-full"
            />
          )}
        </div>
        {(error || jsonError) && (
          <div className="shrink-0 border-t border-[var(--wb-separator)] bg-[color-mix(in_srgb,var(--destructive)_14%,transparent)] px-5 py-2 font-mono text-[12px]">
            {error ?? jsonError}
          </div>
        )}
        <div className="flex h-12 shrink-0 items-center gap-2 border-t border-[var(--wb-separator)] px-5">
          {!creating && (
            <Pill
              onClick={() => void onDelete()}
              disabled={busy || !access.canWrite || loading}
              title={access.reason ?? 'Delete this document'}
              className="text-destructive hover:text-destructive"
            >
              <Trash2 />
              Delete
            </Pill>
          )}
          <div className="flex-1" />
          <Pill className="h-7 px-3" onClick={close} disabled={busy}>
            {access.canWrite ? 'Cancel' : 'Close'}
          </Pill>
          {access.canWrite && (
            <Pill
              className="h-7 bg-[var(--wb-control-active)] px-3 font-medium hover:bg-[var(--wb-control-hover)]"
              onClick={() => void onSave()}
              disabled={busy || loading || jsonError !== null || (!creating && !dirty)}
            >
              <Save />
              {busy ? 'Saving…' : creating ? 'Create' : 'Save'}
            </Pill>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
