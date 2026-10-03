import { describe, expect, it } from 'vitest';
import {
  explainAllocation,
  interpretClusterHealth,
  interpretDisks,
  interpretHotThreads,
  parseNodeDisks,
  parseUnassignedShards,
  parseWatermarks,
  summarizeHotThreads,
  watermarkUsedPct,
} from './os-health';

const GB = 1024 ** 3;

describe('allocation explain', () => {
  it('turns decider output into plain language and a fix', () => {
    const e = explainAllocation({
      index: 'logs',
      shard: 0,
      primary: false,
      current_state: 'unassigned',
      unassigned_info: { reason: 'NODE_LEFT' },
      node_allocation_decisions: [
        {
          node_name: 'n1',
          deciders: [{ decider: 'same_shard', decision: 'NO', explanation: 'x' }],
        },
        {
          node_name: 'n2',
          deciders: [
            { decider: 'disk_threshold', decision: 'NO', explanation: 'y' },
            { decider: 'enable', decision: 'YES' },
          ],
        },
      ],
    });
    expect(e?.reason).toContain('node holding this shard left');
    expect(e?.causes[0]).toContain('n1: The node already holds a copy');
    expect(e?.causes[1]).toContain('above its disk watermark');
    expect(e?.fix).toContain('Add a data node');
  });

  it('suggests a reroute retry after repeated failures and tolerates junk', () => {
    const e = explainAllocation({
      index: 'i',
      shard: 1,
      primary: true,
      unassigned_info: { reason: 'ALLOCATION_FAILED' },
      node_allocation_decisions: [
        { node_name: 'n', deciders: [{ decider: 'max_retry', decision: 'NO' }] },
      ],
    });
    expect(e?.fix).toContain('retry_failed');
    expect(explainAllocation(null)).toBeNull();
    expect(explainAllocation({ error: 'no shards' })).toBeNull();
  });
});

describe('cluster health', () => {
  const health = {
    status: 'red',
    number_of_nodes: 3,
    unassigned_shards: 3,
    indices: {
      good: { status: 'green', unassigned_shards: 0 },
      logs: { status: 'red', unassigned_shards: 2 },
      meta: { status: 'yellow', unassigned_shards: 1 },
    },
  };
  const cat = [
    {
      index: 'logs',
      shard: '0',
      prirep: 'p',
      state: 'UNASSIGNED',
      'unassigned.reason': 'NODE_LEFT',
    },
    {
      index: 'meta',
      shard: '0',
      prirep: 'r',
      state: 'UNASSIGNED',
      'unassigned.reason': 'REPLICA_ADDED',
    },
    { index: 'good', shard: '0', prirep: 'p', state: 'STARTED', 'unassigned.reason': '' },
  ];

  it('parses unassigned shards only', () => {
    expect(parseUnassignedShards(cat).map((s) => [s.index, s.primary])).toEqual([
      ['logs', true],
      ['meta', false],
    ]);
  });

  it('diagnoses red and yellow indices separately', () => {
    const exp = explainAllocation({
      index: 'logs',
      shard: 0,
      primary: true,
      unassigned_info: { reason: 'NODE_LEFT' },
      node_allocation_decisions: [
        { node_name: 'n1', deciders: [{ decider: 'disk_threshold', decision: 'NO' }] },
      ],
    });
    const r = interpretClusterHealth(health, exp ? [exp] : [], parseUnassignedShards(cat));
    expect(r.status).toBe('crit');
    const logs = r.findings.find((f) => f.id === 'index:logs');
    expect(logs?.status).toBe('crit');
    expect(logs?.title).toContain('data is unavailable');
    expect(logs?.evidence).toContain('disk watermark');
    const meta = r.findings.find((f) => f.id === 'index:meta');
    expect(meta?.status).toBe('warn');
    expect(meta?.evidence).toContain('replica was added');
    expect(r.findings.some((f) => f.id === 'index:good')).toBe(false);
  });

  it('is ok for a green cluster and unknown without data', () => {
    expect(interpretClusterHealth({ status: 'green', indices: {} }, []).status).toBe('ok');
    expect(interpretClusterHealth(null, []).status).toBe('unknown');
  });
});

describe('disk watermarks', () => {
  it('reads configured watermarks over defaults', () => {
    expect(
      parseWatermarks({
        defaults: { 'cluster.routing.allocation.disk.watermark.low': '85%' },
        persistent: { 'cluster.routing.allocation.disk.watermark.low': '70%' },
      }).low,
    ).toBe('70%');
    expect(parseWatermarks(null).floodStage).toBe('95%');
  });

  it('resolves byte-size watermarks against disk size', () => {
    expect(watermarkUsedPct('90%', 0)).toBe(90);
    expect(watermarkUsedPct('50gb', 200 * GB)).toBeCloseTo(75, 5);
    expect(watermarkUsedPct('weird', 100)).toBeNull();
  });

  it('grades nodes against low, high and flood stage', () => {
    const disks = parseNodeDisks([
      {
        node: 'a',
        'disk.percent': '50',
        'disk.used': String(50 * GB),
        'disk.total': String(100 * GB),
        shards: '3',
      },
      {
        node: 'b',
        'disk.percent': '87',
        'disk.used': String(87 * GB),
        'disk.total': String(100 * GB),
        shards: '3',
      },
      {
        node: 'c',
        'disk.percent': '93',
        'disk.used': String(93 * GB),
        'disk.total': String(100 * GB),
        shards: '3',
      },
      {
        node: 'd',
        'disk.percent': '97',
        'disk.used': String(97 * GB),
        'disk.total': String(100 * GB),
        shards: '3',
      },
      { node: 'UNASSIGNED', shards: '2' },
    ]);
    expect(disks).toHaveLength(4);
    const r = interpretDisks(disks, parseWatermarks(null));
    expect(r.findings.map((f) => [f.id, f.status])).toEqual([
      ['disk:b', 'warn'],
      ['disk:c', 'crit'],
      ['disk:d', 'crit'],
    ]);
    expect(r.findings[2]?.title).toContain('flood-stage');
    expect(r.note).toContain('low 85%');
  });
});

describe('hot threads', () => {
  const text = `::: {node-1}{abc}{10.0.0.1}
   Hot threads at 2026-10-02T10:00:00Z, interval=500ms, busiestThreads=3, ignoreIdleThreads=true:

   92.4% (462ms out of 500ms) cpu usage by thread 'opensearch[node-1][search][T#3]'
     10/10 snapshots sharing following 20 elements
   12.0% (60ms out of 500ms) cpu usage by thread 'opensearch[node-1][write][T#1]'

::: {node-2}{def}{10.0.0.2}
   5.0% (25ms out of 500ms) cpu usage by thread 'opensearch[node-2][management][T#1]'
`;

  it('summarises the busiest thread per node', () => {
    const s = summarizeHotThreads(text);
    expect(s).toHaveLength(2);
    expect(s[0]).toMatchObject({ node: 'node-1', topPercent: 92.4, kind: 'cpu', count: 2 });
    expect(s[0]?.topThread).toContain('[search]');
  });

  it('flags nodes with a saturated thread', () => {
    const r = interpretHotThreads(summarizeHotThreads(text));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.evidence).toContain('search');
    expect(interpretHotThreads([]).summary).toBe('No data');
  });
});
