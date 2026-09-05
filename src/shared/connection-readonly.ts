/**
 * Per-connection read-only helpers (U28).
 *
 * The connection dialog suggests read-only when the environment tag is
 * `prod`. The flag itself lives on `ConnectionConfig.readOnly` and is
 * enforced in the Postgres driver (`SET default_transaction_read_only`)
 * plus renderer edit gating.
 */

export type ConnectionEnvTag = 'prod' | 'staging' | 'dev' | 'local';

/** Prod-tagged connections suggest read-only by default. */
export function suggestReadOnlyForTag(
  tag: ConnectionEnvTag | null | undefined,
): boolean {
  return tag === 'prod';
}
