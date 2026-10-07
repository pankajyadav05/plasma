import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { connect as tcpConnect } from 'node:net';
import {
  type ConnectDiagnosis,
  diagnoseClusterStatus,
  diagnoseConnectError,
  encodeDiagnosedMessage,
  isFileEngine,
  stageOfCause,
} from '@shared/connect-diagnosis';
import { type StageResult, type StageStep, plannedStages, runStages } from '@shared/connect-stages';
import { redisEndpointKind } from '@shared/connection-endpoint';
import { type ErrorInfo, errorInfoOf } from '@shared/error-info';
import type { ConnectionConfig, ConnectionTestResult } from '@shared/protocol';
import { redactSecrets } from '@shared/redact-secrets';
import { effectiveTlsMode } from '@shared/tls';

/**
 * Plain-language connection errors, main side: gather what an error carries
 * (the codes the worker sent, where it happened, what the jump host said),
 * classify it with the pure `connect-diagnosis` module and hand the result to
 * the renderer, either on the "Test connection" result or inside the message
 * of the error a failed connect rejects with.
 */

/** The parts of an SSH tunnel config this module reads: which jump host, and what is secret. */
export interface SshSecrets {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  passphrase?: string;
  privateKey?: string;
}

/** Every secret that could be in an error message of a connect with this config. */
export function secretsOf(config: ConnectionConfig, ssh?: SshSecrets | null): string[] {
  const os = config.opensearch;
  return [
    config.password,
    os?.apiKey,
    os?.awsSecretAccessKey,
    os?.awsSessionToken,
    ssh?.password,
    ssh?.passphrase,
    ssh?.privateKey,
  ].filter((s): s is string => typeof s === 'string' && s.length > 0);
}

export interface DiagnoseOptions {
  /** The connection goes through an SSH tunnel with these settings. */
  ssh?: SshSecrets | null;
  /** Why the jump host could not open the database port, when it said. */
  forwardError?: string;
}

/** TLS is switched on (including the unverified `insecure` mode). */
function tlsOn(config: ConnectionConfig): boolean {
  return effectiveTlsMode(config) !== 'disable';
}

/**
 * The host field names one host to look up and dial. Not so for a unix socket (a path, `unix:`,
 * Postgres' socket directory) or for Redis' `sentinel://` and `cluster://` lists: those go
 * straight to the driver.
 */
export function isDialableHost(engine: string, host: string): boolean {
  const h = host.trim();
  if (h.startsWith('/') || h.startsWith('\\') || /^unix:/i.test(h) || /^host=/i.test(h))
    return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(h) || h.includes(',')) return false;
  if (engine === 'redis' && redisEndpointKind(h) !== 'tcp') return false;
  return true;
}

/** The target of a connect as the diagnosis words it: files have no host. */
function contextOf(config: ConnectionConfig, opts: DiagnoseOptions) {
  const engine = config.engine ?? 'postgres';
  return {
    engine,
    host: isFileEngine(engine) ? config.database : config.host,
    port: config.port,
    user: config.user || undefined,
    database: config.database || undefined,
    ssl: tlsOn(config),
    ssh: Boolean(opts.ssh),
    secrets: secretsOf(config, opts.ssh),
  };
}

/** Classify a failed connect of `config`. `err` is whatever was thrown. */
export function diagnoseFailure(
  err: unknown,
  config: ConnectionConfig,
  opts: DiagnoseOptions = {},
): ConnectDiagnosis {
  const message = err instanceof Error ? err.message : String(err);
  const info: ErrorInfo = { ...(errorInfoOf(err) ?? {}) };
  if (opts.forwardError && !info.forwardError) info.forwardError = opts.forwardError;
  return diagnoseConnectError({ message, ...info }, contextOf(config, opts));
}

/**
 * The error a failed connect rejects with: its message reads as "Title. Detail"
 * and carries the diagnosis for a renderer that knows how to show it.
 */
export function diagnosedError(
  err: unknown,
  config: ConnectionConfig,
  opts: DiagnoseOptions = {},
): Error {
  const diagnosis = diagnoseFailure(err, config, opts);
  // Nothing recognised: keep the driver's own text (cleaned of secrets) rather than
  // a generic title that hides it; the renderer falls back to showing it as it is.
  if (diagnosis.cause === 'unknown') {
    return Object.assign(new Error(diagnosis.raw.split('\n(')[0]), { diagnosis });
  }
  return Object.assign(new Error(encodeDiagnosedMessage(diagnosis)), { diagnosis });
}

/** A red cluster on an otherwise good connection. */
export function clusterWarning(
  status: string | null | undefined,
  config: ConnectionConfig,
): ConnectDiagnosis | undefined {
  return diagnoseClusterStatus(status, contextOf(config, {})) ?? undefined;
}

// ── probes: the steps before the driver ───────────────────────────────────

export const PROBE_TIMEOUT_MS = 8_000;

/** Resolve a host name. An IP address needs no lookup. */
export async function probeDns(host: string): Promise<{ notes: { dns: string } }> {
  if (isIP(host)) return { notes: { dns: 'IP address' } };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const resolved = await Promise.race([
      lookup(host),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Object.assign(new Error(`getaddrinfo EAI_AGAIN ${host}`), { code: 'EAI_AGAIN' }),
            ),
          PROBE_TIMEOUT_MS,
        );
      }),
    ]);
    return { notes: { dns: resolved.address } };
  } finally {
    clearTimeout(timer);
  }
}

/** Open a TCP connection and close it again. */
export function probeTcp(host: string, port: number): Promise<undefined> {
  return new Promise((resolve, reject) => {
    const socket = tcpConnect({ host, port });
    const done = (err?: Error) => {
      socket.destroy();
      if (err) reject(err);
      else resolve(undefined);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () =>
      done(Object.assign(new Error(`connect ETIMEDOUT ${host}:${port}`), { code: 'ETIMEDOUT' })),
    );
    socket.once('connect', () => done());
    socket.once('error', (e) => done(e));
  });
}

export interface StagedTestDeps {
  /** Open the SSH tunnel; resolves with the local address the driver should use. */
  openTunnel?: () => Promise<{ host: string; port: number }>;
  /** The driver's connect (and its disconnect): version, plus the cluster status for OpenSearch. */
  connect: (target: { host: string; port: number }) => Promise<{
    serverVersion: string;
    engine: string;
    clusterStatus?: string | null;
  }>;
  /** What the jump host said when it could not open the database port. */
  forwardError?: () => string | undefined;
  /** Test seams. */
  dns?: typeof probeDns;
  tcp?: typeof probeTcp;
}

/**
 * Run "Test connection" as steps (see `connect-stages.ts`): the SSH tunnel or
 * the DNS lookup and TCP connect first, then the driver, whose failure is
 * placed on the TLS, login or database step by its cause.
 */
export async function runStagedTest(
  config: ConnectionConfig,
  deps: StagedTestDeps,
  ssh?: SshSecrets | null,
): Promise<ConnectionTestResult> {
  const engine = config.engine ?? 'postgres';
  const file = isFileEngine(engine);
  const tls = tlsOn(config);
  const dialable = file || isDialableHost(engine, config.host);
  const plan = plannedStages({
    engine,
    ssl: tls && !file,
    ssh: Boolean(ssh) && !file,
    dialable,
  });
  const steps: StageStep[] = [];
  let target = { host: config.host, port: config.port };

  if (!file) {
    if (ssh && deps.openTunnel) {
      const open = deps.openTunnel;
      steps.push({
        stages: ['ssh'],
        run: async () => {
          target = await open();
          return undefined;
        },
      });
    } else if (dialable) {
      steps.push({
        stages: ['dns'],
        run: () => (deps.dns ?? probeDns)(config.host),
      });
      steps.push({
        stages: ['tcp'],
        run: () => (deps.tcp ?? probeTcp)(config.host, config.port),
      });
    }
  }

  let version = '';
  let engineOut: string = engine;
  let clusterStatus: string | null | undefined;
  const driverStages: StageResult['id'][] = file
    ? ['database']
    : [...(tls ? (['tls'] as const) : []), 'login', 'database'];
  steps.push({
    stages: driverStages,
    run: async () => {
      const out = await deps.connect(target);
      version = out.serverVersion;
      engineOut = out.engine;
      clusterStatus = out.clusterStatus;
      return { notes: { database: out.serverVersion } };
    },
    locate: (err) => {
      if (file) return 'database';
      const d = diagnoseFailure(err, config, { ssh, forwardError: deps.forwardError?.() });
      return stageOfCause(d.cause);
    },
  });

  const run = await runStages(plan, steps);
  if (run.failure) {
    const err = run.failure.error;
    const diagnosis = diagnoseFailure(err, config, {
      ssh,
      forwardError: deps.forwardError?.(),
    });
    return {
      ok: false,
      message: redactSecrets(
        err instanceof Error ? err.message : String(err),
        secretsOf(config, ssh),
      ),
      diagnosis,
      stages: run.stages,
    };
  }
  const warning = clusterWarning(clusterStatus, config);
  return {
    ok: true,
    serverVersion: version,
    engine: engineOut as ConnectionConfig['engine'] & string,
    stages: run.stages,
    ...(warning ? { warning } : {}),
  };
}
