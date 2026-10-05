/**
 * Shared types of the session store. The state is split into slices (one
 * `createXSlice` module per domain, composed by `session.ts`); each slice
 * declares its own interface and `SessionState` is their intersection.
 * `session.ts` re-exports the public names from here.
 */
import type { Filter, TableSort } from '@/lib/table-query';
import type { AiMessage, QueryResult } from '@shared/protocol';
import type { VariableValue } from '@shared/sql-variables';
import type { StateCreator } from 'zustand';
import type { AiSlice } from './session-ai';
import type { ConnectionSlice } from './session-connection';
import type { HistorySlice } from './session-history';
import type { OpenSearchSlice } from './session-opensearch';
import type { ProdGateSlice } from './session-prod-gate';
import type { QuerySlice } from './session-query';
import type { RedisSlice } from './session-redis';
import type { RolesSlice } from './session-roles';
import type { SafeRunSlice } from './session-safe-run';
import type { SavedQueriesSlice } from './session-saved-queries';
import type { SchemaSlice } from './session-schema';
import type { SettingsSlice } from './session-settings';
import type { TableSlice } from './session-table';
import type { TabsSlice } from './session-tabs';
import type { UiSlice } from './session-ui';

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'error';
export type QueryRunState = 'idle' | 'running';
/**
 * Tab kinds.
 *  - sql/table     → Postgres
 *  - redis-key     → key viewer (string/list/set/zset/hash/stream/json)
 *  - redis-cli     → free-form Redis command terminal
 *  - redis-pubsub  → live tail of one channel / pattern
 *  - redis-analyze → memory analyzer scan result
 *  - redis-slowlog → SLOWLOG GET viewer
 *  - os-search     → OpenSearch DSL editor + result grid (Discover)
 *  - os-index      → OpenSearch index detail (mapping + stats)
 *  - os-sql        → OpenSearch SQL plugin canvas
 *  - os-console    → OpenSearch Dev Tools console (raw REST, O14)
 *  - er-diagram    → entity-relationship diagram of a schema / table selection
 *  - pg-listen     → Postgres LISTEN/NOTIFY tail
 */
export type TabKind =
  | 'sql'
  | 'table'
  | 'redis-key'
  | 'redis-cli'
  | 'redis-pubsub'
  | 'redis-analyze'
  | 'redis-slowlog'
  | 'redis-server'
  | 'os-search'
  | 'os-index'
  | 'os-sql'
  | 'os-console'
  | 'er-diagram'
  | 'pg-listen';
export type TableViewMode = 'data' | 'structure' | 'definition';
export type EntityKind =
  | 'table'
  | 'view'
  | 'matview'
  | 'foreign'
  | 'partitioned'
  | 'function'
  | 'procedure'
  | 'sequence'
  | 'type'
  | 'extension';
/** Drives what the main right-side canvas renders. Switched from IconRail. */
export type CanvasMode = 'database' | 'history' | 'settings' | 'monitor' | 'connections';
/** Which slot of the right rail is currently expanded. null = collapsed. */
export type RightPanelMode = 'details' | 'query' | 'role' | 'rls' | 'ai' | null;

/** One row in the AI chat transcript. Streamed assistant messages mutate
 *  in place as deltas arrive — keep them flat strings. */
export interface AiTurn extends AiMessage {
  id: string;
  /** True while a streamed assistant turn is still receiving deltas. */
  streaming?: boolean;
  /** Server-side error captured for this turn, if any. */
  error?: string;
}

/**
 * Build a stable key for per-table column state persistence. We prefix
 * with the connection id so two tables with the same schema.name across

/**
 * One queued, uncommitted cell edit. Buffered edits accumulate as the
 * user types in the grid; nothing hits the database until they click
 * "Commit (N)" in the tray. PK identification is captured at queue
 * time so a later refresh / sort doesn't break the WHERE clause.
 */
export interface PendingEdit {
  id: string;
  tabId: string;
  schema: string;
  table: string;
  /** 'update' (default when absent) · 'delete' · 'insert'. */
  kind?: 'update' | 'delete' | 'insert';
  /** ORIGINAL (server) primary-key values as Postgres text; {} for inserts. */
  pkValues: Record<string, unknown>;
  /** Stable row identity (rowKeyOf(pkValues)) — survives paging / sorting. */
  rowKey?: string;
  /** Updated column; '' for insert / delete. */
  column: string;
  oldValue: unknown;
  /** Postgres text for the new value; null = SQL NULL. */
  newValue: string | null;
  /** Insert only: column → Postgres text (null = NULL); omitted = DEFAULT. */
  values?: Record<string, string | null>;
  /** Visible row index at queue time, used for in-grid highlighting. */
  rowIndex: number;
  columnIndex: number;
  connectionGen?: number;
}

export interface QueryTab {
  // biome-ignore lint/suspicious/noExplicitAny: tabs of every engine carry ad-hoc fields
  [key: string]: any;
  id: string;
  title: string;
  kind: TabKind;

  /**
   * For SQL tabs this is the user-edited query. For table tabs it's
   * the last compiled query (read-only display so users can see what's
   * running under the hood).
   */
  sql: string;

  // ── Common query state ──
  queryRunState: QueryRunState;
  queryResult: QueryResult | null;
  queryError: string | null;
  queryErrorSql: string | null;
  page: number;
  pageSize: number;
  selectedCell: { row: number; col: number } | null;
  /**
   * Page-scoped row selection — indices into the currently rendered
   * `displayRows` array. Used for "export selected" / "copy selected".
   * Cleared whenever the visible rows change (page / sort / re-run).
   */
  selectedRows: Set<number>;
  columnWidths: Record<number, number>;

  // ── SQL tab fields (client-side sort) ──
  sortColumn: { index: number; direction: 'asc' | 'desc' } | null;

  // ── Table tab fields (server-side sort/filter/hide) ──
  tableSchema?: string;
  tableName?: string;
  tableSort: TableSort[];
  filters: Filter[];
  hiddenColumns: Set<string>;
  stickyColumns: Set<string>;
  totalRowCount: number | null;
  /** True when totalRowCount comes from pg_class.reltuples, not COUNT(*). */
  totalRowCountIsEstimate: boolean;
  countLoading: boolean;
  /** Table tabs: 'data' = grid, 'structure' = columns/constraints/indexes, 'definition' = DDL. SQL tabs ignore. */
  viewMode: TableViewMode;
  /** RLS policy count for the table backing this tab. null = not yet loaded. */
  rlsPolicyCount: number | null;
  /** Saved query this tab was opened from / saved as — "Update" writes back to it (PC6). */
  savedQueryId?: string;

  // ── Query variables (SQL tabs) ──
  /** Typed values by variable name (`:name`, `:'name'`, `$name`); see `@shared/sql-variables`. */
  queryVars?: Record<string, VariableValue>;
  /** Variables bar visible above the results. */
  varsBarOpen?: boolean;
  /** The user has looked at the values since the tab opened — Run no longer stops to ask. */
  varsReviewed?: boolean;
  /** Why the last Run stopped at the bar (missing / invalid value), shown in it. */
  varsAttention?: string | null;

  // ── Redis tab fields (kind = 'redis-key' / 'redis-cli') ──
  /** Key currently being viewed in a redis-key tab. */
  redisKey?: string;
  /** Database the redis-key tab reads from (R5) — independent of the sidebar db. */
  redisDb?: number;
  /** Pub/sub channel/pattern for a redis-pubsub tab. */
  redisChannel?: string;
  redisPattern?: boolean;

  // ── OpenSearch tab fields (kind = 'os-search' / 'os-index' / 'os-sql') ──
  /** Index targeted by an os-search or os-index tab. */
  osIndex?: string;
  /** Cached DSL JSON body for an os-search tab. */
  osBody?: string;
  /** KQL/Lucene query string for the Discover canvas. */
  osQueryString?: string;
  /** Cached SQL text for an os-sql tab. */
  osSql?: string;
}

/** The whole store: every slice's state and actions. */
export type SessionState = ConnectionSlice &
  SchemaSlice &
  RedisSlice &
  OpenSearchSlice &
  QuerySlice &
  TableSlice &
  TabsSlice &
  RolesSlice &
  SavedQueriesSlice &
  SettingsSlice &
  HistorySlice &
  AiSlice &
  ProdGateSlice &
  SafeRunSlice &
  UiSlice & {
    // biome-ignore lint/suspicious/noExplicitAny: features read engine-specific extras (redisOverviewAt, …) off the store
    [key: string]: any;
  };

/** A slice factory, composed into the store by `session.ts`. */
export type SliceCreator<T> = StateCreator<SessionState, [], [], T>;
