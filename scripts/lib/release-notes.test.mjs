import { describe, expect, it } from 'vitest';
import { parseSubject, releaseNotes } from './release-notes.mjs';

describe('parseSubject', () => {
  it('keeps user-facing types with their scope', () => {
    expect(parseSubject('feat(compare): pure result diff engine')).toEqual({
      section: 'feat',
      scope: 'compare',
      text: 'Pure result diff engine',
    });
    expect(parseSubject('fix: no scope')).toEqual({
      section: 'fix',
      scope: null,
      text: 'No scope',
    });
    expect(parseSubject('docs,fix(ui): note formatting')?.section).toBe('fix');
  });

  it('drops tests, CI, docs, version bumps, merges and review follow-ups', () => {
    for (const s of [
      'test(drivers): one conformance suite',
      'ci(release): pick the version',
      'docs: release guide',
      'chore: bump deps',
      'v3.2.1',
      'Merge track C: query lifecycle',
      'fix(track-a): review findings',
      'fix(edit,recovery): address review of conflict detection',
    ]) {
      expect(parseSubject(s)).toBeNull();
    }
  });
});

describe('releaseNotes', () => {
  it('groups by section, oldest first, without duplicates', () => {
    const body = releaseNotes({
      version: '3.2.2',
      previous: 'v3.2.1',
      subjects: [
        'fix(mysql): read-only stays read-only',
        'test: more',
        'feat(compare): Result Compare tab',
        'feat(ai): paste images',
        'feat(ai): paste images',
      ],
    });
    expect(body).toContain(
      '## New\n\n- **ai:** Paste images\n- **compare:** Result Compare tab\n\n## Fixed\n\n- **mysql:** Read-only stays read-only',
    );
    expect(body.match(/Paste images/g)).toHaveLength(1);
    expect(body).toContain('Plasma-Setup-3.2.2-x64.exe');
  });

  it('says so when nothing user-facing changed', () => {
    const body = releaseNotes({ version: '3.2.2', previous: 'v3.2.1', subjects: ['ci: x'] });
    expect(body).toContain('no user-facing changes since v3.2.1');
  });
});
