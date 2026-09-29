import { describe, expect, it } from 'vitest';
import type { ConnectionTls } from './protocol';
import {
  assertTlsAllowedForTag,
  buildNodeTlsOptions,
  effectiveTlsMode,
  resolveTls,
  withTunnelServername,
} from './tls';

const base = {
  ssl: true,
  host: 'db.example.com',
  tls: undefined as undefined | ConnectionTls,
};

describe('resolveTls', () => {
  it('returns null when ssl is off', () => {
    expect(resolveTls({ ...base, ssl: false })).toBeNull();
  });

  it('defaults to verify-full when ssl is on and tls is omitted', () => {
    expect(resolveTls(base)).toEqual({
      mode: 'verify-full',
      ca: undefined,
      cert: undefined,
      key: undefined,
      servername: undefined,
    });
  });

  it('honors an explicit mode and folds the legacy insecure spelling into require', () => {
    expect(resolveTls({ ...base, tls: { mode: 'verify-ca' } })?.mode).toBe('verify-ca');
    expect(resolveTls({ ...base, tls: { mode: 'insecure' } })?.mode).toBe('require');
  });

  it('treats mode disable as TLS off', () => {
    expect(resolveTls({ ...base, tls: { mode: 'disable' } })).toBeNull();
    expect(effectiveTlsMode({ ssl: false, tls: { mode: 'verify-full' } })).toBe('disable');
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
    expect(opts?.checkServerIdentity?.('', {} as never)).toBeUndefined();
  });

  it('insecure disables verification', () => {
    const opts = buildNodeTlsOptions({ ...base, tls: { mode: 'insecure' } });
    expect(opts).toEqual({ rejectUnauthorized: false });
  });

  it('require and prefer encrypt without verification', () => {
    expect(buildNodeTlsOptions({ ...base, tls: { mode: 'require' } })).toEqual({
      rejectUnauthorized: false,
    });
    expect(buildNodeTlsOptions({ ...base, tls: { mode: 'prefer' } })?.rejectUnauthorized).toBe(
      false,
    );
  });

  it('passes client certificate and key for mTLS', () => {
    const opts = buildNodeTlsOptions({
      ...base,
      tls: { mode: 'verify-full', ca: 'CA', cert: 'CERT', key: 'KEY' },
    });
    expect(opts).toMatchObject({ ca: 'CA', cert: 'CERT', key: 'KEY', rejectUnauthorized: true });
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
    expect(() => assertTlsAllowedForTag({ mode: 'insecure' }, 'dev')).not.toThrow();
    expect(() => assertTlsAllowedForTag({ mode: 'insecure' }, null)).not.toThrow();
  });

  it('refuses insecure on prod', () => {
    expect(() => assertTlsAllowedForTag({ mode: 'insecure' }, 'prod')).toThrow(
      /not allowed for production/,
    );
  });

  it('refuses require / prefer on prod', () => {
    expect(() => assertTlsAllowedForTag({ mode: 'require' }, 'prod')).toThrow(/production/);
    expect(() => assertTlsAllowedForTag({ mode: 'prefer' }, 'prod')).toThrow(/production/);
    expect(() => assertTlsAllowedForTag({ mode: 'verify-ca' }, 'prod')).not.toThrow();
  });

  it('allows verify-full on prod', () => {
    expect(() => assertTlsAllowedForTag({ mode: 'verify-full' }, 'prod')).not.toThrow();
  });
});

describe('withTunnelServername', () => {
  it('pins SNI to the real host when tunnelled', () => {
    const tls: ConnectionTls = { mode: 'verify-full' };
    const cfg = withTunnelServername({ ssl: true, tls }, 'db.example.com');
    expect(cfg.tls?.servername).toBe('db.example.com');
    const opts = buildNodeTlsOptions({ ...cfg, host: '127.0.0.1' });
    expect(opts?.servername).toBe('db.example.com');
  });

  it('keeps an explicit servername and leaves plaintext alone', () => {
    const explicit = withTunnelServername(
      { ssl: true, tls: { mode: 'verify-full', servername: 'x.example' } as ConnectionTls },
      'db.example.com',
    );
    expect(explicit.tls?.servername).toBe('x.example');
    const plain = withTunnelServername({ ssl: false, tls: undefined }, 'db.example.com');
    expect(plain.tls).toBeUndefined();
  });
});
