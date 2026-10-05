import type { MetadataRoute } from 'next';

export const dynamic = 'force-static';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Plasma',
    short_name: 'Plasma',
    description: 'A desktop client for SQL, Redis and OpenSearch.',
    start_url: '/',
    display: 'browser',
    background_color: '#F3F0E8',
    theme_color: '#F3F0E8',
    icons: [
      { src: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    ],
  };
}
