import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DocArticle } from '@/components/docs/doc-article';
import { PAGES, SITE_URL, getPage } from '@/content/docs';

export const dynamicParams = false;

export function generateStaticParams() {
  return PAGES.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const page = getPage(slug);
  if (!page) return {};
  const title = `${page.title} · Plasma docs`;
  const url = `${SITE_URL}/docs/${page.slug}/`;
  return {
    title,
    description: page.summary,
    alternates: { canonical: url },
    openGraph: {
      type: 'article',
      title,
      description: page.summary,
      url,
      images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Plasma, a desktop client for SQL, Redis and OpenSearch' }],
    },
    twitter: { card: 'summary_large_image', title, description: page.summary, images: ['/og.png'] },
  };
}

export default async function DocPageRoute({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = getPage(slug);
  if (!page) notFound();
  return <DocArticle page={page} />;
}
