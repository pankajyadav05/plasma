import type { MetadataRoute } from 'next';
import { PAGES, SITE_URL } from '@/content/docs';

export const dynamic = 'force-static';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${SITE_URL}/`, changeFrequency: 'monthly', priority: 1 },
    { url: `${SITE_URL}/docs/`, changeFrequency: 'monthly', priority: 0.8 },
    ...PAGES.map((p) => ({
      url: `${SITE_URL}/docs/${p.slug}/`,
      changeFrequency: 'monthly' as const,
      priority: 0.6,
    })),
  ];
}
