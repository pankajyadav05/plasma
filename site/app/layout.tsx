import type { Metadata, Viewport } from 'next';
import { Archivo, Martian_Mono } from 'next/font/google';
import './globals.css';

import { ReleasesProvider } from '@/lib/releases-context';
import { PACKAGE_VERSION, getReleases } from '@/lib/version';
import { RELEASES_PAGE, type Releases } from '@/lib/feed';

const archivo = Archivo({
  subsets: ['latin'],
  axes: ['wdth'],
  variable: '--font-archivo',
  display: 'swap',
});
const martian = Martian_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-martian',
  display: 'swap',
});

const TITLE = 'Plasma: desktop client for SQL, Redis and OpenSearch';
const DESCRIPTION =
  'Plasma is a free, open-source desktop workbench for Postgres, MySQL, MariaDB, SQLite, ClickHouse, DuckDB, Redis and OpenSearch. It is careful with production, and its AI asks before it acts.';
const SITE = 'https://plasma.codifyit.dev';

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: SITE },
  openGraph: {
    type: 'website',
    title: TITLE,
    description: DESCRIPTION,
    url: SITE,
    images: [
      {
        url: '/og.png',
        width: 1200,
        height: 630,
        alt: 'Plasma, a desktop client for SQL, Redis and OpenSearch',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
    images: [
      {
        url: '/og.png',
        alt: 'Plasma, a desktop client for SQL, Redis and OpenSearch',
      },
    ],
  },
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180' }],
  },
  manifest: '/manifest.webmanifest',
};

export const viewport: Viewport = {
  themeColor: '#F3F0E8',
  colorScheme: 'light',
};

const OS_NAME = { mac: 'macOS', win: 'Windows', linux: 'Linux' } as const;

/** Structured data from what is actually published: no platform without a build, no unverified file. */
function buildJsonLd(releases: Releases) {
  const platforms = (['mac', 'win', 'linux'] as const).filter((os) => releases[os]);
  const firstFile = platforms.map((os) => releases[os]?.variants[0]?.url).find(Boolean);
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Plasma',
    applicationCategory: 'DeveloperApplication',
    applicationSubCategory: 'Database Client',
    ...(platforms.length > 0 && { operatingSystem: platforms.map((os) => OS_NAME[os]).join(', ') }),
    softwareVersion: releases.latestVersion ?? PACKAGE_VERSION,
    description: DESCRIPTION,
    url: SITE,
    // A file the build HEAD-checked, else the releases page. Never a guessed URL.
    downloadUrl: firstFile ?? RELEASES_PAGE,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    license: 'https://www.apache.org/licenses/LICENSE-2.0',
    author: { '@type': 'Person', name: 'Pankaj Yadav' },
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const releases = await getReleases();
  const jsonLd = buildJsonLd(releases);
  return (
    <html lang="en" className={`${archivo.variable} ${martian.variable}`}>
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <ReleasesProvider releases={releases}>{children}</ReleasesProvider>
      </body>
    </html>
  );
}
