import { cn } from '@/lib/cn';
import { ChevronDown } from 'lucide-react';
import { forwardRef } from 'react';
import { buttonVariants } from './button';

/**
 * TablePlus-style chrome controls. Neutral graphite throughout — colour
 * only ever comes from the caller (status capsule, icons). All surfaces
 * consume the `--wb-*` tokens from globals.css.
 *
 * One button system: `Pill` and `IconButton` are thin wrappers over
 * `buttonVariants` from `button.tsx` (`secondary`/`ghost` × `pill`/
 * `icon-24`), so a `<Button size="pill">` and a `<Pill>` are identical.
 * Chrome uses these wrappers; forms and dialogs use `<Button>`.
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
  ({ label, active = false, variant = 'control', className, children, title, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-pressed={active || undefined}
      title={title ?? label}
      className={cn(
        buttonVariants({
          variant: variant === 'control' ? 'secondary' : 'ghost',
          size: 'icon-24',
        }),
        'text-[var(--wb-text-2)] hover:text-[var(--wb-text)]',
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

export type SegmentedVariant = 'plain' | 'track';

/**
 * `plain`: no track, active segment --wb-segment-active
 * — sidebar Items/Queries/History, Details/Assistant.
 * `track`: --wb-control track, active --wb-control-active
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
  const track = variant === 'track';
  // AA3: tablist keyboard model — one tab stop (the active segment);
  // ←/→ (and Home/End) move and select, skipping disabled segments.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const enabled = options.filter((o) => !o.disabled);
    if (enabled.length === 0) return;
    const at = enabled.findIndex((o) => o.value === value);
    const next =
      e.key === 'Home'
        ? enabled[0]
        : e.key === 'End'
          ? enabled[enabled.length - 1]
          : enabled[(at + (e.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length];
    if (!next) return;
    e.preventDefault();
    onChange(next.value);
    const btn = e.currentTarget.querySelector<HTMLButtonElement>(
      `[data-segment="${CSS.escape(next.value)}"]`,
    );
    btn?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
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
            tabIndex={active ? 0 : -1}
            data-segment={o.value}
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

type PillProps = React.ButtonHTMLAttributes<HTMLButtonElement>;

const PILL_SURFACE = buttonVariants({ variant: 'secondary', size: 'pill' });

/** 24px neutral pill (e.g. "Export…", "Run Current ⌘↵"). */
export const Pill = forwardRef<HTMLButtonElement, PillProps>(
  ({ className, children, ...props }, ref) => (
    <button ref={ref} type="button" className={cn(PILL_SURFACE, className)} {...props}>
      {children}
    </button>
  ),
);
Pill.displayName = 'Pill';

/** Chevron half of a split pill — wrap in a PopoverTrigger. */
export const PillChevron = forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement>
>(({ className, ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    className={cn(
      PILL_SURFACE,
      'grid w-[22px] place-items-center rounded-l-none px-0',
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
export function SplitPill({ children }: { children: React.ReactNode }) {
  return (
    <div className="inline-flex shrink-0 items-stretch gap-px rounded-[6px] bg-[var(--wb-content)] [&>button:first-child]:rounded-r-none">
      {children}
    </div>
  );
}

/**
 * ↑/↓ (and Home/End) move focus between the menu items of the enclosing
 * `role="menu"` container (AA3). Disabled items are skipped.
 */
function moveMenuFocus(e: React.KeyboardEvent<HTMLButtonElement>) {
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
  if (!keys.includes(e.key)) return;
  const menu = e.currentTarget.closest('[role="menu"]');
  if (!menu) return;
  const items = Array.from(
    menu.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)',
    ),
  );
  if (items.length === 0) return;
  const at = items.indexOf(e.currentTarget);
  const next =
    e.key === 'Home'
      ? items[0]
      : e.key === 'End'
        ? items[items.length - 1]
        : items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
  e.preventDefault();
  next?.focus();
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
      onKeyDown={moveMenuFocus}
      disabled={disabled}
      role={checked === undefined ? 'menuitem' : 'menuitemradio'}
      aria-checked={checked}
      className="group/menu flex h-[22px] w-full items-center gap-2 rounded-[4px] px-2 text-left text-[13px] leading-none text-[var(--wb-text)] transition-none hover:bg-[var(--wb-accent-fill)] hover:text-white focus-visible:bg-[var(--wb-accent-fill)] focus-visible:text-white focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40 [&_svg]:h-3.5 [&_svg]:w-3.5"
    >
      <span className="grid w-3.5 shrink-0 place-items-center">
        {checked ? <span className="text-[12px]">✓</span> : icon}
      </span>
      {/* leading > 1 so truncate's overflow clip keeps descenders and "_" */}
      <span className="flex-1 truncate leading-[16px]">{label}</span>
      {hint && (
        <span className="text-[12px] text-[var(--wb-text-2)] group-hover/menu:text-white/85 group-focus-visible/menu:text-white/85">
          {hint}
        </span>
      )}
    </button>
  );
}
