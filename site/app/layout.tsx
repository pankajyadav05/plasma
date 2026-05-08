import type { Metadata, Viewport } from 'next';
import { Fraunces, Geist, JetBrains_Mono } from 'next/font/google';
import './globals.css';

import { Cursor } from '@/components/cursor';
import { ExplainEasterEgg } from '@/components/easter-egg';
import { SmoothScroll } from '@/components/smooth-scroll';
import { DOWNLOAD_URL, VERSION } from '@/lib/version';

const fraunces = Fraunces({
  subsets: ['latin'],
  axes: ['SOFT', 'WONK', 'opsz'],
  variable: '--font-fraunces',
  display: 'swap',
});
const geist = Geist({
  subsets: ['latin'],
  variable: '--font-geist',
  display: 'swap',
});
const jbmono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  variable: '--font-mono-loaded',
  display: 'swap',
});

const TITLE = 'Plasma — Postgres, Redis, OpenSearch in one editorial client.';
const DESCRIPTION =
  'A modern desktop database client. Schema-aware autocomplete, AI with engine-aware tool use, EXPLAIN viewer, Discover-style search, redis-cli, nine themes. Apache 2.0.';

export const metadata: Metadata = {
  metadataBase: new URL('https://plasma.sh'),
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: 'https://plasma.sh' },
  openGraph: {
    type: 'website',
    title: TITLE,
    description: DESCRIPTION,
    url: 'https://plasma.sh',
    images: [{ url: '/og.svg', width: 1200, height: 630 }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Plasma — a quiet place for queries',
    description:
      'Postgres + Redis + OpenSearch in one editorial-typography client. AI with engine-aware tool use.',
    images: ['/og.svg'],
  },
  icons: { icon: '/favicon.svg' },
};

export const viewport: Viewport = {
  themeColor: '#0a0a0a',
  colorScheme: 'dark',
};

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'Plasma',
  applicationCategory: 'DeveloperApplication',
  applicationSubCategory: 'Database Client',
  operatingSystem: 'Windows 10, Windows 11',
  softwareVersion: VERSION,
  description: DESCRIPTION,
  url: 'https://plasma.sh',
  downloadUrl: DOWNLOAD_URL,
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  license: 'https://www.apache.org/licenses/LICENSE-2.0',
  author: { '@type': 'Person', name: 'Pankaj Yadav' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${fraunces.variable} ${geist.variable} ${jbmono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body className="grain min-h-screen">
        <Cursor />
        <ExplainEasterEgg />
        <SmoothScroll>{children}</SmoothScroll>
      </body>
    </html>
  );
}
