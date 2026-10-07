import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/cn';
import { formatFileSize } from '@/lib/format';
import { useSupportBundle } from '@/stores/support-bundle';
import { Check, FileText, Loader2 } from 'lucide-react';

/**
 * "Create support bundle": every file that would be in the zip, with its exact
 * text, before anything is saved. The user can also hide host names and user
 * names, then chooses where the zip goes. Nothing is uploaded.
 */
export function SupportBundleDialog() {
  const open = useSupportBundle((s) => s.open);
  const loading = useSupportBundle((s) => s.loading);
  const saving = useSupportBundle((s) => s.saving);
  const error = useSupportBundle((s) => s.error);
  const preview = useSupportBundle((s) => s.preview);
  const selected = useSupportBundle((s) => s.selected);
  const redact = useSupportBundle((s) => s.redactHostsAndUsers);
  const savedPath = useSupportBundle((s) => s.savedPath);
  const close = useSupportBundle((s) => s.close);
  const select = useSupportBundle((s) => s.select);
  const setRedact = useSupportBundle((s) => s.setRedact);
  const save = useSupportBundle((s) => s.save);

  const files = preview?.files ?? [];
  const current = files.find((f) => f.name === selected) ?? null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent
        className="flex h-[min(80vh,640px)] max-w-[860px] flex-col gap-3"
        data-testid="support-bundle-dialog"
      >
        <DialogHeader>
          <DialogTitle>Create support bundle</DialogTitle>
          <DialogDescription>
            This is everything the bundle contains. Look through it before you save: nothing is
            uploaded, and you decide who gets the file. It never holds query results, SQL you wrote
            or ran, row data, passwords, keys or tokens.
          </DialogDescription>
        </DialogHeader>

        <label className="flex items-center gap-2 text-[13px]" htmlFor="support-redact">
          <Checkbox
            id="support-redact"
            checked={redact}
            disabled={loading || saving}
            onCheckedChange={(v) => void setRedact(v === true)}
            data-testid="support-redact"
          />
          Also hide host names and user names
          <span className="text-[12px] text-[var(--wb-text-3)]">
            (replaced with host-1, user-1, …)
          </span>
        </label>

        <div className="grid min-h-0 flex-1 grid-cols-[230px_1fr] gap-3">
          <nav aria-label="Files in the bundle" aria-busy={loading} className="min-h-0">
            <ul className="h-full min-h-0 overflow-y-auto rounded-[8px] bg-[var(--wb-sidebar)] p-1">
              {files.map((f) => (
                <li key={f.name}>
                  <button
                    type="button"
                    aria-current={f.name === selected ? 'true' : undefined}
                    data-testid="support-file"
                    onClick={() => select(f.name)}
                    className={cn(
                      'flex w-full flex-col rounded-[6px] px-2 py-1.5 text-left',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      f.name === selected
                        ? 'bg-[var(--wb-control)] text-[var(--wb-text)]'
                        : 'text-[var(--wb-text-2)] hover:bg-[var(--wb-control-hover)]',
                    )}
                  >
                    <span className="flex items-center gap-1.5 font-mono text-[12px]">
                      <FileText className="h-3 w-3 shrink-0" aria-hidden />
                      <span className="truncate">{f.name}</span>
                    </span>
                    <span className="pl-[18px] text-[11px] text-[var(--wb-text-3)]">
                      {formatFileSize(f.bytes)} · {f.description}
                    </span>
                  </button>
                </li>
              ))}
              {loading && files.length === 0 && (
                <li className="flex items-center gap-2 px-2 py-2 text-[12px] text-[var(--wb-text-2)]">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Collecting…
                </li>
              )}
            </ul>
          </nav>

          <div className="relative flex min-h-0 flex-col">
            {current ? (
              <textarea
                readOnly
                spellCheck={false}
                aria-label={`Contents of ${current.name}`}
                data-testid="support-file-text"
                value={current.text || '(empty)'}
                className={cn(
                  'min-h-0 flex-1 resize-none overflow-auto whitespace-pre-wrap break-words rounded-[8px] bg-[var(--wb-field)] p-3 font-mono text-[12px] leading-relaxed text-[var(--wb-text)]',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  loading && 'opacity-50',
                )}
              />
            ) : (
              <p className="p-3 text-[12px] text-[var(--wb-text-2)]">
                {loading ? 'Collecting…' : 'No files.'}
              </p>
            )}
          </div>
        </div>

        <div aria-live="polite" className="min-h-[18px] text-[12px]">
          {error && <span className="text-[var(--destructive)]">{error}</span>}
          {savedPath && (
            <span className="flex items-center gap-1.5 text-[var(--wb-text-2)]">
              <Check
                className="h-3.5 w-3.5 text-[var(--status-local)]"
                strokeWidth={3}
                aria-hidden
              />
              Saved to <span className="break-all font-mono">{savedPath}</span>
            </span>
          )}
        </div>

        <DialogFooter className="items-center">
          <span className="mr-auto text-[12px] text-[var(--wb-text-3)]">
            {preview
              ? `${files.length} files · ${formatFileSize(preview.totalBytes)} before zipping`
              : ''}
          </span>
          <Button variant="secondary" size="sm" onClick={close}>
            {savedPath ? 'Close' : 'Cancel'}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!preview || loading || saving}
            onClick={() => void save()}
            data-testid="support-save"
          >
            {saving && <Loader2 className="animate-spin" />}
            Save as zip…
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
