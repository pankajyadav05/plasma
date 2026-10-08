import type { ReactNode } from 'react';
import { DocsHeader } from '@/components/docs/docs-header';
import { DocsNav } from '@/components/docs/docs-nav';
import { Footer } from '@/components/sections/Footer';
import { navGroups, searchIndex } from '@/content/docs';

export default function DocsLayout({ children }: { children: ReactNode }) {
  const groups = navGroups();
  const index = searchIndex();
  return (
    <>
      <DocsHeader />
      <div className="wrap lg:grid lg:grid-cols-[260px_minmax(0,1fr)] lg:gap-12 xl:gap-16">
        {/* Small screens: the same navigation in a collapsible menu. */}
        <details className="group/menu mt-4 rounded-[12px] border border-rule bg-paper-2/70 lg:hidden">
          <summary className="mono flex cursor-pointer list-none items-center justify-between px-4 py-3 text-[12px] font-medium uppercase tracking-[0.06em] text-ink [&::-webkit-details-marker]:hidden">
            Docs menu
            <span aria-hidden="true" className="text-ink-3 group-open/menu:rotate-45">
              +
            </span>
          </summary>
          <div className="border-t border-rule p-4">
            <DocsNav groups={groups} index={index} />
          </div>
        </details>

        <aside aria-label="Docs sidebar" className="hidden lg:block">
          <div className="sticky top-16 max-h-[calc(100vh-4rem)] overflow-y-auto py-8 pr-2">
            <DocsNav groups={groups} index={index} />
          </div>
        </aside>

        <main id="main" className="min-w-0 pt-8 lg:pt-12">
          {children}
        </main>
      </div>
      <Footer />
    </>
  );
}
