import { describe, expect, it } from 'vitest';
import { bump, installerName, nextReleaseVersion } from './next-version.mjs';

const none = () => false;

describe('nextReleaseVersion', () => {
  it('goes one patch above the highest version published for the chosen platforms', () => {
    // Linux already has 3.1.4, Windows and macOS 3.1.3: releasing all needs 3.1.5.
    expect(
      nextReleaseVersion({ current: '3.1.4', published: ['3.1.3', '3.1.3', '3.1.4'], taken: none }),
    ).toBe('3.1.5');
  });

  it('keeps a manual bump that is already above everything published', () => {
    expect(nextReleaseVersion({ current: '3.2.0', published: ['3.1.4'], taken: none })).toBe('3.2.0');
  });

  it('makes minor and major always a step of that size', () => {
    expect(
      nextReleaseVersion({ current: '3.1.4', published: ['3.1.4'], kind: 'minor', taken: none }),
    ).toBe('3.2.0');
    expect(
      nextReleaseVersion({ current: '3.1.5', published: ['3.1.4'], kind: 'minor', taken: none }),
    ).toBe('3.2.0');
    expect(
      nextReleaseVersion({ current: '3.1.4', published: ['3.1.4'], kind: 'major', taken: none }),
    ).toBe('4.0.0');
  });

  it('steps past versions whose tag or installers already exist', () => {
    const taken = new Set(['3.1.4', '3.1.5']);
    // Windows-only release: Windows serves 3.1.3, but 3.1.4 has a tag and orphaned files.
    expect(
      nextReleaseVersion({ current: '3.1.4', published: ['3.1.3'], taken: (v) => taken.has(v) }),
    ).toBe('3.1.6');
  });

  it('works when nothing is published for those platforms yet', () => {
    expect(nextReleaseVersion({ current: '3.1.4', published: [], taken: none })).toBe('3.1.4');
    expect(
      nextReleaseVersion({ current: '3.1.4', published: [], taken: (v) => v === '3.1.4' }),
    ).toBe('3.1.5');
  });
});

describe('helpers', () => {
  it('bumps and names installers', () => {
    expect(bump('3.1.9')).toBe('3.1.10');
    expect(installerName('win', '3.1.5')).toBe('Plasma-Setup-3.1.5-x64.exe');
    expect(installerName('mac', '3.1.5')).toBe('Plasma-3.1.5-arm64.dmg');
    expect(installerName('linux', '3.1.5')).toBe('Plasma-3.1.5-x86_64.AppImage');
  });
});
