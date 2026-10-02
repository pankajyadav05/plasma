import { describe, expect, it } from 'vitest';
import { SettingsShape } from './protocol';

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
