import { cn } from '@/lib/cn';
import { ChevronDown } from 'lucide-react';
import { forwardRef } from 'react';

/**
 * TablePlus-style chrome controls built on the glass materials in
 * globals.css. Kept deliberately small: a toolbar capsule of icon
 * buttons, a segmented control, and a split "pill" button.
 */

// ───────────────────────── Toolbar group ─────────────────────────

export function ToolbarGroup({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn('glass no-drag flex h-[30px] shrink-0 items-center rounded-full px-[3px]', className)}
    >
      {children}
    </div>
  );
}

export function ToolbarDivider() {
  return <span className="mx-[3px] h-4 w-px shrink-0 bg-[var(--hairline)]" aria-hidden />;
}

type ToolbarButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  active?: boolean;
  tone?: 'default' | 'accent' | 'danger';
};

export const ToolbarButton = forwardRef<HTMLButtonElement, ToolbarButtonProps>(
  ({ label, active = false, tone = 'default', className, children, title, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-pressed={active || undefined}
      title={title ?? label}
      className={cn(
        'grid h-6 min-w-6 place-items-center rounded-full px-1 text-foreground/80 transition-colors',
        'hover:bg-[var(--glass-fill-hover)] hover:text-foreground active:bg-[var(--glass-fill-press)]',
        'disabled:pointer-events-none disabled:opacity-35',
        '[&_svg]:h-[15px] [&_svg]:w-[15px] [&_svg]:shrink-0',
        active && 'bg-[var(--glass-fill-press)] text-foreground',
        tone === 'accent' && 'text-primary hover:text-primary',
        tone === 'danger' && 'text-destructive hover:text-destructive',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  ),
);
ToolbarButton.displayName = 'ToolbarButton';

// ───────────────────────── Segmented control ─────────────────────────

export interface SegmentOption<T extends string> {
  value: T;
  label: React.ReactNode;
  icon?: React.ReactNode;
  title?: string;
  disabled?: boolean;
}

/**
 * `raised` lifts the active segment (sidebar mode, Details/Assistant);
 * `accent` fills it with the theme accent (result Data/Message/Chart).
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  variant = 'raised',
  size = 'md',
  stretch = false,
  ariaLabel,
  className,
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (v: T) => void;
  variant?: 'raised' | 'accent';
  size?: 'sm' | 'md';
  stretch?: boolean;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        'glass inline-flex shrink-0 items-stretch rounded-[8px] p-[2px]',
        size === 'sm' ? 'h-[24px]' : 'h-[28px]',
        stretch && 'flex w-full',
        className,
      )}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={o.disabled}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cn(
              'flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[6px] font-medium transition-colors',
              size === 'sm' ? 'px-2.5 text-[11px]' : 'px-3 text-xs',
              stretch && 'flex-1',
              '[&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0',
              'disabled:pointer-events-none disabled:opacity-40',
              active
                ? variant === 'accent'
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'raised text-foreground'
                : 'text-foreground/65 hover:text-foreground',
            )}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ───────────────────────── Pill buttons ─────────────────────────

type PillProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: 'default' | 'accent';
};

/** Single glass pill (e.g. "Export…"). */
export const Pill = forwardRef<HTMLButtonElement, PillProps>(
  ({ tone = 'default', className, children, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      className={cn(
        'inline-flex h-[26px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[7px] px-2.5 text-xs font-medium transition-colors',
        '[&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0',
        'disabled:pointer-events-none disabled:opacity-40',
        tone === 'accent'
          ? 'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90'
          : 'glass text-foreground/85 hover:bg-[var(--glass-fill-hover)] hover:text-foreground',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  ),
);
Pill.displayName = 'Pill';

/** Chevron half of a split pill — wrap in a PopoverTrigger. */
export const PillChevron = forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'default' | 'accent' }
>(({ tone = 'default', className, ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    className={cn(
      'grid h-[26px] w-6 shrink-0 place-items-center rounded-r-[7px] transition-colors',
      'disabled:pointer-events-none disabled:opacity-40',
      tone === 'accent'
        ? 'border-l border-primary-foreground/25 bg-primary text-primary-foreground hover:bg-primary/90'
        : 'border-l border-[var(--hairline)] text-foreground/70 hover:bg-[var(--glass-fill-hover)] hover:text-foreground',
      className,
    )}
    {...props}
  >
    <ChevronDown className="h-3 w-3" />
  </button>
));
PillChevron.displayName = 'PillChevron';

/** Container that joins a Pill + PillChevron into one capsule. */
export function SplitPill({
  tone = 'default',
  children,
}: {
  tone?: 'default' | 'accent';
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'inline-flex shrink-0 items-stretch rounded-[7px] [&>button:first-child]:rounded-r-none',
        tone === 'default' ? 'glass' : 'shadow-sm',
        // The inner pill must not double the glass fill.
        tone === 'default' && '[&>button:first-child]:bg-transparent [&>button:first-child]:shadow-none',
      )}
    >
      {children}
    </div>
  );
}

/** Row in a pill's dropdown menu. */
export function MenuItem({
  icon,
  label,
  hint,
  checked,
  onClick,
  disabled,
}: {
  icon?: React.ReactNode;
  label: React.ReactNode;
  hint?: string;
  checked?: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      role={checked === undefined ? 'menuitem' : 'menuitemradio'}
      aria-checked={checked}
      className="flex w-full items-center gap-2 rounded-[5px] px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-primary hover:text-primary-foreground disabled:pointer-events-none disabled:opacity-40 [&_svg]:h-3.5 [&_svg]:w-3.5"
    >
      <span className="grid w-3.5 shrink-0 place-items-center">
        {checked ? <span className="text-[11px]">✓</span> : icon}
      </span>
      <span className="flex-1">{label}</span>
      {hint && <span className="font-mono text-[10px] opacity-60">{hint}</span>}
    </button>
  );
}
