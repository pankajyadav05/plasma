import { cn } from '@/lib/cn';
import { Search, X } from 'lucide-react';

/**
 * TablePlus search field: 26px, radius 7, --wb-field fill, magnifier
 * left, placeholder --wb-text-3. Shared by the left and right sidebars.
 */
export function SidebarSearch({
  value,
  onChange,
  placeholder,
  ariaLabel,
  disabled,
  onKeyDown,
  inputRef,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  ariaLabel?: string;
  disabled?: boolean;
  /** Lets a list take over ↓ / Enter from its search field. */
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  return (
    <div className="relative min-w-0 flex-1">
      <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--wb-text-2)]" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        ref={inputRef}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder.replace(/…$/, '')}
        disabled={disabled}
        className="h-[26px] w-full rounded-[7px] border-0 bg-[var(--wb-field)] pl-7 pr-7 text-[13px] text-[var(--wb-text)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--wb-text)_8%,transparent)] outline-none transition-shadow placeholder:text-[var(--wb-text-3)] focus:shadow-[0_0_0_2px_color-mix(in_srgb,var(--wb-accent)_55%,transparent)] disabled:opacity-60"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          className="absolute right-1 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded-[5px] text-[var(--wb-text-3)] hover:text-[var(--wb-text)]"
          aria-label="Clear search"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

/** Search field + trailing tool buttons, padded like TablePlus. */
export function SidebarSearchRow({ children }: { children: React.ReactNode }) {
  return <div className="flex shrink-0 items-center gap-1.5 px-2.5 pb-2">{children}</div>;
}

/** Row chrome shared by tree rows: 24px, radius 5, subtle hover, --wb-selected when active. */
export function sidebarRowClass(active?: boolean) {
  return cn(
    'mx-2 flex h-6 items-center rounded-[5px] text-[13px] text-[var(--wb-text)] transition-colors',
    active
      ? 'bg-[var(--wb-selected)]'
      : 'hover:bg-[color-mix(in_srgb,var(--wb-text)_6%,transparent)]',
  );
}

export function SidebarEmpty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="px-4 py-3">
      <div className="text-[13px] text-[var(--wb-text-2)]">{title}</div>
      {hint && <div className="mt-1 text-[11px] text-[var(--wb-text-3)]">{hint}</div>}
    </div>
  );
}
