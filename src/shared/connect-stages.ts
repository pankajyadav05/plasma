/**
 * "Test connection" as a list of steps: find the host, reach the port (or open
 * the SSH tunnel first), TLS, log in, open the database. They run in order and
 * stop at the first that fails; what was never reached is shown as skipped.
 *
 * This file is the pure part: which steps a connection has, how a step list is
 * run, and how the result reads. The steps themselves (a DNS lookup, a TCP
 * connect, the driver's connect) are supplied by main.
 */

export type StageId = 'ssh' | 'dns' | 'tcp' | 'tls' | 'login' | 'database';
export type StageStatus = 'ok' | 'failed' | 'skipped';

export interface StageResult {
  id: StageId;
  label: string;
  status: StageStatus;
  /** Milliseconds the step took (a step that covers several shares its time). */
  ms?: number;
  /** A short remark: the address a name resolved to, the server version. */
  note?: string;
}

export interface StagePlanOptions {
  engine: string;
  /** TLS is switched on. */
  ssl: boolean;
  /** The connection goes through an SSH tunnel. */
  ssh: boolean;
  /**
   * False when the host field is not one host name and one port (a unix socket, a Redis
   * sentinel / cluster list): there is nothing to look up or dial before the driver.
   */
  dialable?: boolean;
}

const FILE_ENGINES = new Set(['sqlite', 'duckdb']);

function databaseLabel(engine: string): string {
  switch (engine) {
    case 'redis':
      return 'Select the database';
    case 'opensearch':
      return 'Check the cluster';
    case 'sqlite':
    case 'duckdb':
      return 'Open the file';
    default:
      return 'Open the database';
  }
}

const LABEL: Record<Exclude<StageId, 'database'>, string> = {
  ssh: 'Open the SSH tunnel',
  dns: 'Find the host',
  tcp: 'Reach the port',
  tls: 'Set up TLS',
  login: 'Log in',
};

/** The steps a connection goes through, in order. A file has just one. */
export function plannedStages(opts: StagePlanOptions): Array<{ id: StageId; label: string }> {
  const stage = (id: StageId) => ({
    id,
    label: id === 'database' ? databaseLabel(opts.engine) : LABEL[id],
  });
  if (FILE_ENGINES.has(opts.engine)) return [stage('database')];
  // Through a tunnel the jump host resolves and reaches the database; what can be
  // checked from here is the tunnel itself.
  const reach: StageId[] = opts.ssh ? ['ssh'] : opts.dialable === false ? [] : ['dns', 'tcp'];
  return [...reach, ...(opts.ssl ? (['tls'] as const) : []), 'login', 'database'].map((id) =>
    stage(id as StageId),
  );
}

export interface StageStep {
  /** The stages this step settles: usually one; the driver's connect settles tls / login / database. */
  stages: StageId[];
  /** Resolves when the step worked; may say something about each stage. */
  run(): Promise<{ notes?: Partial<Record<StageId, string>> } | undefined>;
  /** For a step that covers several stages: which one a failure belongs to. Default: the first. */
  locate?(err: unknown): StageId;
}

export interface StageRun {
  stages: StageResult[];
  /** The stage that failed and the error it failed with; undefined when every step worked. */
  failure?: { stage: StageId; error: unknown };
}

/**
 * Run `steps` in order and stop at the first failure. `plan` lists every stage
 * to report (see `plannedStages`): the ones before the failure are ok, the one
 * that failed is failed, the rest skipped. A step whose stages are not in the
 * plan (TLS off) simply does not report them.
 */
export async function runStages(
  plan: ReadonlyArray<{ id: StageId; label: string }>,
  steps: readonly StageStep[],
  opts: { now?: () => number } = {},
): Promise<StageRun> {
  const now = opts.now ?? Date.now;
  const results = new Map<StageId, StageResult>(
    plan.map((p) => [p.id, { id: p.id, label: p.label, status: 'skipped' as StageStatus }]),
  );
  const ordered = (): StageResult[] => plan.map((p) => results.get(p.id) as StageResult);

  for (const step of steps) {
    const started = now();
    try {
      const out = await step.run();
      const ms = Math.max(0, Math.round(now() - started));
      for (const id of step.stages) {
        const r = results.get(id);
        if (!r) continue;
        r.status = 'ok';
        r.ms = ms;
        const note = out?.notes?.[id];
        if (note) r.note = note;
      }
    } catch (error) {
      const ms = Math.max(0, Math.round(now() - started));
      const failed = step.locate?.(error) ?? (step.stages[0] as StageId);
      // Stages the step covers that come before the failing one did work.
      const at = step.stages.indexOf(failed);
      step.stages.forEach((id, i) => {
        const r = results.get(id);
        if (!r) return;
        if (i < at) {
          r.status = 'ok';
          r.ms = ms;
        } else if (i === at) {
          r.status = 'failed';
          r.ms = ms;
        }
      });
      // A located stage that the plan does not list (an error the plan did not expect)
      // still has to show up as the failure: attach it to the nearest listed stage.
      if (!results.has(failed)) {
        const fallback = step.stages
          .map((id) => results.get(id))
          .find((r) => r?.status === 'skipped');
        if (fallback) {
          fallback.status = 'failed';
          fallback.ms = ms;
        }
      }
      return { stages: ordered(), failure: { stage: failed, error } };
    }
  }
  return { stages: ordered() };
}

/** "Found the host · Reached the port" style one-liner for a passed run. */
export function summarizeStages(stages: readonly StageResult[]): string {
  const ok = stages.filter((s) => s.status === 'ok');
  return ok.map((s) => s.label).join(' → ');
}
