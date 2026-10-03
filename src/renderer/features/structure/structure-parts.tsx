import { Checkbox } from '@/components/ui/checkbox';
import { MigrationCheckPanel } from '@/features/migration/MigrationCheckPanel';
import { cn } from '@/lib/cn';
import { COMMON_PG_TYPES } from '@shared/pg-ddl';
import { forwardRef, useId } from 'react';

export const PG_TYPE_LIST_ID = 'plasma-pg-types';

/** Render once per dialog; `TypeInput`s point at it for autocomplete. */
export function PgTypeDatalist() {
  return (
    <datalist id={PG_TYPE_LIST_ID}>
      {COMMON_PG_TYPES.map((t) => (
        <option key={t} value={t} />
      ))}
    </datalist>
  );
}

const FIELD =
  'h-[24px] w-full min-w-0 rounded-[6px] border-0 bg-[var(--wb-field)] px-1.5 font-mono text-[12px] text-[var(--wb-text)] outline-none shadow-[inset_0_0_0_1px_var(--wb-toolbar-group-edge)] placeholder:text-[var(--wb-text-3)] focus:shadow-[inset_0_0_0_1px_var(--ring)] disabled:opacity-50 aria-[invalid=true]:shadow-[inset_0_0_0_1px_var(--destructive)]';

/** Compact text field for grid cells. */
export const CellInput = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input ref={ref} type="text" spellCheck={false} className={cn(FIELD, className)} {...props} />
  ),
);
CellInput.displayName = 'CellInput';

export const TypeInput = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <CellInput ref={ref} list={PG_TYPE_LIST_ID} className={className} {...props} />
  ),
);
TypeInput.displayName = 'TypeInput';

/** Read-only, selectable monospace SQL block. */
export function SqlPreview({
  sql,
  error,
  className,
  emptyText = 'No changes.',
  onLintBlockedChange,
  lint = true,
}: {
  sql: string;
  error?: string | null;
  className?: string;
  emptyText?: string;
  /**
   * Migration lint + lock preview are shown above the SQL. When given, error
   * findings need a "Run anyway" acknowledgement and this reports whether
   * the caller's apply action must stay disabled.
   */
  onLintBlockedChange?: (blocked: boolean) => void;
  lint?: boolean;
}) {
  const showLint = lint && !error && sql.trim() !== '';
  const block = (
    <div className={cn('flex min-h-0 flex-col', className)}>
      {error ? (
        <pre className="whitespace-pre-wrap rounded-[6px] bg-[var(--wb-field)] px-2.5 py-2 font-mono text-[12px] text-destructive">
          {error}
        </pre>
      ) : (
        <pre
          data-testid="structure-sql-preview"
          className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all rounded-[6px] bg-[var(--wb-field)] px-2.5 py-2 font-mono text-[12px] text-[var(--wb-text)]"
        >
          {sql || <span className="text-[var(--wb-text-3)]">{emptyText}</span>}
        </pre>
      )}
    </div>
  );
  if (!showLint) return block;
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <MigrationCheckPanel sql={sql} onBlockedChange={onLintBlockedChange} className="shrink-0" />
      {block}
    </div>
  );
}

export function FieldLabel({
  children,
  htmlFor,
}: {
  children: React.ReactNode;
  htmlFor?: string;
}) {
  return (
    <label htmlFor={htmlFor} className="mb-1 block text-[12px] text-[var(--wb-text-2)]">
      {children}
    </label>
  );
}

/** Checkbox with a clickable label (Radix checkbox is a button, so the label needs htmlFor). */
export function CheckRow({
  checked,
  onChange,
  disabled,
  children,
  className,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(v) => onChange(v === true)}
      />
      <label htmlFor={id} className={cn(disabled ? 'opacity-50' : 'cursor-pointer')}>
        {children}
      </label>
    </div>
  );
}
