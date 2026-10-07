import { diagnoseConnectError, encodeDiagnosedMessage } from '@shared/connect-diagnosis';
import { describe, expect, it } from 'vitest';
import {
  copyableProblem,
  fieldElementId,
  fieldLabel,
  isFlagged,
  readConnectError,
} from './connect-problem';

const diagnosis = diagnoseConnectError(
  { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:5432' },
  { engine: 'postgres', host: '127.0.0.1', port: 5432 },
);

describe('fields', () => {
  it('points at the control the form really has', () => {
    expect(fieldElementId('host')).toBe('conn-host');
    expect(fieldElementId('port')).toBe('conn-port');
    expect(fieldElementId('password')).toBe('conn-password');
    expect(fieldElementId('user')).toBe('conn-user');
    expect(fieldElementId('ssl')).toBe('conn-ssl');
    expect(fieldElementId('ssh')).toBe('ssh-host');
    expect(fieldElementId('database', 'postgres')).toBe('conn-db');
    expect(fieldElementId('database', 'redis')).toBe('conn-db');
    expect(fieldElementId('database', 'sqlite')).toBe('conn-file');
    expect(fieldElementId('database', 'duckdb')).toBe('conn-file');
  });

  it('flags every control of the SSH group, and only the named one otherwise', () => {
    expect(isFlagged('ssh-user', 'ssh')).toBe(true);
    expect(isFlagged('ssh-key', 'ssh')).toBe(true);
    expect(isFlagged('conn-host', 'ssh')).toBe(false);
    expect(isFlagged('conn-host', 'host')).toBe(true);
    expect(isFlagged('conn-port', 'host')).toBe(false);
    expect(isFlagged('conn-host', undefined)).toBe(false);
  });

  it('words a field for the engine', () => {
    expect(fieldLabel('password')).toBe('Password');
    expect(fieldLabel('database', 'redis')).toBe('DB index');
    expect(fieldLabel('database', 'sqlite')).toBe('Database file');
    expect(fieldLabel('user', 'redis')).toBe('ACL user');
    expect(fieldLabel('ssh')).toBe('SSH tunnel');
  });
});

describe('readConnectError', () => {
  it('splits the readable text from the diagnosis, through Electron’s wrapper', () => {
    const wrapped = new Error(
      `Error invoking remote method 'plasma:conn:connect': Error: ${encodeDiagnosedMessage(diagnosis)}`,
    );
    const read = readConnectError(wrapped);
    expect(read.diagnosis?.cause).toBe('refused');
    expect(read.text).toBe(`${diagnosis.title}. ${diagnosis.detail}`);
  });

  it('shows an undiagnosed error as it is, minus the wrapper', () => {
    const read = readConnectError(
      new Error("Error invoking remote method 'plasma:conn:connect': Error: boom"),
    );
    expect(read).toEqual({ text: 'boom', diagnosis: null });
    expect(readConnectError('plain')).toEqual({ text: 'plain', diagnosis: null });
  });
});

describe('copyableProblem', () => {
  it('copies what happened, what to try and the raw error', () => {
    const text = copyableProblem(diagnosis);
    expect(text).toContain(diagnosis.title);
    expect(text).toContain(`- ${diagnosis.fixes[0]}`);
    expect(text).toContain('connect ECONNREFUSED 127.0.0.1:5432');
  });
});
