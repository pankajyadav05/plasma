import { describe, expect, it } from 'vitest';
import {
  type StageId,
  type StageStep,
  plannedStages,
  runStages,
  summarizeStages,
} from './connect-stages';

const ids = (plan: Array<{ id: StageId }>) => plan.map((p) => p.id);

describe('plannedStages', () => {
  it('walks a plain network connection: host, port, login, database', () => {
    expect(ids(plannedStages({ engine: 'postgres', ssl: false, ssh: false }))).toEqual([
      'dns',
      'tcp',
      'login',
      'database',
    ]);
  });

  it('adds TLS when it is switched on', () => {
    expect(ids(plannedStages({ engine: 'mysql', ssl: true, ssh: false }))).toEqual([
      'dns',
      'tcp',
      'tls',
      'login',
      'database',
    ]);
  });

  it('opens the SSH tunnel first and leaves resolving to the jump host', () => {
    expect(ids(plannedStages({ engine: 'postgres', ssl: true, ssh: true }))).toEqual([
      'ssh',
      'tls',
      'login',
      'database',
    ]);
  });

  it('has a single step for a file', () => {
    expect(plannedStages({ engine: 'sqlite', ssl: false, ssh: false })).toEqual([
      { id: 'database', label: 'Open the file' },
    ]);
    expect(ids(plannedStages({ engine: 'duckdb', ssl: true, ssh: true }))).toEqual(['database']);
  });

  it('words the last step for the engine', () => {
    const last = (engine: string) =>
      plannedStages({ engine, ssl: false, ssh: false }).at(-1)?.label;
    expect(last('postgres')).toBe('Open the database');
    expect(last('redis')).toBe('Select the database');
    expect(last('opensearch')).toBe('Check the cluster');
  });
});

const step = (
  stages: StageId[],
  run: () => Promise<undefined | { notes?: Record<string, string> }>,
  locate?: StageStep['locate'],
): StageStep => ({
  stages,
  run: run as StageStep['run'],
  ...(locate ? { locate } : {}),
});

const clock = () => {
  let t = 1000;
  return {
    now: () => t,
    tick: (ms: number) => {
      t += ms;
    },
  };
};

describe('runStages', () => {
  const plan = plannedStages({ engine: 'postgres', ssl: true, ssh: false });

  it('marks every stage ok, with timings and notes, when all steps work', async () => {
    const c = clock();
    const out = await runStages(
      plan,
      [
        step(['dns'], async () => {
          c.tick(12);
          return { notes: { dns: '93.184.216.34' } };
        }),
        step(['tcp'], async () => {
          c.tick(30);
          return undefined;
        }),
        step(['tls', 'login', 'database'], async () => {
          c.tick(200);
          return { notes: { database: 'PostgreSQL 16.2' } };
        }),
      ],
      { now: c.now },
    );
    expect(out.failure).toBeUndefined();
    expect(out.stages.map((s) => [s.id, s.status, s.ms])).toEqual([
      ['dns', 'ok', 12],
      ['tcp', 'ok', 30],
      ['tls', 'ok', 200],
      ['login', 'ok', 200],
      ['database', 'ok', 200],
    ]);
    expect(out.stages[0]?.note).toBe('93.184.216.34');
    expect(out.stages[4]?.note).toBe('PostgreSQL 16.2');
  });

  it('stops at the first failure and skips what was never reached', async () => {
    const ran: string[] = [];
    const boom = new Error('connect ECONNREFUSED');
    const out = await runStages(plan, [
      step(['dns'], async () => void ran.push('dns')),
      step(['tcp'], async () => {
        ran.push('tcp');
        throw boom;
      }),
      step(['tls', 'login', 'database'], async () => void ran.push('login')),
    ]);
    expect(ran).toEqual(['dns', 'tcp']);
    expect(out.stages.map((s) => [s.id, s.status])).toEqual([
      ['dns', 'ok'],
      ['tcp', 'failed'],
      ['tls', 'skipped'],
      ['login', 'skipped'],
      ['database', 'skipped'],
    ]);
    expect(out.failure).toEqual({ stage: 'tcp', error: boom });
  });

  it('puts a failure of a multi-stage step on the stage the locator names', async () => {
    const run = (at: StageId) =>
      runStages(plan, [
        step(['dns'], async () => undefined),
        step(['tcp'], async () => undefined),
        step(
          ['tls', 'login', 'database'],
          async () => {
            throw new Error('x');
          },
          () => at,
        ),
      ]);
    const tlsFail = await run('tls');
    expect(tlsFail.stages.map((s) => s.status)).toEqual([
      'ok',
      'ok',
      'failed',
      'skipped',
      'skipped',
    ]);
    const loginFail = await run('login');
    expect(loginFail.stages.map((s) => s.status)).toEqual(['ok', 'ok', 'ok', 'failed', 'skipped']);
    const dbFail = await run('database');
    expect(dbFail.stages.map((s) => s.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'failed']);
    expect(dbFail.failure?.stage).toBe('database');
  });

  it('shows the failure on the first stage of a covering step by default', async () => {
    const out = await runStages(plan, [
      step(['dns'], async () => undefined),
      step(['tcp'], async () => undefined),
      step(['tls', 'login', 'database'], async () => {
        throw new Error('x');
      }),
    ]);
    expect(out.stages.map((s) => s.status)).toEqual(['ok', 'ok', 'failed', 'skipped', 'skipped']);
  });

  it('puts a TLS failure on the login stage when the plan has no TLS stage', async () => {
    const noTls = plannedStages({ engine: 'postgres', ssl: false, ssh: false });
    const out = await runStages(noTls, [
      step(['dns'], async () => undefined),
      step(['tcp'], async () => undefined),
      step(
        ['tls', 'login', 'database'],
        async () => {
          throw new Error('server requires TLS');
        },
        () => 'tls',
      ),
    ]);
    expect(out.stages.map((s) => [s.id, s.status])).toEqual([
      ['dns', 'ok'],
      ['tcp', 'ok'],
      ['login', 'failed'],
      ['database', 'skipped'],
    ]);
  });

  it('runs a file connection as its one step', async () => {
    const filePlan = plannedStages({ engine: 'sqlite', ssl: false, ssh: false });
    const ok = await runStages(filePlan, [step(['database'], async () => undefined)]);
    expect(ok.stages).toMatchObject([{ id: 'database', status: 'ok', label: 'Open the file' }]);
    const bad = await runStages(filePlan, [
      step(['database'], async () => {
        throw new Error('database file not found');
      }),
    ]);
    expect(bad.stages[0]?.status).toBe('failed');
  });

  it('opens the tunnel before anything else when there is one', async () => {
    const sshPlan = plannedStages({ engine: 'postgres', ssl: false, ssh: true });
    const out = await runStages(sshPlan, [
      step(['ssh'], async () => {
        throw new Error('All configured authentication methods failed');
      }),
      step(['login', 'database'], async () => undefined),
    ]);
    expect(out.stages.map((s) => [s.id, s.status])).toEqual([
      ['ssh', 'failed'],
      ['login', 'skipped'],
      ['database', 'skipped'],
    ]);
  });

  it('reports stages in plan order whatever order the steps list them in', async () => {
    const out = await runStages(plan, [step(['tls', 'login', 'database'], async () => undefined)]);
    expect(out.stages.map((s) => s.id)).toEqual(ids(plan));
    expect(out.stages.map((s) => s.status)).toEqual(['skipped', 'skipped', 'ok', 'ok', 'ok']);
  });
});

describe('summarizeStages', () => {
  it('lists what passed', async () => {
    const out = await runStages(plannedStages({ engine: 'postgres', ssl: false, ssh: false }), [
      step(['dns'], async () => undefined),
      step(['tcp'], async () => {
        throw new Error('x');
      }),
    ]);
    expect(summarizeStages(out.stages)).toBe('Find the host');
  });
});
