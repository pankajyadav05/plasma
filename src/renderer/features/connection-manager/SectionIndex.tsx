import { cn } from '@/lib/cn';
import { Check } from 'lucide-react';
import { SECTION_TITLE, type SectionId, type SectionStatus } from './connection-sections';

/**
 * Sticky list of the form's cards with a status dot each: ring = untouched or
 * optional, check = complete, red = has an error. Click scrolls to the card.
 */
export function SectionIndex({
  sections,
  statuses,
  current,
  onPick,
}: {
  sections: SectionId[];
  statuses: Record<SectionId, SectionStatus>;
  current: SectionId | null;
  onPick: (id: SectionId) => void;
}) {
  return (
    <nav
      aria-label="Form sections"
      className="sticky top-4 hidden w-[172px] shrink-0 min-[1100px]:block"
    >
      <ul className="flex flex-col gap-px">
        {sections.map((id) => {
          const status = statuses[id];
          return (
            <li key={id}>
              <button
                type="button"
                onClick={() => onPick(id)}
                aria-current={id === current ? 'location' : undefined}
                className={cn(
                  'flex h-6 w-full items-center gap-2 rounded-[5px] px-2 text-left text-[13px] transition-colors',
                  id === current
                    ? 'bg-[var(--wb-selected)] text-[var(--wb-text)]'
                    : 'text-[var(--wb-text-2)] hover:bg-[color-mix(in_srgb,var(--wb-text)_6%,transparent)] hover:text-[var(--wb-text)]',
                )}
              >
                <StatusDot status={status} />
                <span className="truncate">{SECTION_TITLE[id]}</span>
                {status === 'error' && <span className="sr-only">has an error</span>}
                {status === 'complete' && <span className="sr-only">complete</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function StatusDot({ status }: { status: SectionStatus }) {
  if (status === 'complete') {
    return (
      <span
        aria-hidden
        className="grid h-3 w-3 shrink-0 place-items-center rounded-full bg-[var(--status-local)] text-white"
      >
        <Check className="h-2 w-2" strokeWidth={4} />
      </span>
    );
  }
  if (status === 'error') {
    return <span aria-hidden className="h-3 w-3 shrink-0 rounded-full bg-[var(--destructive)]" />;
  }
  return (
    <span
      aria-hidden
      className="h-3 w-3 shrink-0 rounded-full shadow-[inset_0_0_0_1.5px_var(--wb-text-3)]"
    />
  );
}
