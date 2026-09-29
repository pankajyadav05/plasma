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
