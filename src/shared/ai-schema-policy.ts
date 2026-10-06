/**
 * Whether schema names may be sent to the AI provider for a connection (SC-20).
 * Shared so the renderer can explain a disabled AI entry point with the same
 * rule main enforces.
 */

/**
 * SC-20: schema names, sample Redis keys and cluster summaries go to the AI
 * provider as the system prompt. Allowed unless the user turned the global
 * "send schema" setting off; prod-tagged connections additionally need the
 * explicit per-connection opt-in (the same switch as row data).
 */
export function isAiSchemaAllowed(
  connectionId: string | null | undefined,
  settings: {
    aiSendSchema?: boolean;
    connectionTags?: Record<string, string>;
    connectionAiRowData?: Record<string, boolean>;
  },
): boolean {
  if (!connectionId) return false;
  if (settings.aiSendSchema === false) return false;
  if (settings.connectionTags?.[connectionId] === 'prod') {
    return settings.connectionAiRowData?.[connectionId] === true;
  }
  return true;
}

/** Tables beyond this many are left out of the schema prompt (the "What is sent" line counts the same). */
export const AI_SCHEMA_MAX_TABLES = 80;
