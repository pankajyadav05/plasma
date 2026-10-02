import type { Metadata, Viewport } from 'next';
import { Archivo, Martian_Mono } from 'next/font/google';
import './globals.css';

import { DOWNLOAD_URL, VERSION } from '@/lib/version';

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

const TITLE = 'Plasma: a calm desktop client for Postgres, Redis & OpenSearch';
const DESCRIPTION =
  'Plasma is an open-source desktop client for Postgres, Redis and OpenSearch. Native-feeling, keyboard-first, and careful with production. Apache-2.0.';
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
    images: [{ url: '/og.png', width: 1200, height: 630 }],
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
    images: ['/og.png'],
  },
  icons: { icon: '/favicon.svg' },
};

export const viewport: Viewport = {
  themeColor: '#F3F0E8',
  colorScheme: 'light',
};

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'Plasma',
  applicationCategory: 'DeveloperApplication',
  applicationSubCategory: 'Database Client',
  operatingSystem: 'macOS, Windows 10, Windows 11',
  softwareVersion: VERSION,
  description: DESCRIPTION,
  url: SITE,
  downloadUrl: DOWNLOAD_URL,
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  license: 'https://www.apache.org/licenses/LICENSE-2.0',
  author: { '@type': 'Person', name: 'Pankaj Yadav' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
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
        {children}
      </body>
    </html>
  );
}
