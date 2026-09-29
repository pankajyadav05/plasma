import { cn } from '@/lib/cn';
import { ChevronDown } from 'lucide-react';
import { forwardRef } from 'react';

/**
 * TablePlus-style chrome controls. Neutral graphite throughout — colour
 * only ever comes from the caller (status capsule, icons). All surfaces
 * consume the `--wb-*` tokens from globals.css.
 */

// ───────────────────────── Toolbar group ─────────────────────────

/** 34px capsule holding ToolbarButtons (radius 17, lit top edge). */
export function ToolbarGroup({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'no-drag flex h-[34px] shrink-0 items-center rounded-[17px] bg-[var(--wb-toolbar-group)] px-[3px]',
        'shadow-[inset_0_0_0_1px_var(--wb-toolbar-group-edge),inset_0_1px_0_0_rgb(255_255_255/0.07)]',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function ToolbarDivider() {
  return (
    <span
      className="mx-[2px] h-[18px] w-px shrink-0 bg-[var(--wb-toolbar-group-edge)]"
      aria-hidden
    />
  );
}

type ToolbarButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  active?: boolean;
  tone?: 'default' | 'accent' | 'danger';
};

/** ~30px wide icon button inside a ToolbarGroup (16px icons). */
export const ToolbarButton = forwardRef<HTMLButtonElement, ToolbarButtonProps>(
  ({ label, active = false, tone = 'default', className, children, title, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-pressed={active || undefined}
      title={title ?? label}
      className={cn(
        'grid h-[28px] min-w-[30px] place-items-center rounded-[14px] px-[7px] transition-colors',
        'text-[var(--wb-text)]/85 hover:bg-[var(--wb-control-hover)] hover:text-[var(--wb-text)]',
        'active:bg-[var(--wb-control-active)]',
        'disabled:pointer-events-none disabled:opacity-35',
        '[&_svg]:h-4 [&_svg]:w-4 [&_svg]:shrink-0 [&_svg]:stroke-[1.75]',
        active && 'bg-[var(--wb-control)] text-[var(--wb-text)]',
        tone === 'accent' && 'text-[var(--wb-accent)] hover:text-[var(--wb-accent)]',
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

// ───────────────────────── Icon button ─────────────────────────

type IconButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  active?: boolean;
  /** `plain` drops the control fill (e.g. sidebar "sliders" next to search). */
  variant?: 'control' | 'plain';
};

/** 24px square, radius 6, --wb-control fill, 14px --wb-text-2 icon. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    { label, active = false, variant = 'control', className, children, title, ...props },
    ref,
  ) => (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-pressed={active || undefined}
      title={title ?? label}
      className={cn(
        'grid h-6 w-6 shrink-0 place-items-center rounded-[6px] text-[var(--wb-text-2)] transition-colors',
        'hover:bg-[var(--wb-control-hover)] hover:text-[var(--wb-text)]',
        'disabled:pointer-events-none disabled:opacity-40',
        '[&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0',
        variant === 'control' && 'bg-[var(--wb-control)]',
        active && 'bg-[var(--wb-control-active)] text-[var(--wb-text)]',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  ),
);
IconButton.displayName = 'IconButton';

// ───────────────────────── Segmented control ─────────────────────────

export interface SegmentOption<T extends string> {
  value: T;
  label: React.ReactNode;
  icon?: React.ReactNode;
  title?: string;
  disabled?: boolean;
}

export type SegmentedVariant = 'plain' | 'track' | 'raised' | 'accent';

/**
 * `plain` (alias `raised`): no track, active segment --wb-segment-active
 * — sidebar Items/Queries/History, Details/Assistant.
 * `track` (alias `accent`): --wb-control track, active --wb-control-active
 * — results footer Data/Message/Chart. Both are neutral.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  variant = 'plain',
  size = 'md',
  stretch = false,
  ariaLabel,
  className,
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (v: T) => void;
  variant?: SegmentedVariant;
  size?: 'sm' | 'md';
  stretch?: boolean;
  ariaLabel: string;
  className?: string;
}) {
  const track = variant === 'track' || variant === 'accent';
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex shrink-0 items-stretch',
        track
          ? 'h-6 gap-px rounded-[7px] bg-[var(--wb-control)] p-px'
          : cn('gap-1', size === 'sm' ? 'h-6' : 'h-[26px]'),
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
              'flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[6px] text-[13px] leading-none transition-colors',
              track ? 'px-2.5' : 'px-3',
              stretch && 'flex-1',
              '[&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0',
              'disabled:pointer-events-none disabled:opacity-40',
              active
                ? track
                  ? 'bg-[var(--wb-control-active)] text-[var(--wb-text)] shadow-[0_0.5px_1px_rgb(0_0_0/0.18)]'
                  : 'bg-[var(--wb-segment-active)] font-medium text-[var(--wb-text)]'
                : 'text-[var(--wb-text-2)] hover:text-[var(--wb-text)]',
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

/** `accent` is kept for compatibility and renders the same neutral style. */
type PillTone = 'default' | 'accent';

type PillProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: PillTone;
};

const PILL_SURFACE =
  'bg-[var(--wb-control)] text-[var(--wb-text)] hover:bg-[var(--wb-control-hover)] disabled:pointer-events-none disabled:opacity-40';

/** 24px neutral pill (e.g. "Export…", "Run Current ⌘↵"). */
export const Pill = forwardRef<HTMLButtonElement, PillProps>(
  ({ tone: _tone = 'default', className, children, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[6px] px-2.5 text-[13px] leading-none transition-colors',
        '[&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0',
        PILL_SURFACE,
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
  React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: PillTone }
>(({ tone: _tone = 'default', className, ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    className={cn(
      'grid h-6 w-[22px] shrink-0 place-items-center rounded-r-[6px] transition-colors',
      PILL_SURFACE,
      'text-[var(--wb-text-2)] hover:text-[var(--wb-text)]',
      className,
    )}
    {...props}
  >
    <ChevronDown className="h-3 w-3" />
  </button>
));
PillChevron.displayName = 'PillChevron';

/**
 * Joins a Pill + PillChevron into one capsule; the two halves are split
 * by a 1px gap showing the --wb-content background behind them.
 */
export function SplitPill({
  tone: _tone = 'default',
  children,
}: {
  tone?: PillTone;
  children: React.ReactNode;
}) {
  return (
    <div className="inline-flex shrink-0 items-stretch gap-px rounded-[6px] bg-[var(--wb-content)] [&>button:first-child]:rounded-r-none">
      {children}
    </div>
  );
}

/** Native-looking row in a pill's dropdown menu. */
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
      className="group/menu flex h-[22px] w-full items-center gap-2 rounded-[4px] px-2 text-left text-[13px] leading-none text-[var(--wb-text)] transition-none hover:bg-[var(--wb-accent)] hover:text-white focus-visible:bg-[var(--wb-accent)] focus-visible:text-white focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40 [&_svg]:h-3.5 [&_svg]:w-3.5"
    >
      <span className="grid w-3.5 shrink-0 place-items-center">
        {checked ? <span className="text-[12px]">✓</span> : icon}
      </span>
      <span className="flex-1 truncate">{label}</span>
      {hint && (
        <span className="text-[12px] text-[var(--wb-text-2)] group-hover/menu:text-white/80">
          {hint}
        </span>
      )}
    </button>
  );
}
