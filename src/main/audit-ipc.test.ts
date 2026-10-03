import { describe, expect, it } from 'vitest';
import { shouldAudit } from './audit-ipc';

describe('shouldAudit', () => {
  const tags = { p: 'prod', s: 'staging' };
  it('audits Prod-tagged connections by default', () => {
    expect(shouldAudit('p', { connectionTags: tags })).toBe(true);
    expect(shouldAudit('s', { connectionTags: tags })).toBe(false);
    expect(shouldAudit('x', { connectionTags: tags })).toBe(false);
  });
  it('audits everything when the setting is on', () => {
    expect(shouldAudit('s', { connectionTags: tags, auditAllConnections: true })).toBe(true);
  });
  it('never audits without a connection', () => {
    expect(shouldAudit(null, { auditAllConnections: true })).toBe(false);
  });
});
