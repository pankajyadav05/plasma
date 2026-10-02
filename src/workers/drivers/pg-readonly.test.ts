import { describe, expect, it } from 'vitest';
import { enforceReadOnlySession } from './pg-readonly';

function fakeClient(readOnlyValue: string) {
  const sent: string[] = [];
  return {
    sent,
    client: {
      async query(text: string) {
        sent.push(text);
        return { rows: [{ transaction_read_only: readOnlyValue }] };
      },
    },
  };
}

describe('enforceReadOnlySession (SC-02)', () => {
  it('re-asserts the GUC before a statement outside a transaction', async () => {
    const { client, sent } = fakeClient('on');
    await enforceReadOnlySession(client, 'I');
    expect(sent).toEqual(['SET default_transaction_read_only = on']);
  });

  it('verifies transaction_read_only inside a transaction', async () => {
    const { client, sent } = fakeClient('on');
    await enforceReadOnlySession(client, 'T');
    expect(sent).toEqual(['SHOW transaction_read_only']);
  });

  it('rolls back and refuses when the open transaction became read-write', async () => {
    const { client, sent } = fakeClient('off');
    await expect(enforceReadOnlySession(client, 'T')).rejects.toThrow(/switched to read-write/);
    expect(sent).toEqual(['SHOW transaction_read_only', 'ROLLBACK']);
  });

  it('sends nothing for an aborted transaction', async () => {
    const { client, sent } = fakeClient('on');
    await enforceReadOnlySession(client, 'E');
    expect(sent).toEqual([]);
  });

  it('treats a lagging status (server says aborted) as aborted', async () => {
    const client = {
      async query(): Promise<{ rows: [] }> {
        throw Object.assign(new Error('current transaction is aborted'), { code: '25P02' });
      },
    };
    await expect(enforceReadOnlySession(client, 'T')).resolves.toBeUndefined();
  });
});
