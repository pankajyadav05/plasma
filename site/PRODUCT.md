# Plasma

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers evaluating a desktop data client for serious work with Postgres, MySQL, MariaDB, SQLite, ClickHouse, DuckDB, Redis and OpenSearch. Audience and purpose were specified in the user's landing-page brief.

## Product Purpose

Plasma is a free, open-source desktop workbench for eight database engines (Postgres, MySQL, MariaDB, SQLite, ClickHouse, DuckDB, Redis, OpenSearch) that is careful with production. It has an AI assistant that asks before it acts, and an MCP server so Claude Code, Cursor, Codex and Claude Desktop can use your databases through the same guardrails. The story stays database-first and safety-first: AI extends the guardrails and is never hype. No invented numbers, testimonials or benchmarks. No numbering of sections, figures or lists anywhere on the page.

## Capabilities and Constraints

Postgres gets the full workbench: schema-aware SQL editing, multi-statement scripts, grid editing with conflict detection, Safe Run, structure editor, ER diagram, EXPLAIN ANALYZE, Health advisor, import, backup, schema diff, migration check and search in database. MySQL/MariaDB and SQLite: SQL editor, grid editing with conflict detection, structure view, ER diagram, plain EXPLAIN. ClickHouse: SQL over HTTP(S), read-only grid, mutation warnings, plain EXPLAIN. DuckDB: CSV, TSV, Parquet, JSON, NDJSON and Excel files as views, column profiles, a PostgreSQL connection attached read-only. Redis: namespace key browsing, typed values, TTL, guarded CLI, memory analysis, slow log and pub/sub. OpenSearch: document search, query strings, DSL, console, SQL plugin, mappings. The AI assistant's approval cards and the MCP server's queries cover the SQL engines (MCP run_query: Postgres, MySQL/MariaDB, SQLite, ClickHouse); on Redis and OpenSearch the assistant is a chat.

Saved connections, preferences and query history are stored locally. Saved database passwords use OS-backed encryption. Optional AI (your OpenRouter key, or a local model) sends prompts and included context to the provider; the model picker also fetches OpenRouter's public model list. Never claim that nothing leaves the machine. Do not claim all session/tab state persists across restarts or that all credential types are encrypted.

Apache-2.0 source is at https://github.com/pankajyadav05/plasma. Published downloads are macOS Apple Silicon (arm64 dmg and zip, no Intel build), Windows x64 (installer and portable) and Linux x64 (AppImage and .deb). macOS and Windows builds are unsigned; updates are checked with an ed25519-signed manifest (see docs/release.md). Download constants and platform detection live in lib/version.ts and lib/platform.ts.

The documentation section lives at /docs (app/docs, content/docs, components/docs). Every statement there must be checked against the current app code in src/, bin/, docs/ and electron-builder.yml; labels, shortcuts and setting names are copied from the code, and unconfirmed details are left out.

## Brand Commitments

The user requests modern, typography-led, product-first, technically credible design. No fake testimonials, invented metrics, scroll hijacking or AI-led narrative. Auxia (https://www.auxia.io/) is the selected composition and motion reference, but the user subsequently required Plasma's own colors and full logo: paper `#FAF7F0`, ink `#1C1A14`, oxblood `#7B2D26`, the original italic primary wordmark in the header and the cream variant on dark surfaces. Keep the routed workflow, coordinated motion and layered product framing; do not copy Auxia's palette, assets, customer proof or business claims. Refine interactions without replacing the chosen layout or product truth.

The hero is the headline “One workbench for all your databases.” over the engine
spec sheet, followed by the annotated workbench capture. Capture the UI from the
actual running application; never publish a reconstructed mockup. App captures
use the real light theme to match the light landing page, not a dark capture or a
recolored bitmap.

## Evidence on Hand

The homepage uses real app captures with sample data from public/product/v2 (listed in public/product/v2/captures.json). The older public/product/*.webp files and public/product/captures.json are the previous set. Always disclose illustrative data. No customer proof, adoption statistics or performance benchmarks are supplied.

public/product/connection-setup-light.webp is a fresh 2x capture of the actual Electron
light-theme connection dialog, launched in an isolated temporary profile. It shows example
values, an empty password field with the app's bullet placeholder, and no live connection.

## Accessibility & Inclusion

Keyboard navigation, visible focus, semantic headings, high contrast, reduced-motion behavior, and usable layouts at 1440, 1024, 768 and 390 CSS pixels are required.
