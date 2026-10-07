import { it } from 'vitest';
import {
  CAPABILITY_KEYS,
  type Capabilities,
  type CapabilityKey,
  optOutReason,
} from './capabilities';

/**
 * Registers scenarios against a capability table. A scenario whose capability
 * is opted out becomes a skipped test that carries the reason, so the report
 * lists every engine's opt-outs next to what ran.
 */
export function scenarioFor(caps: Capabilities) {
  return function scenario(
    title: string,
    needs: CapabilityKey | CapabilityKey[] | null,
    fn: () => Promise<void>,
    ms = 20_000,
  ): void {
    const keys = needs === null ? [] : Array.isArray(needs) ? needs : [needs];
    for (const key of keys) {
      const reason = optOutReason(caps[key]);
      if (reason !== null) {
        it.skip(`${title} [not applicable: ${key} - ${reason}]`, () => {});
        return;
      }
    }
    it(title, fn, ms);
  };
}

/** One skipped test per opted-out capability: the engine's full list of opt-outs in the report. */
export function listOptOuts(caps: Capabilities): void {
  for (const key of CAPABILITY_KEYS) {
    const reason = optOutReason(caps[key]);
    if (reason !== null) it.skip(`opt-out ${key}: ${reason}`, () => {});
  }
}
