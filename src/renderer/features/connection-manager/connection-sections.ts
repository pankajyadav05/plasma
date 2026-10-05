import type { ConnectionConfig, ConnectionEngine } from '@shared/protocol';
import type { FormErrors, FormField, SshFormState } from './connection-form';

/** The cards of the connection form, in page order. */
export type SectionId = 'connection' | 'server' | 'auth' | 'security' | 'ssh' | 'advanced';

export const SECTION_TITLE: Record<SectionId, string> = {
  connection: 'Connection',
  server: 'Server',
  auth: 'Authentication',
  security: 'Security',
  ssh: 'SSH tunnel',
  advanced: 'Advanced',
};

export const SECTION_HINT: Record<SectionId, string> = {
  connection: 'Name, folder and environment.',
  server: 'Where the database lives.',
  auth: 'Who you connect as.',
  security: 'Encrypt the connection and check certificates.',
  ssh: 'Reach a private network through a bastion host.',
  advanced: 'Safe mode, Safe Run and start-up SQL.',
};

/** Which validation errors belong to which card. */
export const SECTION_FIELDS: Record<SectionId, FormField[]> = {
  connection: ['name'],
  server: ['host', 'port', 'database', 'osNodes'],
  auth: ['osAuth'],
  security: ['tlsCert', 'tlsKey'],
  ssh: ['sshHost', 'sshPort', 'sshUser', 'sshAuth', 'ssh'],
  advanced: [],
};

export function isFileEngine(engine: ConnectionEngine): boolean {
  return engine === 'sqlite' || engine === 'duckdb';
}

/** Sections shown for an engine. File engines have no network, login or tunnel. */
export function sectionsFor(engine: ConnectionEngine, sshSupported: boolean): SectionId[] {
  if (isFileEngine(engine)) return ['connection', 'server', 'advanced'];
  const list: SectionId[] = ['connection', 'server', 'auth', 'security'];
  if (sshSupported) list.push('ssh');
  list.push('advanced');
  return list;
}

export type SectionStatus = 'idle' | 'complete' | 'error';

export interface SectionInput {
  config: ConnectionConfig;
  portText: string;
  useSsh: boolean;
  ssh: SshFormState;
  /** Secrets already saved for the tunnel (a blank field keeps them). */
  savedSsh?: { hasPassword?: boolean; hasPrivateKey?: boolean };
  errors: FormErrors;
  /** Any Advanced option differs from its default. */
  advancedTouched: boolean;
}

function validPort(text: string): boolean {
  const t = text.trim();
  return /^\d+$/.test(t) && Number(t) >= 1 && Number(t) <= 65535;
}

/** True when the card's required fields (or, for optional cards, its set options) are filled. */
function isComplete(id: SectionId, input: SectionInput): boolean {
  const { config, portText, ssh } = input;
  const engine = (config.engine ?? 'postgres') as ConnectionEngine;
  switch (id) {
    case 'connection':
      return config.name.trim().length > 0;
    case 'server':
      if (isFileEngine(engine)) return config.database.trim().length > 0;
      return config.host.trim().length > 0 && validPort(portText);
    case 'auth': {
      const os = config.opensearch ?? {};
      const auth = engine === 'opensearch' ? (os.auth ?? 'basic') : 'basic';
      if (auth === 'apiKey') return Boolean(os.apiKey || os.hasApiKey);
      if (auth === 'sigv4') {
        return Boolean(
          os.awsRegion?.trim() &&
            os.awsAccessKeyId?.trim() &&
            (os.awsSecretAccessKey || os.hasAwsSecretAccessKey),
        );
      }
      return Boolean(config.user.trim() || config.password);
    }
    case 'security':
      return Boolean(config.ssl);
    case 'ssh': {
      if (!input.useSsh) return false;
      const secret =
        Boolean(ssh.password || ssh.privateKey || ssh.privateKeyPath?.trim() || ssh.useAgent) ||
        Boolean(input.savedSsh?.hasPassword || input.savedSsh?.hasPrivateKey);
      return Boolean(ssh.host.trim() && ssh.user.trim() && validPort(ssh.port) && secret);
    }
    case 'advanced':
      return input.advancedTouched;
  }
}

/** Empty ring (idle), check (complete) or red (a validation error in the card). */
export function sectionStatus(id: SectionId, input: SectionInput): SectionStatus {
  if (SECTION_FIELDS[id].some((f) => Boolean(input.errors[f]))) return 'error';
  return isComplete(id, input) ? 'complete' : 'idle';
}

/** The first card (in page order) that holds a validation error. */
export function firstInvalidSection(errors: FormErrors, sections: SectionId[]): SectionId | null {
  return sections.find((id) => SECTION_FIELDS[id].some((f) => Boolean(errors[f]))) ?? null;
}
