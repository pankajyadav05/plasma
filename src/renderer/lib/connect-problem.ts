import {
  type ConnectDiagnosis,
  type ConnectField,
  decodeDiagnosedMessage,
} from '@shared/connect-diagnosis';
import { cleanIpcError } from './errors';

/**
 * Presentation helpers for a diagnosed connection error: which form control a
 * field name points at, how to word it, and how to read a failed connect's
 * error message. Pure, so the logic is tested without a DOM.
 */

const FIELD_LABEL: Record<ConnectField, string> = {
  host: 'Host',
  port: 'Port',
  user: 'User',
  password: 'Password',
  database: 'Database',
  ssl: 'TLS',
  ssh: 'SSH tunnel',
};

export function fieldLabel(field: ConnectField, engine?: string): string {
  if (field === 'database') {
    if (engine === 'redis') return 'DB index';
    if (engine === 'sqlite' || engine === 'duckdb') return 'Database file';
  }
  if (field === 'user' && engine === 'redis') return 'ACL user';
  return FIELD_LABEL[field];
}

/** The id of the form control to look at for `field`, in the connection form. */
export function fieldElementId(field: ConnectField, engine?: string): string {
  switch (field) {
    case 'host':
      return 'conn-host';
    case 'port':
      return 'conn-port';
    case 'user':
      return 'conn-user';
    case 'password':
      return 'conn-password';
    case 'database':
      return engine === 'sqlite' || engine === 'duckdb' ? 'conn-file' : 'conn-db';
    case 'ssl':
      return 'conn-ssl';
    case 'ssh':
      return 'ssh-host';
  }
}

/**
 * The SSH tunnel is edited with several controls; any of them is "the SSH
 * field". Used to flag all of them, not just the one the button focuses.
 */
export const SSH_ELEMENT_IDS = ['ssh-host', 'ssh-port', 'ssh-user', 'ssh-password', 'ssh-key'];

/** Is the control with this id the one (or one of those) the diagnosis points at? */
export function isFlagged(
  elementId: string,
  field: ConnectField | undefined,
  engine?: string,
): boolean {
  if (!field) return false;
  if (field === 'ssh') return SSH_ELEMENT_IDS.includes(elementId);
  return fieldElementId(field, engine) === elementId;
}

export interface ReadConnectError {
  /** Plain text to show where only a line fits. */
  text: string;
  /** The diagnosis, when main sent one. */
  diagnosis: ConnectDiagnosis | null;
}

/**
 * Read what a rejected connect says: strips Electron's wrapper, and splits the
 * readable message from the diagnosis that rides in it.
 */
export function readConnectError(err: unknown): ReadConnectError {
  const message = err instanceof Error ? err.message : String(err);
  const { diagnosis, text } = decodeDiagnosedMessage(cleanIpcError(message));
  return { text: diagnosis ? `${diagnosis.title}. ${diagnosis.detail}` : text, diagnosis };
}

/** The text copied from the Details disclosure: the diagnosis, then the raw error. */
export function copyableProblem(d: ConnectDiagnosis): string {
  return [`${d.title}`, d.detail, '', ...d.fixes.map((f) => `- ${f}`), '', 'Error:', d.raw].join(
    '\n',
  );
}
