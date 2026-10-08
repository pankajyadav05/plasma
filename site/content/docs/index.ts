import type { FullTextEntry, SearchEntry } from '@/components/docs/docs-search';
import type { NavGroup } from '@/components/docs/docs-nav';
import type { TocItem } from '@/components/docs/toc';
import { aiAssistant } from './ai-assistant';
import { commandLine } from './command-line';
import { connections } from './connections';
import { gettingStarted } from './getting-started';
import { install } from './install';
import { mcpServer } from './mcp-server';
import { opensearch } from './opensearch';
import { postgres } from './postgres';
import { redis } from './redis';
import { reliability } from './reliability';
import { results } from './results';
import { safetyPrivacy } from './safety-privacy';
import { schemaTools } from './schema-tools';
import { settings } from './settings';
import { shortcuts } from './shortcuts';
import { sqlEditor } from './sql-editor';
import { clickhouse, duckdb, mysql, sqlite } from './sql-engines';
import { troubleshooting } from './troubleshooting';
import { plainText } from './search-text';
import type { DocPage } from './types';

export const SITE_URL = 'https://plasma.codifyit.dev';

/** Reading order. The sidebar groups follow the `group` of each page, in this order. */
export const PAGES: readonly DocPage[] = [
  install,
  gettingStarted,
  commandLine,
  connections,
  sqlEditor,
  results,
  schemaTools,
  postgres,
  mysql,
  sqlite,
  clickhouse,
  duckdb,
  redis,
  opensearch,
  aiAssistant,
  mcpServer,
  safetyPrivacy,
  reliability,
  shortcuts,
  settings,
  troubleshooting,
];

export function getPage(slug: string): DocPage | undefined {
  return PAGES.find((p) => p.slug === slug);
}

export function neighbours(slug: string): { prev: DocPage | null; next: DocPage | null } {
  const i = PAGES.findIndex((p) => p.slug === slug);
  return { prev: PAGES[i - 1] ?? null, next: PAGES[i + 1] ?? null };
}

export function tocOf(page: DocPage): TocItem[] {
  return page.sections.flatMap((s) => [
    { id: s.id, title: s.title, level: 2 as const },
    ...(s.subs ?? []).map((x) => ({ id: x.id, title: x.title, level: 3 as const })),
  ]);
}

export function navGroups(): NavGroup[] {
  const groups: NavGroup[] = [];
  for (const p of PAGES) {
    let g = groups.find((x) => x.group === p.group);
    if (!g) {
      g = { group: p.group, pages: [] };
      groups.push(g);
    }
    g.pages.push({ slug: p.slug, title: p.title });
  }
  return groups;
}

/** Page titles and headings, for the sidebar search. */
export function searchIndex(): SearchEntry[] {
  const out: SearchEntry[] = [];
  for (const p of PAGES) {
    out.push({ page: p.title, heading: p.title, href: `/docs/${p.slug}/`, hay: `${p.title} ${p.group}`.toLowerCase() });
    for (const t of tocOf(p)) {
      out.push({
        page: p.title,
        heading: t.title,
        href: `/docs/${p.slug}/#${t.id}`,
        hay: `${t.title} ${p.title}`.toLowerCase(),
      });
    }
  }
  return out;
}

/** Full-text entries (one per section and sub-section), served as /docs/search.json. */
export function searchText(): FullTextEntry[] {
  const out: FullTextEntry[] = [];
  for (const p of PAGES) {
    out.push({ page: p.title, heading: p.title, href: `/docs/${p.slug}/`, text: p.summary });
    for (const s of p.sections) {
      out.push({ page: p.title, heading: s.title, href: `/docs/${p.slug}/#${s.id}`, text: plainText(s.body) });
      for (const x of s.subs ?? []) {
        out.push({ page: p.title, heading: x.title, href: `/docs/${p.slug}/#${x.id}`, text: plainText(x.body) });
      }
    }
  }
  return out;
}
