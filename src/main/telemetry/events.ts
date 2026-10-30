import type { ConnectionEngine, Settings } from '@shared/protocol';

/**
 * Every event Plasma can send, and everything it can carry. Values are booleans,
 * closed enums and buckets: nothing here can hold SQL, row data, a host, a
 * database, schema or connection name, a path, or an error message (those quote
 * values). Keep it that way; see docs/product-analytics.md.
 */
export interface AnalyticsEvents {
  'app.launched': { previousExit: 'clean' | 'unclean' | 'update' };
  'connection.opened': { engine: ConnectionEngine; ssh: boolean; tls: boolean; readOnly: boolean };
  'connection.failed': { engine: ConnectionEngine; ssh: boolean };
  'connection.recovered': { engine: ConnectionEngine };
  'connection.lost': { engine?: ConnectionEngine };
  'query.executed': {
    engine?: ConnectionEngine;
    status: 'ok' | 'error';
    source: 'editor' | 'ai';
    duration?: DurationBucket;
  };
  'ai.chat.started': { provider: Settings['aiProvider'] };
  'mcp.tool.invoked': { tool: McpToolName; outcome: 'ok' | 'denied' | 'declined' | 'error' };
  'feature.used': { feature: Feature };
}

export type AnalyticsEventName = keyof AnalyticsEvents;

/** The MCP server's own tools. A name outside this list is not reported. */
const MCP_TOOL_NAMES = [
  'list_connections',
  'get_schema',
  'run_query',
  'propose_change',
  'check_proposal',
  'remember',
  'get_memory',
] as const;
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

export function isMcpToolName(name: string): name is McpToolName {
  return (MCP_TOOL_NAMES as readonly string[]).includes(name);
}

export type DurationBucket = '<100ms' | '<1s' | '<10s' | '<1m' | '>=1m';

/** A rough duration: enough to see slow use, too coarse to fingerprint a query. */
export function durationBucket(ms: number): DurationBucket {
  if (ms < 100) return '<100ms';
  if (ms < 1_000) return '<1s';
  if (ms < 10_000) return '<10s';
  if (ms < 60_000) return '<1m';
  return '>=1m';
}

/**
 * IPC requests that mean a person started a feature, by channel. Allowlisted so
 * plumbing (schema loads, pickers, polling) stays out, and only the channel is
 * read, so a payload can never reach analytics.
 */
export const FEATURE_BY_CHANNEL = {
  'plasma:conn:test': 'connection.test',
  'plasma:vault:save': 'connection.save',
  'plasma:vault:duplicate': 'connection.duplicate',
  'plasma:query:commitEditBatch': 'grid.commit_edits',
  'plasma:query:explain': 'query.explain',
  'plasma:query:safeRun': 'query.safe_run',
  'plasma:query:safeRunUndo': 'query.safe_run_undo',
  'plasma:structure:apply': 'structure.apply',
  'plasma:sql:format': 'sql.format',
  'plasma:import:run': 'import.run',
  'plasma:export:save': 'export.save',
  'plasma:export:all': 'export.all',
  'plasma:compare:run': 'compare.run',
  'plasma:schemaSnapshot:save': 'schema_snapshot.save',
  'plasma:admin:backup': 'admin.backup',
  'plasma:admin:restore': 'admin.restore',
  'plasma:sqlite:backupCopy': 'sqlite.backup_copy',
  'plasma:audit:export': 'audit.export',
  'plasma:memory:add': 'memory.add',
  'plasma:ai:run-readonly': 'ai.run_readonly',
  'plasma:ai:action-approved': 'ai.action_approved',
  'plasma:redis:subscribe': 'redis.subscribe',
  'plasma:os:search': 'opensearch.search',
  'plasma:os:sql': 'opensearch.sql',
  'plasma:pg:listen': 'postgres.listen',
} as const;

export type Feature = (typeof FEATURE_BY_CHANNEL)[keyof typeof FEATURE_BY_CHANNEL];

export function featureForChannel(channel: string): Feature | undefined {
  return Object.hasOwn(FEATURE_BY_CHANNEL, channel)
    ? FEATURE_BY_CHANNEL[channel as keyof typeof FEATURE_BY_CHANNEL]
    : undefined;
}
