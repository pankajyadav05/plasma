import { describe, expect, it } from 'vitest';
import {
  assertTlsAllowedForTag,
  buildNodeTlsOptions,
  resolveTls,
} from './tls';

const base = {
  ssl: true,
  host: 'db.example.com',
  tls: undefined as undefined | { mode: 'verify-full' | 'verify-ca' | 'insecure'; ca?: string; servername?: string },
};

describe('resolveTls', () => {
  it('returns null when ssl is off', () => {
    expect(resolveTls({ ...base, ssl: false })).toBeNull();
  });

  it('defaults to verify-full when ssl is on and tls is omitted', () => {
    expect(resolveTls(base)).toEqual({
      mode: 'verify-full',
      ca: undefined,
      servername: undefined,
    });
  });

  it('honors an explicit mode', () => {
    expect(resolveTls({ ...base, tls: { mode: 'insecure' } })?.mode).toBe('insecure');
  });
});

describe('buildNodeTlsOptions', () => {
  it('returns undefined when ssl is off', () => {
    expect(buildNodeTlsOptions({ ...base, ssl: false })).toBeUndefined();
  });

  it('defaults rejectUnauthorized to true (verify-full)', () => {
    const opts = buildNodeTlsOptions(base);
    expect(opts).toMatchObject({
      rejectUnauthorized: true,
      servername: 'db.example.com',
    });
    expect(opts?.checkServerIdentity).toBeUndefined();
  });

  it('verify-ca skips hostname checks but still verifies the chain', () => {
    const opts = buildNodeTlsOptions({ ...base, tls: { mode: 'verify-ca' } });
    expect(opts?.rejectUnauthorized).toBe(true);
    expect(opts?.checkServerIdentity?.( '', {} as never)).toBeUndefined();
  });

  it('insecure disables verification', () => {
    const opts = buildNodeTlsOptions({ ...base, tls: { mode: 'insecure' } });
    expect(opts).toEqual({ rejectUnauthorized: false });
  });

  it('passes custom CA and servername', () => {
    const opts = buildNodeTlsOptions({
      ...base,
      tls: { mode: 'verify-full', ca: 'PEM', servername: 'other.example.com' },
    });
    expect(opts).toEqual({
      rejectUnauthorized: true,
      ca: 'PEM',
      servername: 'other.example.com',
    });
  });
});

describe('assertTlsAllowedForTag', () => {
  it('allows insecure on non-prod tags', () => {
    expect(() =>
      assertTlsAllowedForTag({ mode: 'insecure' }, 'dev'),
    ).not.toThrow();
    expect(() =>
      assertTlsAllowedForTag({ mode: 'insecure' }, null),
    ).not.toThrow();
  });

  it('refuses insecure on prod', () => {
    expect(() =>
      assertTlsAllowedForTag({ mode: 'insecure' }, 'prod'),
    ).toThrow(/not allowed for production/);
  });

  it('allows verify-full on prod', () => {
    expect(() =>
      assertTlsAllowedForTag({ mode: 'verify-full' }, 'prod'),
    ).not.toThrow();
  });
});
