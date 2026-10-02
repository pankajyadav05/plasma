import { describe, expect, it } from 'vitest';
import { AiChatRequest, ExplainRequest, SettingsShape } from './protocol';

describe('SettingsShape — Settings reorganisation fields (SS3)', () => {
  it('fills defaults for a legacy settings row', () => {
    const s = SettingsShape.parse({});
    expect(s.restoreWorkspace).toBe(true);
    expect(s.safeModeDefault).toBe('confirm-dangerous');
    expect(s.connectionSafeMode).toEqual({});
    expect(s.csvExport).toEqual({
      delimiter: ',',
      header: true,
      quote: '"',
      nullAs: 'empty',
      lineEnding: 'lf',
    });
    expect(s.gridAlternatingRows).toBe(true);
    expect(s.estimatedCountThreshold).toBe(100_000);
  });

  it('keeps valid values and repairs bad ones instead of failing the whole parse', () => {
    const s = SettingsShape.parse({
      safeModeDefault: 'bogus',
      csvExport: { delimiter: ';', nullAs: 'NULL' },
      estimatedCountThreshold: -5,
      gridAlternatingRows: false,
    });
    expect(s.safeModeDefault).toBe('confirm-dangerous');
    expect(s.csvExport.delimiter).toBe(';');
    expect(s.csvExport.nullAs).toBe('NULL');
    expect(s.csvExport.header).toBe(true);
    expect(s.estimatedCountThreshold).toBe(100_000);
    expect(s.gridAlternatingRows).toBe(false);
  });
});

describe('result size cap and CSV formula guard settings (P2-3, SC-15)', () => {
  it('accepts 1..256 MB, falls back to 32 for nonsense, and stays absent by default', () => {
    expect(SettingsShape.parse({ resultMaxMegabytes: 128 }).resultMaxMegabytes).toBe(128);
    expect(SettingsShape.parse({ resultMaxMegabytes: 9999 }).resultMaxMegabytes).toBe(32);
    expect(SettingsShape.parse({}).resultMaxMegabytes).toBeUndefined();
  });

  it('keeps the CSV formula guard on unless it is explicitly off', () => {
    expect(SettingsShape.parse({}).csvExport.formulaGuard).toBeUndefined();
    expect(SettingsShape.parse({ csvExport: { formulaGuard: false } }).csvExport.formulaGuard).toBe(
      false,
    );
  });
});

describe('SettingsShape — snippets and query variables', () => {
  it('defaults to no snippets and no variable history', () => {
    const s = SettingsShape.parse({});
    expect(s.snippets).toEqual([]);
    expect(s.variableHistory).toEqual({});
  });

  it('keeps user snippets and saved-query variable values', () => {
    const s = SettingsShape.parse({
      snippets: [
        { id: 'a', name: 'n', prefix: 'p', body: 'select $0', createdAt: 1, updatedAt: 2 },
      ],
      savedQueries: {
        c1: [
          {
            kind: 'sql',
            id: 'q',
            name: 'q',
            createdAt: 1,
            updatedAt: 1,
            sql: 'select :a',
            variables: { a: { mode: 'raw', value: 'x' } },
          },
        ],
      },
    });
    expect(s.snippets[0]?.description).toBe('');
    const q = s.savedQueries.c1?.[0];
    expect(q?.kind === 'sql' && q.variables).toEqual({ a: { mode: 'raw', value: 'x' } });
  });

  it('rejects an unknown variable mode', () => {
    expect(() =>
      SettingsShape.parse({
        savedQueries: {
          c1: [
            {
              kind: 'sql',
              id: 'q',
              name: 'q',
              createdAt: 1,
              updatedAt: 1,
              sql: 's',
              variables: { a: { mode: 'eval', value: 'x' } },
            },
          ],
        },
      }),
    ).toThrow();
  });
});

describe('AI task and explain request shapes', () => {
  it('accepts only the three one-shot tasks', () => {
    const base = { requestId: 'r', messages: [] };
    for (const task of ['fix-sql', 'explain-plan', 'nl-filter']) {
      expect(AiChatRequest.parse({ ...base, task }).task).toBe(task);
    }
    expect(AiChatRequest.parse(base).task).toBeUndefined();
    expect(() => AiChatRequest.parse({ ...base, task: 'run-sql' })).toThrow();
  });

  it('explain carries bind parameters', () => {
    expect(
      ExplainRequest.parse({ sql: 'select $1', analyze: false, params: ['1'] }).params,
    ).toEqual(['1']);
  });
});
