import { describe, expect, it } from 'vitest';
import { suggestReadOnlyForTag } from './connection-readonly';
import { ConnectionConfig } from './protocol';

describe('suggestReadOnlyForTag', () => {
  it('suggests read-only only for prod', () => {
    expect(suggestReadOnlyForTag('prod')).toBe(true);
    expect(suggestReadOnlyForTag('staging')).toBe(false);
    expect(suggestReadOnlyForTag('dev')).toBe(false);
    expect(suggestReadOnlyForTag('local')).toBe(false);
    expect(suggestReadOnlyForTag(null)).toBe(false);
    expect(suggestReadOnlyForTag(undefined)).toBe(false);
  });
});

describe('ConnectionConfig.readOnly', () => {
  const base = {
    id: 'c1',
    name: 'local',
    host: 'localhost',
    port: 5432,
    database: 'postgres',
    user: 'postgres',
    password: 'secret',
  };

  it('defaults to false when omitted', () => {
    const cfg = ConnectionConfig.parse(base);
    expect(cfg.readOnly).toBe(false);
  });

  it('accepts an explicit true flag without requiring tls fields', () => {
    const cfg = ConnectionConfig.parse({ ...base, readOnly: true });
    expect(cfg.readOnly).toBe(true);
    expect(cfg).not.toHaveProperty('tls');
  });
});
