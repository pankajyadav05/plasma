import { cn } from '@/lib/cn';

/**
 * Structural pieces shared by every workbench view (Postgres, Redis,
 * OpenSearch) so they read as one app: a 38px toolbar under the tab
 * strip, a 36px footer, section headings, stat tiles and empty states.
 * Colours come from the --wb-* tokens only.
 */

/** 38px bar at the top of a view: title/meta on the left, actions right. */
export function ViewToolbar({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex h-[38px] shrink-0 items-center gap-2 border-b border-[var(--wb-separator)] bg-[var(--wb-content)] px-2.5 text-[13px] text-[var(--wb-text)]',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** 36px bar at the bottom of a view (TablePlus results-footer look). */
export function ViewFooter({
  children,
  className,
  testId,
}: {
  children: React.ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div
      className={cn(
        'flex h-9 min-w-0 shrink-0 items-center gap-2 overflow-hidden whitespace-nowrap border-t border-[var(--wb-separator)] bg-[var(--wb-content)] px-2.5 text-[13px] text-[var(--wb-text-2)]',
        className,
      )}
      data-testid={testId}
    >
      {children}
    </div>
  );
}

/** Title + muted meta used in ViewToolbar. */
export function ViewTitle({ title, meta }: { title: React.ReactNode; meta?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <span className="truncate font-semibold text-[var(--wb-text)]">{title}</span>
      {meta && <span className="truncate text-[12px] text-[var(--wb-text-2)]">{meta}</span>}
    </div>
  );
}

/** Small uppercase-free section heading inside a scrolling view. */
export function SectionHeading({
  children,
  action,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-4 pb-2 pt-5">
      <h3 className="text-[13px] font-semibold text-[var(--wb-text)]">{children}</h3>
      <div className="flex-1" />
      {action}
    </div>
  );
}

/** Compact metric tile for overview screens. */
export function StatTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-[8px] bg-[var(--wb-control)] px-3 py-2.5">
      <div className="truncate text-[11px] font-medium text-[var(--wb-text-2)]">{label}</div>
      <div className="mt-0.5 truncate font-mono text-[15px] font-semibold tabular-nums text-[var(--wb-text)]">
        {value}
      </div>
      {hint && <div className="mt-0.5 truncate text-[11px] text-[var(--wb-text-3)]">{hint}</div>}
    </div>
  );
}

/** Centered empty / placeholder state (TablePlus "No row selected" style). */
export function EmptyState({
  title,
  hint,
  action,
  className,
}: {
  title: React.ReactNode;
  hint?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex h-full min-h-[160px] flex-1 flex-col items-center justify-center gap-1 px-6 text-center',
        className,
      )}
    >
      <div className="text-[15px] text-[var(--wb-text-2)]">{title}</div>
      {hint && <div className="max-w-md text-[12px] text-[var(--wb-text-3)]">{hint}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/** Neutral small sentence-case badge (type tags like Hash / ZSet, health, counts). */
export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'accent' | 'warn' | 'danger';
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-[4px] px-1.5 py-px text-[11px] font-medium leading-4',
        tone === 'neutral' && 'bg-[var(--wb-control)] text-[var(--wb-text-2)]',
        tone === 'accent' &&
          'bg-[color-mix(in_srgb,var(--wb-accent)_22%,transparent)] text-[var(--wb-text)]',
        tone === 'warn' &&
          'bg-[color-mix(in_srgb,var(--status-staging)_35%,transparent)] text-[var(--wb-text)]',
        tone === 'danger' &&
          'bg-[color-mix(in_srgb,var(--destructive)_30%,transparent)] text-[var(--wb-text)]',
        className,
      )}
    >
      {children}
    </span>
  );
}
