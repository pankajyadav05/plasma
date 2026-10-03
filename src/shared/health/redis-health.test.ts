import { describe, expect, it } from 'vitest';
import {
  buildPrefixTree,
  clientKillCommand,
  interpretBigKeys,
  interpretClients,
  interpretHotKeys,
  interpretLatency,
  interpretSlowlog,
  isLfuError,
  parseClientList,
  parseLatencyLatest,
  squarify,
  summarizeSlowlog,
  topBigKeys,
  topPrefixes,
} from './redis-health';

const MB = 1024 * 1024;
const k = (key: string, bytes: number | null, type = 'string') => ({ key, type, bytes });

describe('big keys', () => {
  it('ranks by size, skips unsized keys and grades by threshold', () => {
    const samples = [
      k('a', 10),
      k('huge', 80 * MB, 'hash'),
      k('big', 3 * MB, 'list'),
      k('n/a', null),
    ];
    expect(topBigKeys(samples).map((s) => s.key)).toEqual(['huge', 'big', 'a']);
    const r = interpretBigKeys(samples, 4);
    expect(r.status).toBe('crit');
    expect(r.findings.map((f) => f.status)).toEqual(['crit', 'warn']);
    expect(interpretBigKeys([k('a', 10)], 1).status).toBe('ok');
    expect(interpretBigKeys([], 0).summary).toBe('Not sampled yet');
  });
});

describe('hot keys', () => {
  it('explains how to enable LFU when it is off', () => {
    const r = interpretHotKeys([], false);
    expect(r.status).toBe('unknown');
    expect(r.findings[0]?.action?.note).toContain('allkeys-lfu');
    expect(
      isLfuError('ERR An LFU maxmemory policy is not selected, access frequency not tracked.'),
    ).toBe(true);
  });

  it('lists the hottest keys and flags saturated counters', () => {
    const r = interpretHotKeys(
      [
        { key: 'a', freq: 10 },
        { key: 'b', freq: 250 },
      ],
      true,
    );
    expect(r.table?.rows[0]).toEqual({ key: 'b', freq: '250' });
    expect(r.findings.map((f) => f.id)).toEqual(['hotkey:b']);
  });
});

describe('prefix tree and treemap', () => {
  const samples = [
    k('user:1:profile', 100),
    k('user:2:profile', 300),
    k('user:2:cart', 50),
    k('session:abc', 200),
    k('plain', 10),
  ];

  it('groups by prefix, excluding the key name itself', () => {
    const tree = buildPrefixTree(samples);
    expect(tree.bytes).toBe(660);
    expect(tree.count).toBe(5);
    const top = topPrefixes(tree);
    expect(top.map((n) => [n.name, n.bytes, n.count])).toEqual([
      ['user', 450, 3],
      ['session', 200, 1],
      ['(no prefix)', 10, 1],
    ]);
    const user = top[0];
    expect(user?.children.map((c) => [c.path, c.bytes])).toEqual([
      ['user:2', 350],
      ['user:1', 100],
    ]);
  });

  it('honours maxDepth and delimiter', () => {
    const tree = buildPrefixTree([k('a/b/c/d', 5)], { delimiter: '/', maxDepth: 1 });
    expect(tree.children[0]?.children).toEqual([]);
    expect(tree.children[0]?.name).toBe('a');
  });

  it('lays rectangles out inside the box with areas proportional to value', () => {
    const items = [{ v: 6 }, { v: 3 }, { v: 2 }, { v: 1 }, { v: 0 }];
    const rects = squarify(items, (i) => i.v, 120, 100);
    expect(rects).toHaveLength(4);
    const area = rects.reduce((a, r) => a + r.w * r.h, 0);
    expect(area).toBeCloseTo(12000, 3);
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(-1e-9);
      expect(r.y).toBeGreaterThanOrEqual(-1e-9);
      expect(r.x + r.w).toBeLessThanOrEqual(120 + 1e-6);
      expect(r.y + r.h).toBeLessThanOrEqual(100 + 1e-6);
      expect(r.w * r.h).toBeCloseTo((r.item.v / 12) * 12000, 3);
    }
    expect(squarify([], (i: number) => i, 10, 10)).toEqual([]);
  });
});

describe('latency and slowlog', () => {
  it('parses LATENCY LATEST and grades the worst spike', () => {
    const ev = parseLatencyLatest([
      ['command', 1700000000, 12, 150],
      ['fork', 1700000100, 3, 2500],
    ]);
    expect(ev[0]?.event).toBe('fork');
    const r = interpretLatency(ev);
    expect(r.status).toBe('crit');
    expect(r.findings.map((f) => f.status)).toEqual(['crit', 'warn']);
    expect(parseLatencyLatest('nope')).toEqual([]);
  });

  it('explains an empty report depending on the monitor', () => {
    expect(interpretLatency([], true).status).toBe('ok');
    expect(interpretLatency([], false).findings[0]?.id).toBe('latency-off');
  });

  it('summarises the slow log by command', () => {
    const entries = [
      { durationUs: 2_000_000, argv: ['KEYS', '*'] },
      { durationUs: 50_000, argv: ['keys', 'a*'] },
      { durationUs: 20_000, argv: ['CONFIG', 'get', 'x'] },
    ];
    const rows = summarizeSlowlog(entries);
    expect(rows[0]).toEqual({ command: 'KEYS', count: 2, totalUs: 2_050_000, maxUs: 2_000_000 });
    expect(rows[1]?.command).toBe('CONFIG GET');
    const r = interpretSlowlog(entries);
    expect(r.status).toBe('crit');
    expect(interpretSlowlog([]).summary).toBe('Slow log is empty');
  });
});

describe('clients', () => {
  const reply =
    'id=3 addr=127.0.0.1:5000 laddr=x name=worker age=100 idle=7200 flags=b db=0 cmd=blpop omem=0 tot-mem=1000\n' +
    'id=4 addr=127.0.0.1:5001 name= age=10 idle=0 flags=N db=1 cmd=client omem=67108864 tot-mem=900\n';

  it('parses CLIENT LIST lines', () => {
    const c = parseClientList(reply);
    expect(c).toHaveLength(2);
    expect(c[0]).toMatchObject({ id: '3', name: 'worker', db: '0', idleS: 7200, totMem: 1000 });
    expect(parseClientList(null)).toEqual([]);
  });

  it('flags output-buffer hogs with a kill preview and blocked clients', () => {
    const r = interpretClients(parseClientList(reply));
    expect(r.findings.map((f) => f.id)).toEqual(['client-blocked:3', 'client-omem:4']);
    expect(r.status).toBe('crit');
    expect(r.findings.find((f) => f.id === 'client-omem:4')?.action?.note).toBe('CLIENT KILL ID 4');
  });

  it('warns near maxclients and only builds numeric kill commands', () => {
    expect(interpretClients(parseClientList(reply), 2).status).toBe('crit');
    expect(clientKillCommand('12')).toEqual(['CLIENT', 'KILL', 'ID', '12']);
    expect(clientKillCommand('12 SKIPME no')).toBeNull();
  });
});

describe('memory', () => {
  it('parses INFO and grades usage against maxmemory', async () => {
    const { parseInfo, interpretMemory } = await import('./redis-health');
    const info = parseInfo(
      '# Memory\r\nused_memory:950\r\nmaxmemory:1000\r\nmaxmemory_policy:noeviction\r\nmem_fragmentation_ratio:1.1\r\n',
    );
    expect(info.used_memory).toBe('950');
    expect(interpretMemory(info).status).toBe('warn');
    expect(interpretMemory({ ...info, used_memory: '999' }).status).toBe('crit');
    expect(interpretMemory({ used_memory: '10', maxmemory: '0' }).summary).toContain('no limit');
    expect(parseInfo(5)).toEqual({});
  });

  it('flags swapping-looking fragmentation', async () => {
    const { interpretMemory } = await import('./redis-health');
    const r = interpretMemory({
      used_memory: String(500 * 1024 * 1024),
      maxmemory: '0',
      mem_fragmentation_ratio: '0.6',
    });
    expect(r.findings[0]?.id).toBe('mem-swap');
  });
});
