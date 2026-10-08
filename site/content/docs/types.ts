import type { ReactNode } from 'react';

/** A third-level heading inside a section. */
export interface DocSub {
  id: string;
  title: string;
  body: ReactNode;
}

/** A second-level heading. `body` comes first, then the sub-sections. */
export interface DocSection {
  id: string;
  title: string;
  body?: ReactNode;
  subs?: DocSub[];
}

export interface DocPage {
  slug: string;
  title: string;
  /** Sidebar group. */
  group: string;
  /** One or two sentences: the intro under the title and the meta description. */
  summary: string;
  sections: DocSection[];
}
