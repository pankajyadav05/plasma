import { describe, expect, it } from 'vitest';
import { formatConnectionUrl, parseConnectionUrl } from './connection-url';

describe('parseConnectionUrl (C28)', () => {
  it('parses a Postgres URL with sslmode', () => {
    expect(
      parseConnectionUrl('postgres://app:s%40cret@db.example.com:6543/shop?sslmode=verify-ca'),
    ).toEqual({
      engine: 'postgres',
      host: 'db.example.com',
      port: 6543,
      database: 'shop',
      user: 'app',
      password: 's@cret',
      ssl: true,
      tls: { mode: 'verify-ca' },
    });
  });

  it('defaults the port and treats sslmode=disable as plaintext', () => {
    const p = parseConnectionUrl('postgresql://localhost/postgres?sslmode=disable');
    expect(p.port).toBe(5432);
    expect(p.ssl).toBe(false);
    expect(p.tls).toBeUndefined();
  });

  it('parses Redis URLs, rediss = TLS', () => {
    expect(parseConnectionUrl('redis://:pw@cache:6380/2')).toMatchObject({
      engine: 'redis',
      port: 6380,
      database: '2',
      password: 'pw',
      ssl: false,
    });
    expect(parseConnectionUrl('rediss://cache').ssl).toBe(true);
    expect(parseConnectionUrl('redis://cache').database).toBe('0');
  });

  it('parses OpenSearch http(s) URLs', () => {
    expect(parseConnectionUrl('https://admin:x@search.example.com')).toMatchObject({
      engine: 'opensearch',
      port: 9200,
      ssl: true,
      user: 'admin',
    });
  });

  it('rejects garbage with a readable message', () => {
    expect(() => parseConnectionUrl('not a url')).toThrow(/Not a connection URL/);
    expect(() => parseConnectionUrl('mysql://x/y')).toThrow(/Unsupported/);
    expect(() => parseConnectionUrl('postgres://h/db?sslmode=bogus')).toThrow(/sslmode/);
  });
});

describe('formatConnectionUrl (C28)', () => {
  const pg = {
    engine: 'postgres' as const,
    host: 'db.example.com',
    port: 5432,
    database: 'shop',
    user: 'app',
    password: 'secret',
    ssl: true,
    tls: { mode: 'verify-full' as const },
  };

  it('omits the password by default', () => {
    expect(formatConnectionUrl(pg)).toBe(
      'postgres://app@db.example.com:5432/shop?sslmode=verify-full',
    );
    expect(formatConnectionUrl(pg, { includePassword: true })).toBe(
      'postgres://app:secret@db.example.com:5432/shop?sslmode=verify-full',
    );
  });

  it('round-trips through parse', () => {
    const url = formatConnectionUrl(pg, { includePassword: true });
    expect(parseConnectionUrl(url)).toMatchObject(pg);
    const redis = { ...pg, engine: 'redis' as const, database: '3', ssl: true, user: '' };
    expect(formatConnectionUrl(redis)).toBe('rediss://db.example.com:5432/3');
  });
});
