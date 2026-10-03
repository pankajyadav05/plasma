import { describe, expect, it } from 'vitest';
import {
  type ActivitySession,
  activityIsPartial,
  blockingChain,
  buildLockGraph,
  lockTreeRows,
  parseActivity,
} from './pg-activity';

const s = (
  pid: number,
  blockedBy: number[] = [],
  over: Partial<ActivitySession> = {},
): ActivitySession => ({
  pid,
  state: 'active',
  user: 'u',
  database: 'd',
  applicationName: null,
  clientAddr: null,
  backendStart: null,
  queryStart: null,
  stateChange: null,
  waitEventType: null,
  waitEvent: null,
  query: 'q',
  durationMs: null,
  isCurrent: false,
  blockedBy,
  canSeeAll: true,
  ...over,
});

describe('lock-wait graph', () => {
  // 1 blocks 2 and 3; 3 blocks 4; 9 is unrelated.
  const sessions = [
    s(1, [], { state: 'idle in transaction' }),
    s(2, [1]),
    s(3, [1]),
    s(4, [3]),
    s(9),
  ];
  const graph = buildLockGraph(sessions);

  it('finds the head of the chain', () => {
    expect(graph.roots).toEqual([1]);
    expect(graph.nodes.has(9)).toBe(false);
  });

  it('highlights the whole chain around a session', () => {
    expect([...blockingChain(graph, 4)].sort()).toEqual([1, 3, 4]);
    expect([...blockingChain(graph, 1)].sort()).toEqual([1, 2, 3, 4]);
    expect(blockingChain(graph, 9).size).toBe(0);
  });

  it('flattens to an indented tree', () => {
    expect(lockTreeRows(graph).map((r) => [r.pid, r.depth])).toEqual([
      [1, 0],
      [2, 1],
      [3, 1],
      [4, 2],
    ]);
  });

  it('keeps a blocker that is missing from the snapshot', () => {
    const g = buildLockGraph([s(5, [77])]);
    expect(g.roots).toEqual([77]);
    expect(g.nodes.get(77)?.session).toBeUndefined();
  });

  it('survives a deadlock cycle', () => {
    const g = buildLockGraph([s(1, [2]), s(2, [1])]);
    const rows = lockTreeRows(g);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(2);
  });
});

describe('activity parsing', () => {
  it('parses blocking pids and privilege visibility', () => {
    const rows = parseActivity([
      {
        pid: 5,
        state: 'active',
        blocked_by: '1,2',
        duration_ms: '12.5',
        is_current: 'f',
        can_see_all: false,
      },
    ]);
    expect(rows[0]?.blockedBy).toEqual([1, 2]);
    expect(rows[0]?.durationMs).toBe(12.5);
    expect(activityIsPartial(rows)).toBe(true);
    expect(parseActivity([{ pid: 1, blocked_by: '' }])[0]?.blockedBy).toEqual([]);
  });
});
