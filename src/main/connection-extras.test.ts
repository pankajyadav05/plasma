import type { ConnectionConfig } from '@shared/protocol';
import { describe, expect, it } from 'vitest';
import {
  extrasFromJson,
  extrasToJson,
  osSecretKey,
  osSecretsToStore,
  withOpenSearchSecrets,
} from './connection-extras';

const base: ConnectionConfig = {
  id: 'c1',
  name: 'n',
  engine: 'opensearch',
  host: 'h',
  port: 9200,
  database: '',
  user: '',
  password: '',
  ssl: true,
};

describe('connection extras JSON', () => {
  it('round-trips group, bootstrap SQL and public OpenSearch options', () => {
    const json = extrasToJson({
      ...base,
      group: ' Prod ',
      bootstrapSql: 'SET x = 1',
      opensearch: {
        auth: 'sigv4',
        awsRegion: 'eu-west-1',
        awsAccessKeyId: 'AKIA',
        awsSecretAccessKey: 'SECRET',
        pathPrefix: '/search',
        nodes: [' https://b:9200 ', ''],
      },
    });
    expect(json).not.toContain('SECRET');
    expect(extrasFromJson(json)).toEqual({
      group: 'Prod',
      bootstrapSql: 'SET x = 1',
      opensearch: {
        auth: 'sigv4',
        awsRegion: 'eu-west-1',
        awsAccessKeyId: 'AKIA',
        pathPrefix: '/search',
        nodes: ['https://b:9200'],
      },
    });
  });
  it('stores nothing when there is nothing to store', () => {
    expect(extrasToJson({ ...base, engine: 'postgres' })).toBeNull();
    expect(extrasFromJson('not json')).toEqual({});
    expect(extrasFromJson(null)).toEqual({});
  });
  it('drops OpenSearch options for other engines', () => {
    expect(extrasToJson({ ...base, engine: 'redis', opensearch: { auth: 'apiKey' } })).toBeNull();
  });
});

describe('OpenSearch secrets', () => {
  it('only writes non-blank secrets', () => {
    expect(
      osSecretsToStore({ engine: 'opensearch', opensearch: { apiKey: 'k', awsSessionToken: '' } }),
    ).toEqual({ apiKey: 'k' });
    expect(osSecretsToStore({ engine: 'postgres', opensearch: { apiKey: 'k' } })).toEqual({});
    expect(osSecretKey('c1', 'apiKey')).toBe('os:c1:apiKey');
  });
  const vault: Record<string, string> = { apiKey: 'stored', awsSecretAccessKey: 'aws' };
  const read = (f: string) => vault[f] ?? null;
  it('fills blanks from the vault but keeps typed values', () => {
    const out = withOpenSearchSecrets(
      { ...base, opensearch: { auth: 'apiKey', apiKey: 'typed' } },
      read as never,
      'fill',
    );
    expect(out.opensearch).toMatchObject({ apiKey: 'typed', awsSecretAccessKey: 'aws' });
  });
  it('renderer view has flags and no secrets', () => {
    const out = withOpenSearchSecrets(
      { ...base, opensearch: { apiKey: 'x' } },
      read as never,
      'flags',
    );
    expect(out.opensearch).toEqual({
      hasApiKey: true,
      hasAwsSecretAccessKey: true,
      hasAwsSessionToken: false,
    });
  });
});
