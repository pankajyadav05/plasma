import { describe, expect, it } from 'vitest';
import { freshConfig } from './connection-defaults';
import {
  type SectionInput,
  firstInvalidSection,
  sectionStatus,
  sectionsFor,
} from './connection-sections';

const ssh = {
  host: '',
  port: '22',
  user: '',
  password: '',
  privateKey: '',
  passphrase: '',
};

function input(patch: Partial<SectionInput> = {}): SectionInput {
  return {
    config: freshConfig('postgres'),
    portText: '5432',
    useSsh: false,
    ssh,
    errors: {},
    advancedTouched: false,
    ...patch,
  };
}

describe('sectionsFor', () => {
  it('hides network sections for file engines', () => {
    expect(sectionsFor('sqlite', false)).toEqual(['connection', 'server', 'advanced']);
    expect(sectionsFor('duckdb', true)).toEqual(['connection', 'server', 'advanced']);
  });

  it('lists the SSH tunnel only where it is supported', () => {
    expect(sectionsFor('postgres', true)).toContain('ssh');
    expect(sectionsFor('opensearch', false)).not.toContain('ssh');
  });
});

describe('sectionStatus', () => {
  it('marks required fields complete', () => {
    expect(sectionStatus('connection', input())).toBe('complete');
    expect(sectionStatus('server', input())).toBe('complete');
  });

  it('is idle until required fields are filled', () => {
    const config = { ...freshConfig('postgres'), name: ' ', host: '' };
    expect(sectionStatus('connection', input({ config }))).toBe('idle');
    expect(sectionStatus('server', input({ config }))).toBe('idle');
    expect(sectionStatus('server', input({ portText: 'abc' }))).toBe('idle');
  });

  it('prefers error over complete', () => {
    expect(sectionStatus('server', input({ errors: { port: 'Port is required' } }))).toBe('error');
  });

  it('needs a file for file engines', () => {
    const config = freshConfig('sqlite');
    expect(sectionStatus('server', input({ config }))).toBe('idle');
    expect(sectionStatus('server', input({ config: { ...config, database: '/a.db' } }))).toBe(
      'complete',
    );
  });

  it('treats optional cards as complete once configured', () => {
    expect(sectionStatus('security', input())).toBe('idle');
    expect(sectionStatus('security', input({ config: { ...freshConfig(), ssl: true } }))).toBe(
      'complete',
    );
    expect(sectionStatus('advanced', input({ advancedTouched: true }))).toBe('complete');
  });

  it('checks the SSH tunnel fields when enabled', () => {
    expect(sectionStatus('ssh', input())).toBe('idle');
    const ready = { ...ssh, host: 'bastion', user: 'me', useAgent: true };
    expect(sectionStatus('ssh', input({ useSsh: true, ssh: ready }))).toBe('complete');
    expect(sectionStatus('ssh', input({ useSsh: true, ssh: { ...ready, useAgent: false } }))).toBe(
      'idle',
    );
  });

  it('follows the OpenSearch auth mode', () => {
    const config = {
      ...freshConfig('opensearch'),
      opensearch: { auth: 'apiKey' as const },
    };
    expect(sectionStatus('auth', input({ config }))).toBe('idle');
    expect(
      sectionStatus(
        'auth',
        input({ config: { ...config, opensearch: { auth: 'apiKey', apiKey: 'k' } } }),
      ),
    ).toBe('complete');
  });
});

describe('firstInvalidSection', () => {
  it('returns the first card with an error in page order', () => {
    const sections = sectionsFor('postgres', true);
    expect(firstInvalidSection({ sshHost: 'x', host: 'y' }, sections)).toBe('server');
    expect(firstInvalidSection({}, sections)).toBeNull();
  });
});
