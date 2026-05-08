import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  // Pin Turbopack root to the site/ directory. Repo also has a root
  // pnpm-lock.yaml (Electron app) which Next would otherwise pick as
  // the workspace root.
  turbopack: { root: __dirname },
};
export default nextConfig;
