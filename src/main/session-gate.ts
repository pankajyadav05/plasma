/**
 * Ordering helpers for session changes (connect / disconnect) in main.
 *
 * C12: one connect or disconnect at a time. SC-29: any other request that
 * arrives while one is in flight waits for it, so main's read-only guard
 * is evaluated against the session the request will actually run on.
 */
export class SessionGate {
  private chain: Promise<unknown> = Promise.resolve();
  private inFlight = 0;

  /** Run `fn` after every earlier session change has finished. */
  serialize<T>(fn: () => Promise<T>): Promise<T> {
    this.inFlight++;
    const run = this.chain.then(fn, fn);
    this.chain = run
      .catch(() => undefined)
      .finally(() => {
        this.inFlight--;
      });
    return run;
  }

  /** Resolve once no session change is queued or running. */
  async settled(): Promise<void> {
    while (this.inFlight > 0) await this.chain;
  }

  get busy(): boolean {
    return this.inFlight > 0;
  }
}

/**
 * SC-07: run a connect attempt; if it fails at any point (before or after
 * the worker was reached) tear the half-built state down so main, the
 * tunnel and the worker agree the user is disconnected.
 */
export async function connectOrCleanUp<T>(
  attempt: () => Promise<T>,
  cleanUp: (err: unknown) => Promise<void> | void,
): Promise<T> {
  try {
    return await attempt();
  } catch (err) {
    try {
      await cleanUp(err);
    } catch {
      // cleanup is best-effort; the original failure is what the user needs
    }
    throw err;
  }
}
