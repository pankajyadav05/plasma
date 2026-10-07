import type { WorkerRequest } from '@shared/protocol';

/**
 * C12 / F19 — ordering for worker requests.
 *
 * The worker's message handler is async, so without this a `connect` can
 * overlap another `connect`, a `disconnect` or a query, and a multi-step
 * operation (edit batch BEGIN…COMMIT, AI BEGIN READ ONLY…COMMIT) can have
 * an unrelated statement land in the middle of it.
 *
 * Lanes:
 *   - `lifecycle` — connect / disconnect / statement timeout. One at a
 *     time; every request that arrives later waits for it to finish, so
 *     nothing runs against a half-built session.
 *   - `primary`   — statements on the primary Postgres client, FIFO.
 *   - `aux`       — statements on the aux client, FIFO.
 *   - `free`      — runs immediately (cancel must never queue behind the
 *     query it is cancelling; test probes use their own driver).
 *
 * A request that was waiting when a connect/disconnect was queued is
 * rejected instead of running on whatever session exists afterwards —
 * it was meant for the old one.
 */

export type Lane = 'lifecycle' | 'primary' | 'aux' | 'free';

type Kind = WorkerRequest['kind'];

const LANE_BY_KIND: Partial<Record<Kind, Lane>> = {
  connect: 'lifecycle',
  disconnect: 'lifecycle',
  setStatementTimeout: 'lifecycle',
  query: 'primary',
  commitEditBatch: 'primary',
  applyDdl: 'primary',
  importRun: 'primary',
  importCancel: 'free',
  exportCancel: 'free',
  cancelAux: 'free',
  explain: 'primary',
  beginTxn: 'primary',
  commitTxn: 'primary',
  rollbackTxn: 'primary',
  safeRunStart: 'primary',
  safeRunFinish: 'primary',
  exportQuery: 'primary',
  sidebandQuery: 'aux',
  aiQuery: 'aux',
  cancel: 'free',
  ping: 'free',
  testConnect: 'free',
  compareQuery: 'free',
};

export function laneFor(kind: Kind): Lane {
  return LANE_BY_KIND[kind] ?? 'free';
}

/** Lifecycle ops that replace the session (as opposed to tuning it). */
function changesSession(kind: Kind): boolean {
  return kind === 'connect' || kind === 'disconnect';
}

export class StaleRequestError extends Error {
  override readonly name = 'StaleRequestError';
  constructor(kind: string) {
    super(`${kind} was not run: the connection changed before it started`);
  }
}

const settled = (p: Promise<unknown>): Promise<void> =>
  p.then(
    () => undefined,
    () => undefined,
  );

export class RequestScheduler {
  private lifecycleTail: Promise<void> = Promise.resolve();
  private laneTails: Record<'primary' | 'aux', Promise<void>> = {
    primary: Promise.resolve(),
    aux: Promise.resolve(),
  };
  private laneBusy: Record<'primary' | 'aux', number> = { primary: 0, aux: 0 };
  private lifecyclePending = 0;
  /** Bumped when a connect/disconnect is queued. */
  private epoch = 0;

  run<T>(kind: Kind, fn: () => Promise<T>): Promise<T> {
    const lane = laneFor(kind);

    if (lane === 'lifecycle') {
      if (changesSession(kind)) this.epoch++;
      this.lifecyclePending++;
      const result = this.lifecycleTail.then(fn).finally(() => {
        this.lifecyclePending--;
      });
      this.lifecycleTail = settled(result);
      return result;
    }

    if (
      lane === 'free' &&
      (kind === 'cancel' || kind === 'ping' || kind === 'testConnect' || kind === 'compareQuery')
    ) {
      return fn();
    }

    const arrivedAt = this.epoch;
    const gate = this.lifecyclePending > 0 ? this.lifecycleTail : null;
    const guarded = async (): Promise<T> => {
      if (gate) await gate;
      if (this.epoch !== arrivedAt) throw new StaleRequestError(kind);
      return fn();
    };

    if (lane === 'free') return guarded();

    // Nothing queued in this lane: start now, so work that was already
    // running when a connect arrives isn't mistaken for queued work.
    const tail = this.laneTails[lane];
    const result = this.laneBusy[lane] === 0 ? guarded() : tail.then(guarded);
    this.laneBusy[lane]++;
    const done = settled(result).then(() => {
      this.laneBusy[lane]--;
    });
    this.laneTails[lane] = done;
    return result;
  }
}
