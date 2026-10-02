#!/usr/bin/env node
/**
 * Rasterize Plasma SVG logos to PNG for the Electron window/taskbar icon.
 *
 * Reads:  logo/app-icon.svg, logo/favicon.svg
 * Writes: resources/icon.png           (512×512 — canonical BrowserWindow icon)
 *         resources/icon-{16..1024}.png (multi-size for platform icon bundles)
 *         resources/apple-touch-icon.png (180×180 — iOS/macOS web clip)
 *
 * Run it by hand (`pnpm build:icons`) after editing the SVGs. It is NOT wired
 * to `prepare`/`postinstall`: the PNGs are committed, and regenerating them
 * on every install made working trees dirty (system fonts differ per machine).
 * Without `--force` it does nothing when every output is newer than both
 * sources, and it never rewrites a file whose bytes would not change.
 *
 * Uses @resvg/resvg-js (pure napi, prebuilt binaries, no native build).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const logoDir = resolve(root, 'logo');
const resourcesDir = resolve(root, 'resources');

// ── Guard: skip gracefully if dependencies haven't been installed yet.
let Resvg;
try {
  ({ Resvg } = await import('@resvg/resvg-js'));
} catch {
  console.warn('[plasma:build-icons] @resvg/resvg-js not installed — skipping.');
  console.warn('[plasma:build-icons] Run `pnpm install` to trigger this automatically.');
  process.exit(0);
}

// ── Verify SVG sources exist.
const appIconPath = resolve(logoDir, 'app-icon.svg');
const faviconPath = resolve(logoDir, 'favicon.svg');

if (!existsSync(appIconPath) || !existsSync(faviconPath)) {
  console.error('[plasma:build-icons] Missing source SVGs in logo/.');
  process.exit(1);
}

mkdirSync(resourcesDir, { recursive: true });

const appIconSvg = readFileSync(appIconPath, 'utf-8');
const faviconSvg = readFileSync(faviconPath, 'utf-8');

/**
 * Rasterize an SVG string to a PNG buffer at the given width.
 * resvg renders at whatever density you ask for (no bitmap scaling).
 *
 * Font handling: we try Newsreader first (the brand face), but the
 * fallback chain in the SVG (`Georgia, Times New Roman, serif`) ensures
 * the letter shape is always correct even on systems without Newsreader.
 */
function rasterize(svg, width) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: {
      loadSystemFonts: true,
      defaultFontFamily: 'Georgia',
    },
    background: 'rgba(0,0,0,0)',
  });
  return resvg.render().asPng();
}

// ── Output plan.
//
// Two destinations:
//   resources/  — source of truth for Electron main process (taskbar/
//                 dock icon). Also holds multi-size PNGs for future
//                 .icns / .ico bundling via electron-builder.
//   logo/       — served by Vite as the renderer's static root. Web
//                 favicons go here so `/favicon.svg`, `/favicon-32.png`,
//                 and `/apple-touch-icon.png` resolve at runtime.
const outputs = [
  // — resources/ (Electron main)
  { svg: appIconSvg, size: 1024, dest: resourcesDir, name: 'icon-1024.png' },
  { svg: appIconSvg, size: 512, dest: resourcesDir, name: 'icon-512.png' },
  { svg: appIconSvg, size: 256, dest: resourcesDir, name: 'icon-256.png' },
  { svg: appIconSvg, size: 128, dest: resourcesDir, name: 'icon-128.png' },
  { svg: appIconSvg, size: 64, dest: resourcesDir, name: 'icon-64.png' },
  { svg: appIconSvg, size: 32, dest: resourcesDir, name: 'icon-32.png' },
  // Canonical BrowserWindow icon path that main/window.ts reads.
  { svg: appIconSvg, size: 512, dest: resourcesDir, name: 'icon.png' },

  // — logo/ (served by renderer at /...)
  { svg: faviconSvg, size: 16, dest: logoDir, name: 'favicon-16.png' },
  { svg: faviconSvg, size: 32, dest: logoDir, name: 'favicon-32.png' },
  { svg: faviconSvg, size: 180, dest: logoDir, name: 'apple-touch-icon.png' },
];

const force = process.argv.includes('--force');
if (!force) {
  const newestSource = Math.max(statSync(appIconPath).mtimeMs, statSync(faviconPath).mtimeMs);
  const upToDate = outputs.every(({ dest, name }) => {
    const out = resolve(dest, name);
    return existsSync(out) && statSync(out).mtimeMs >= newestSource;
  });
  if (upToDate) {
    console.log('[plasma:build-icons] outputs are newer than the SVG sources, nothing to do (use --force)');
    process.exit(0);
  }
}

console.log('[plasma:build-icons] rasterizing');
for (const { svg, size, dest, name } of outputs) {
  try {
    const png = rasterize(svg, size);
    const target = resolve(dest, name);
    if (!(existsSync(target) && readFileSync(target).equals(png))) writeFileSync(target, png);
    const relPath = dest === resourcesDir ? `resources/${name}` : `logo/${name}`;
    const kb = (png.length / 1024).toFixed(1);
    console.log(`  ✓ ${relPath.padEnd(32)} ${size}×${size}  ${kb} KB`);
  } catch (err) {
    console.error(`  ✗ ${name} — ${err?.message ?? err}`);
  }
}
console.log('[plasma:build-icons] done');
