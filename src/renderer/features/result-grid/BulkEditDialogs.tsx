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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useEffect, useMemo, useState } from 'react';
import { type FindReplaceOptions, type FindReplacePlan, describeFindPlan } from './range-ops';

const FIELD_CLASS =
  'w-full rounded-[7px] border-0 bg-[var(--wb-field)] px-2 py-1.5 font-mono text-[13px] text-[var(--wb-text)] shadow-[inset_0_0_0_1px_var(--wb-toolbar-group-edge)] outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--ring)]';

/**
 * "Set value…" for the selected cells: free text or an explicit NULL. The
 * value is Postgres text; it is staged as a normal pending edit per cell.
 */
export function SetValueDialog({
  open,
  onOpenChange,
  cellCount,
  columnLabel,
  nullable,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cellCount: number;
  columnLabel: string;
  /** False when every selected column is NOT NULL (NULL stays selectable; the server decides). */
  nullable: boolean;
  onApply: (value: string | null) => void;
}) {
  const [text, setText] = useState('');
  const [asNull, setAsNull] = useState(false);
  useEffect(() => {
    if (open) {
      setText('');
      setAsNull(false);
    }
  }, [open]);
  const apply = () => {
    onApply(asNull ? null : text);
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Set value</DialogTitle>
          <DialogDescription>
            Stage one value for {cellCount.toLocaleString('en-US')} cell{cellCount === 1 ? '' : 's'}{' '}
            in {columnLabel}. Nothing is written until you commit.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
        >
          <Input
            aria-label="New value"
            value={asNull ? '' : text}
            disabled={asNull}
            placeholder={asNull ? 'NULL' : 'New value'}
            onChange={(e) => setText(e.target.value)}
            className="font-mono"
          />
          <div className="flex items-center gap-2">
            <Checkbox
              id="set-value-null"
              checked={asNull}
              onCheckedChange={(v) => setAsNull(v === true)}
            />
            <Label htmlFor="set-value-null" className="font-normal">
              Set to NULL
            </Label>
            {!nullable && (
              <span className="text-[12px] text-[var(--wb-text-3)]">
                (a selected column is NOT NULL — the commit will fail)
              </span>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm">
              Stage {cellCount.toLocaleString('en-US')} edit{cellCount === 1 ? '' : 's'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export type FindScope = 'column' | 'text-columns';

/**
 * Find & replace in the loaded results. The preview recomputes as you type
 * (how many cells change); "Replace" stages the replacements as pending
 * edits for review — nothing is written to the database.
 */
export function FindReplaceDialog({
  open,
  onOpenChange,
  columnName,
  textColumnCount,
  loadedNote,
  plan,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Name of the selected column; null when nothing is selected (only "all text columns"). */
  columnName: string | null;
  textColumnCount: number;
  loadedNote: string | null;
  plan: (opts: FindReplaceOptions, scope: FindScope) => FindReplacePlan;
  onApply: (plan: FindReplacePlan) => void;
}) {
  const [find, setFind] = useState('');
  const [replace, setReplace] = useState('');
  const [scope, setScope] = useState<FindScope>('column');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [wholeCell, setWholeCell] = useState(false);
  useEffect(() => {
    if (open) setScope(columnName ? 'column' : 'text-columns');
  }, [open, columnName]);

  const computed = useMemo(
    () =>
      open && find !== '' ? plan({ find, replace, caseSensitive, regex, wholeCell }, scope) : null,
    [open, find, replace, caseSensitive, regex, wholeCell, scope, plan],
  );
  const canApply = Boolean(computed && !computed.error && computed.writes.length > 0);
  const apply = () => {
    if (!computed || !canApply) return;
    onApply(computed);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[460px]">
        <DialogHeader>
          <DialogTitle>Find &amp; replace in results</DialogTitle>
          <DialogDescription>
            Replacements are staged as pending edits so you can review them before committing.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
        >
          <input
            aria-label="Find"
            value={find}
            onChange={(e) => setFind(e.target.value)}
            placeholder="Find"
            spellCheck={false}
            className={FIELD_CLASS}
          />
          <input
            aria-label="Replace with"
            value={replace}
            onChange={(e) => setReplace(e.target.value)}
            placeholder={regex ? 'Replace with (use $1, $2 for groups)' : 'Replace with'}
            spellCheck={false}
            className={FIELD_CLASS}
          />
          <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
            <legend className="sr-only">Where to look</legend>
            <label className="flex items-center gap-2 text-[13px]">
              <input
                type="radio"
                name="find-scope"
                checked={scope === 'column'}
                disabled={!columnName}
                onChange={() => setScope('column')}
              />
              {columnName ? (
                <>
                  Current column{' '}
                  <span className="font-mono text-[var(--wb-text-2)]">{columnName}</span>
                </>
              ) : (
                <span className="text-[var(--wb-text-3)]">
                  Current column (select a cell first)
                </span>
              )}
            </label>
            <label className="flex items-center gap-2 text-[13px]">
              <input
                type="radio"
                name="find-scope"
                checked={scope === 'text-columns'}
                onChange={() => setScope('text-columns')}
              />
              All text columns
              <span className="text-[12px] text-[var(--wb-text-3)]">({textColumnCount})</span>
            </label>
          </fieldset>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[13px]">
            <div className="flex items-center gap-2">
              <Checkbox
                id="fr-case"
                checked={caseSensitive}
                onCheckedChange={(v) => setCaseSensitive(v === true)}
              />
              <Label htmlFor="fr-case" className="font-normal">
                Match case
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="fr-whole"
                checked={wholeCell}
                onCheckedChange={(v) => setWholeCell(v === true)}
              />
              <Label htmlFor="fr-whole" className="font-normal">
                Whole cell
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="fr-regex"
                checked={regex}
                onCheckedChange={(v) => setRegex(v === true)}
              />
              <Label htmlFor="fr-regex" className="font-normal">
                Regular expression
              </Label>
            </div>
          </div>
          <output
            className={
              computed?.error
                ? 'block text-[12px] text-destructive'
                : 'block text-[12px] text-[var(--wb-text-2)]'
            }
            aria-live="polite"
          >
            {computed ? describeFindPlan(computed) : 'Type something to find.'}
            {loadedNote && !computed?.error && (
              <div className="mt-0.5 text-[var(--wb-text-3)]">{loadedNote}</div>
            )}
          </output>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={!canApply}>
              {canApply
                ? `Stage ${computed?.cellCount.toLocaleString('en-US')} replacement${computed?.cellCount === 1 ? '' : 's'}`
                : 'Replace'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Shown when a pasted block is taller than the loaded rows: add the extra
 * rows as pending INSERTs, or paste into the existing rows only.
 */
export function PasteOverflowDialog({
  open,
  onOpenChange,
  extraRows,
  fittingCells,
  note,
  onAddRows,
  onExistingOnly,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  extraRows: number;
  fittingCells: number;
  note: string | null;
  onAddRows: () => void;
  onExistingOnly: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[440px]">
        <DialogHeader>
          <DialogTitle>
            Add {extraRows.toLocaleString('en-US')} new row{extraRows === 1 ? '' : 's'}?
          </DialogTitle>
          <DialogDescription>
            The pasted block has {extraRows.toLocaleString('en-US')} row{extraRows === 1 ? '' : 's'}{' '}
            below the last loaded row. They can be staged as new rows (inserted when you commit);
            the other {fittingCells.toLocaleString('en-US')} pasted cell
            {fittingCells === 1 ? '' : 's'} overwrite existing rows.
            {note ? ` ${note}` : ''}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              onExistingOnly();
              onOpenChange(false);
            }}
          >
            Existing rows only
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              onAddRows();
              onOpenChange(false);
            }}
          >
            Add {extraRows.toLocaleString('en-US')} row{extraRows === 1 ? '' : 's'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
