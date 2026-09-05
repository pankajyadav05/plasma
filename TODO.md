# Plasma — feature ledger

## Shipped 2026-05-06 (multi-engine)

### Redis + OpenSearch support
- **Engine field on ConnectionConfig** — `engine: 'postgres' | 'redis' | 'opensearch'`. Backwards-compatible default `postgres`. SQLite migration v2 adds the column; existing rows keep working.
- **RedisDriver** — `src/workers/drivers/redis.ts`. ioredis-backed. SCAN with MATCH/COUNT, TYPE+PTTL pipelined, type-aware `getKey` (string/list/set/zset/hash/stream/json), arbitrary `command()`, DEL, EXPIRE/PERSIST. Capped collection reads at `MAX_ELEMENTS=1000` with `total` surfaced for the truncation banner.
- **OpenSearchDriver** — `src/workers/drivers/opensearch.ts`. `@opensearch-project/opensearch`. `info()` + `cluster.health` + `cat.indices` for the overview, `indices.getMapping` for the mapping tree, `search` for the DSL canvas. Distribution + version pulled from `info()`.
- **Worker dispatch** — `src/workers/index.ts` holds three driver instances. `connect` tears down the others and sets `activeEngine`. Engine-mismatched ops return `error` with a clear "X is not supported on Y engine" message.
- **IPC surface** — `RedisOverview/Scan/GetKey/DeleteKey/SetTtl/Command` + `OsOverview/Mapping/Search` channels. `PlasmaAPI.redis.*` + `PlasmaAPI.os.*` exposed in preload.
- **Connection dialog** — `ConnectionDialog.tsx` engine picker (3 cards) at top, conditional fields per engine (DB index for Redis, host-only for OS). SSL label flips to TLS / HTTPS appropriately. SSH section hidden for OpenSearch (HTTPS over public endpoints). Engine locked when editing.
- **Redis sidebar + canvas** — `RedisSidebar.tsx` (key tree grouped by `:` prefix, MATCH input, "Load more" pagination via SCAN cursor), `RedisHomeView.tsx` (cluster summary + keyspace per-db cards), `RedisKeyView.tsx` (type-aware body, TTL strip, DELETE confirm), `RedisCliView.tsx` (terminal with ↑/↓ history).
- **OpenSearch sidebar + canvas** — `OsSidebar.tsx` (flat indices list with health + docs + size, double-click → search), `OsHomeView.tsx` (cluster summary + top-8 indices by docs count), `OsIndexView.tsx` (mapping field tree + index stats), `OsSearchView.tsx` (DSL textarea + hits table with expandable JSON drawer).
- **AppShell wiring** — `EngineCanvas` switches the main canvas; `IconRail` hides History/Live activity for non-postgres; `RightRail` rendered only for postgres; `TabStrip` hides `+` button for non-postgres (tabs spawn from sidebar).

### Notes
- Tab kinds extended: `'redis-key' | 'redis-cli' | 'os-search' | 'os-index'` alongside existing `sql`/`table`. Each carries optional `redisKey` / `osIndex` / `osBody` fields on `QueryTab`.
- `refreshSchema()` no-ops for non-postgres engines. Engine-specific overviews live in `redisOverview` / `osOverview` session state with `refreshRedisOverview` / `refreshOsOverview` actions.
- Redis SCAN sidebar pages: cursor `'0'` replaces, non-zero cursor appends. Match filter triggers a fresh scan.

## Shipped 2026-05-06

### Round 1 (5)
- **AI sidecar (OpenRouter)** — `src/main/ai.ts`, `src/renderer/features/ai/AiPanel.tsx`. ⌘L toggle, schema as system prompt, ⌘I asks AI about Monaco selection, code-block Insert/Run.
- **SQL formatter** — `src/main/sql-format.ts`. ⌘⇧F + toolbar/right-rail Format buttons.
- **EXPLAIN ANALYZE viewer** — `src/renderer/features/explain/ExplainDialog.tsx`. Collapsible plan tree, hot-node highlighting, mis-estimate flagging.
- **Charts** — `src/renderer/features/chart/ChartDialog.tsx`. Bar/line/area, native SVG.
- **Live activity monitor** — `src/renderer/features/monitor/MonitorCanvas.tsx`. 2s pg_stat_activity poll on the worker sideband, cancel/terminate per pid.

### Round 2 (10)
- **Reverse FK lookup** — `CellDetailDialog.tsx`. Inbound-FK list inside the cell viewer; click jumps to the child table filtered by the cell value.
- **Snippet variables in saved queries** — `src/renderer/features/right-rail/SnippetVarsDialog.tsx`. `:varname` placeholders prompt for values before opening the saved SQL in a new tab.
- **Mock data generator** — `src/renderer/features/mock-data/MockDataDialog.tsx`. Edit-mode-gated, per-column auto/fixed generators, multi-row INSERT batched into one statement.
- **Multi-statement script runner** — `src/renderer/lib/sql-split.ts` + `runQuery` in session. Quote / dollar-quote / comment aware splitter, stop-on-first-error, "stopped at N of M" error annotation.
- **AI tool use** — `query_database` tool in `ai.ts`. Read-only gate (`isReadOnlySql`). Up to 5 tool rounds per chat turn. Sideband worker connection so tool queries don't queue behind a long primary query.
- **JSON/JSONB tree editor** — collapsible JSON tree with key/value filter inside `CellDetailDialog`.
- **Inline-edit pending tray** — `PendingEditsTray.tsx` + `pendingEdits` state. Buffered cell edits with optimistic local mirror; commits inside a single transaction with rollback on failure; revert refreshes from DB.
- **Prod connection tagging** — `connectionTags` settings + `ProdGateDialog.tsx`. StatusBar pill (green local / amber staging / red prod). Destructive SQL on prod-tagged connections trips a confirm dialog before run.
- **SSH tunnels** — `src/main/ssh-tunnel.ts` (ssh2 + node:net). Per-connection bastion config in settings; main rewrites the worker connect to `127.0.0.1:<random>`. Worker is unaware. UI in ConnectionDialog.
- **Schema diff + migration codegen** — `SchemaDiffDialog.tsx`. Snapshot table list to settings (capped at 50), diff two snapshots (or live vs snapshot), emit ALTER TABLE script.
- **Notebook mode** — `NotebookDialog.tsx`. Markdown + SQL cells, per-cell run, draft persisted to localStorage, Markdown export to clipboard or `.plasma.md` download.
- **Codegen panel** — `CodegenDialog.tsx`. TypeScript / Zod / Prisma / Drizzle / SQLAlchemy 2.0 / DDL output for any picked tables.
- **Cursor streaming + virtualization** — `MAX_DOM_ROWS=1500` clamp + truncation banner in `ResultGrid.tsx`. Server-side cursor streaming is **partial** — see Known limits below.
- **PostGIS map preview** — `PostGisDialog.tsx`. Auto-detects geometry/geography columns; renders any GeoJSON-shaped cells into an SVG with bbox-fit projection.
- **pgvector awareness** — `PgVectorDialog.tsx`. Detects `vector` columns, surfaces dimensions, builds nearest-neighbor SQL with cosine / L2 / inner-product operators (`<=>`, `<->`, `<#>`).

## Global shortcuts cheat sheet

Canonical source: `src/shared/keymap.ts` (native menu, DOM listeners, Monaco, and the ⌘/ dialog all read it). ⌘K = command palette per DESIGN.md §8.2/§8.8; AI panel is ⌘L.

| Keys | Action |
|---|---|
| ⌘K | Command palette |
| ⌘L | Toggle AI panel |
| ⌘/ | Keyboard shortcuts cheat-sheet |
| ⌘T | New query tab |
| ⌘W | Close tab |
| ⌘⏎ | Run selection / statement at cursor |
| ⌘⇧⏎ | Run all (whole buffer) |
| ⌘. | Cancel query |
| ⌘H | Query history |
| ⌘⇧E | Export results as CSV |
| ⌘B | Toggle sidebar |
| ⌘J | Toggle query editor |
| ⌘⇧G | Codegen dialog |
| ⌘⇧N | Notebook dialog |
| ⌘⇧D | Schema diff |
| ⌘⇧F (in editor) | Format SQL |
| ⌘I (in editor) | Ask AI about selection |
| Esc | Close monitor / settings / history canvases |

## Known limits — Redis / OpenSearch
- **Redis cluster mode** — not yet wired. ioredis supports it via `Redis.Cluster`; connection dialog assumes single-node.
- **Redis pub/sub + streams** — basic stream read works (`XRANGE`); live `XREAD BLOCK` / SUBSCRIBE viewer is a follow-up.
- **Redis insert/update UI** — no SET/HSET/RPUSH form yet; users can hit the `redis-cli` tab. Add CRUD modals once the inline-edit model from postgres is generalized.
- **Redis MEMORY USAGE per key** — currently null in scan rows. Pipeline it alongside TYPE/PTTL once we benchmark the cost on large keyspaces.
- **OpenSearch SQL plugin** — not wired. Current canvas is DSL-only. Add a tab kind for the `_sql` endpoint when distribution = `opensearch >= 1.0`.
- **OpenSearch index aliases / templates** — overview only lists concrete indices. Add a separate browser section for aliases + index templates.
- **OpenSearch document edit** — read-only today. PUT/DELETE doc UI gated behind `editMode` is the next step.
- **AI tool use against Redis/OS** — `query_database` tool is postgres-only (uses sideband SQL). Add `redis_command` (allow-list of read commands) + `os_search` tools on the next round.
- **Connection vault — engine column** — migration v2 added `engine` with default `postgres`. No retroactive migration for existing rows is needed; users editing an old connection see Engine locked to `postgres` (correct).

## Known limits (next sprint)

- **Cursor streaming (server)** — virtualization clamp ships in this round, but real `pg-cursor`-backed streaming over an IPC chunk channel is deferred. Today, very large queries still serialize the full result set across worker → main → renderer. Wire a `streamQuery` worker request + chunked event channel before a v0.2 ship.
- **Virtualization (full windowed)** — current cap is a hard 1500-row guard; replace with viewport-aware windowed render (intersection observer + absolute row positioning) so users with pageSize=10000 don't see the truncation banner.
- **Snippet vars** — substitution is plain text replace. Move to parameterized `$N` binds when columns appear in WHERE.
- **Inline-edit highlighting** — `pendingEdits` mutates the row in place; we don't draw an outline on edited cells. Add a `Set<rowKey>` highlight mode in ResultGrid.
- **PostGIS WKB** — only GeoJSON values render. Wrap in `ST_AsGeoJSON()` for now; native WKB hex parser is a follow-up.
- **AI tool use** — single-round only emits one `query_database` tool. Add `list_tables` + `describe_table` once we have the round-trip telemetry to size their context cost.
- **SSH key encryption** — keys ride in plain settings JSON today. Move to safeStorage when we bump the SQLite schema (would also be the right time to migrate `connectionSsh` into a typed table).
- **Schema-diff snapshots** — capped at 50, kept in settings. Move to a dedicated `schema_snapshots` SQLite table on next migration so binary blobs don't bloat the JSON-encoded settings rows.

## Architecture notes

- AI key never leaves the main process. Renderer asks via `ipc.ai.chat`; deltas stream back over the `plasma:ai:event` event channel.
- Worker `sidebandQuery` is the canonical path for any long-running background read (AI tool calls, monitor poll, future `pg_terminate_backend`). Never queues behind a user-issued primary query.
- All new feature toggles + state live in `SettingsShape` (plain SQLite settings table). No new tables this round, no migrations needed.
- Adding a new `WorkerRequest` variant tips TS into a non-distributing `Omit` mode — `DistributiveOmit` in `main/index.ts` keeps the discriminated-union narrowing intact for `callWorker`.
