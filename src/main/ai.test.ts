import { describe, expect, it } from 'vitest';
import {
  AI_TOOL_MAX_BYTES,
  AI_TOOL_MAX_ROWS,
  buildOpenRouterBody,
  isAiRowDataAllowed,
  isReadOnlySql,
  serializeAiToolRows,
} from './ai';

describe('isAiRowDataAllowed (U06)', () => {
  it('defaults off for missing connection and missing map entry', () => {
    expect(isAiRowDataAllowed(null, {})).toBe(false);
    expect(isAiRowDataAllowed('c1', {})).toBe(false);
    expect(isAiRowDataAllowed('c1', { c1: false })).toBe(false);
  });

  it('requires explicit true even for non-prod connections', () => {
    expect(isAiRowDataAllowed('c1', { c1: true })).toBe(true);
  });
});

describe('isReadOnlySql pre-filter (U04)', () => {
  it('accepts simple selects as a cheap pre-filter', () => {
    expect(isReadOnlySql('SELECT 1')).toBe(true);
    expect(isReadOnlySql('EXPLAIN SELECT 1')).toBe(true);
  });

  it('still accepts write-capable shapes that DB read-only must block', () => {
    // Documented advisor cases — predicate alone is insufficient.
    expect(
      isReadOnlySql('WITH removed AS (DELETE FROM accounts RETURNING *) SELECT * FROM removed'),
    ).toBe(true);
    expect(isReadOnlySql('EXPLAIN ANALYZE DELETE FROM accounts')).toBe(true);
    expect(isReadOnlySql('SELECT 1; DROP TABLE accounts')).toBe(true);
  });

  it('rejects obvious mutations at the pre-filter', () => {
    expect(isReadOnlySql('DELETE FROM accounts')).toBe(false);
    expect(isReadOnlySql('UPDATE accounts SET x = 1')).toBe(false);
  });
});

describe('serializeAiToolRows caps (U06)', () => {
  it('caps by row count and labels truncation', () => {
    const rows = Array.from({ length: 80 }, (_, i) => [i, `v${i}`]);
    const json = serializeAiToolRows({
      columns: ['id', 'v'],
      rows,
      rowCount: 80,
      maxRows: 10,
      maxBytes: AI_TOOL_MAX_BYTES,
    });
    const parsed = JSON.parse(json) as {
      rows: unknown[];
      truncated: boolean;
      capped: { maxRows: number };
    };
    expect(parsed.rows).toHaveLength(10);
    expect(parsed.truncated).toBe(true);
    expect(parsed.capped.maxRows).toBe(10);
  });

  it('shrinks further when byte cap is tight', () => {
    const rows = Array.from({ length: 20 }, (_, i) => [i, 'x'.repeat(200)]);
    const json = serializeAiToolRows({
      columns: ['id', 'blob'],
      rows,
      rowCount: 20,
      maxRows: AI_TOOL_MAX_ROWS,
      maxBytes: 800,
    });
    expect(json.length).toBeLessThanOrEqual(800);
    const parsed = JSON.parse(json) as { truncated: boolean; rows?: unknown[] };
    expect(parsed.truncated).toBe(true);
  });
});

describe('OpenRouter request body policy (U06)', () => {
  it('omits tools when row-data consent is off', () => {
    const body = buildOpenRouterBody({
      model: 'test/model',
      messages: [{ role: 'user', content: 'hi' }],
      tools: null,
    });
    const parsed = JSON.parse(body) as { tools?: unknown };
    expect(parsed.tools).toBeUndefined();
  });

  it('includes tools when consent is on', () => {
    const tools = [{ type: 'function', function: { name: 'query_database' } }];
    const body = buildOpenRouterBody({
      model: 'test/model',
      messages: [{ role: 'user', content: 'hi' }],
      tools,
    });
    const parsed = JSON.parse(body) as { tools: unknown[] };
    expect(parsed.tools).toHaveLength(1);
  });

  it('captures tool row egress in a follow-up request body when consented', () => {
    const toolResult = serializeAiToolRows({
      columns: ['id'],
      rows: [[1], [2], [3]],
      rowCount: 3,
    });
    const messages = [
      { role: 'user', content: 'how many?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'query_database', arguments: '{"sql":"SELECT 1"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: toolResult },
    ];
    const body = buildOpenRouterBody({
      model: 'test/model',
      messages,
      tools: [{ type: 'function', function: { name: 'query_database' } }],
    });
    // Regression: outgoing OpenRouter body carries capped tool row data
    // only on the consented path (tools present + tool role message).
    const parsed = JSON.parse(body) as {
      messages: Array<{ role: string; content?: string }>;
      tools?: unknown[];
    };
    expect(parsed.tools).toBeDefined();
    const toolMsg = parsed.messages.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    const toolPayload = JSON.parse(toolMsg!.content ?? '{}') as {
      rows: Array<{ id: number }>;
      capped: { maxRows: number; maxBytes: number };
    };
    expect(toolPayload.rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(toolPayload.capped.maxRows).toBe(AI_TOOL_MAX_ROWS);
    expect(toolPayload.capped.maxBytes).toBe(AI_TOOL_MAX_BYTES);
  });
});
