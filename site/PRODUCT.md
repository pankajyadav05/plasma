# Plasma

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers evaluating a desktop data client for serious work with Postgres, Redis and OpenSearch. Audience and purpose were specified in the user's landing-page brief.

## Product Purpose

Plasma provides engine-specific database workspaces inside one desktop application. The core story is database work, not AI.

## Capabilities and Constraints

Postgres: schema-aware SQL editing, results, multi-statement scripts, schema browsing, cell details, foreign-key navigation and EXPLAIN ANALYZE inspection. Redis: namespace key browsing, typed values, TTL, CLI, memory analysis, slow log and pub/sub. OpenSearch: document search, query strings, DSL, fields and mappings.

Saved connections, preferences and query history are stored locally. Saved database passwords use OS-backed encryption. Optional OpenRouter AI sends prompts and included context to the provider; never claim that nothing leaves the machine. Do not claim all session/tab state persists across restarts or that all credential types are encrypted.

Apache-2.0 source is at https://github.com/pankajyadav05/plasma. Supported published downloads are macOS Apple Silicon/Intel and Windows x64 installer/portable. macOS builds are unsigned. Download constants and platform detection live in lib/version.ts and lib/platform.ts.

## Brand Commitments

The user requests modern, typography-led, product-first, technically credible design. No fake testimonials, invented metrics, scroll hijacking or AI-led narrative. Auxia (https://www.auxia.io/) is the selected composition and motion reference, but the user subsequently required Plasma's own colors and full logo: paper `#FAF7F0`, ink `#1C1A14`, oxblood `#7B2D26`, the original italic primary wordmark in the header and the cream variant on dark surfaces. Keep the routed workflow, coordinated motion and layered product framing; do not copy Auxia's palette, assets, customer proof or business claims. Refine interactions without replacing the chosen layout or product truth.

The user replaced the four-stage hero workflow with a connection-dialog image
beside “Your data, in context.” on desktop and below the copy on mobile. Their
uploaded screenshot was a reference only. Capture the UI from the actual running
application; do not publish the uploaded image or a reconstructed mockup.
The app capture must use its real light theme to match the light landing page,
not a dark capture or a recolored bitmap.

## Evidence on Hand

public/product/postgres.webp, redis.webp, opensearch.webp and explain.webp render actual application components with synthetic data. Provenance: public/product/captures.json. Always disclose illustrative data. No customer proof, adoption statistics or performance benchmarks are supplied.

public/product/connection-setup-light.webp is a fresh 2x capture of the actual Electron
light-theme connection dialog, launched in an isolated temporary profile. It shows example
values, an empty password field with the app's bullet placeholder, and no live connection.

## Accessibility & Inclusion

Keyboard navigation, visible focus, semantic headings, high contrast, reduced-motion behavior, and usable layouts at 1440, 1024, 768 and 390 CSS pixels are required.
