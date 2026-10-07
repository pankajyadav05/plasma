import { EmptyState } from '@/components/ui/view-parts';
import { IconButton } from '@/components/ui/workbench';
import { SidebarSearch } from '@/features/sidebar/sidebar-parts';
import { cn } from '@/lib/cn';
import { useSession } from '@/stores/session';
import { X } from 'lucide-react';
import { useState } from 'react';
import {
  SETTINGS_SECTIONS,
  SettingsSection,
  type SettingsSectionId,
  sectionMatches,
} from './SettingsBody';
import { takeRequestedSection } from './settings-nav';

/**
 * Settings — the single preferences surface (palette, menu, rail and ⌘,
 * all land here). TablePlus layout: a section list on the left (with a
 * search box) and the chosen section on the right. Esc or the close
 * button returns to the database canvas.
 */
export function SettingsCanvas() {
  const setCanvasMode = useSession((s) => s.setCanvasMode);
  const [section, setSection] = useState<SettingsSectionId>(
    () => takeRequestedSection() ?? 'general',
  );
  const [query, setQuery] = useState('');
  const visible = SETTINGS_SECTIONS.filter((s) => sectionMatches(s.id, query));
  const active = visible.some((s) => s.id === section) ? section : visible[0]?.id;
  const activeLabel = SETTINGS_SECTIONS.find((s) => s.id === active)?.label;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 bg-[var(--wb-content)]">
      <nav
        aria-label="Settings sections"
        className="flex w-[200px] shrink-0 flex-col gap-2 border-r border-[var(--wb-separator)] bg-[var(--wb-sidebar)] px-2.5 py-3"
      >
        <div className="flex shrink-0">
          <SidebarSearch
            value={query}
            onChange={setQuery}
            placeholder="Search settings…"
            ariaLabel="Search settings"
          />
        </div>
        <ul className="flex flex-col gap-px">
          {visible.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => setSection(s.id)}
                aria-current={s.id === active ? 'page' : undefined}
                className={cn(
                  'flex h-6 w-full items-center rounded-[5px] px-2 text-left text-[13px] transition-colors',
                  s.id === active
                    ? 'bg-[var(--wb-selected)] text-[var(--wb-text)]'
                    : 'text-[var(--wb-text)] hover:bg-[color-mix(in_srgb,var(--wb-text)_6%,transparent)]',
                )}
              >
                {s.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Settings">
        <header className="flex h-[38px] shrink-0 items-center gap-2 border-b border-[var(--wb-separator)] px-4">
          <h1 className="text-[15px] font-semibold text-[var(--wb-text)]">
            {activeLabel ?? 'Settings'}
          </h1>
          <div className="flex-1" />
          <IconButton
            variant="plain"
            label="Close settings"
            title="Close (Esc)"
            onClick={() => setCanvasMode('database')}
          >
            <X />
          </IconButton>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {active ? (
            <div className="mx-auto w-full max-w-[680px] py-4">
              <SettingsSection id={active} />
            </div>
          ) : (
            <EmptyState title="No settings match" hint={`Nothing matches "${query}".`} />
          )}
        </div>
      </section>
    </div>
  );
}
