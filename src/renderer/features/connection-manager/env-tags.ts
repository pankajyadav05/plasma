/**
 * V6: environment tags use the same `--status-*` colours as the status
 * capsule, so the pick previews what the top bar will show.
 */
export type EnvTag = 'prod' | 'staging' | 'dev' | 'local';

export const ENV_TAGS = ['local', 'dev', 'staging', 'prod'] as const;

export const TAG_COLOR: Record<EnvTag, string> = {
  local: 'var(--status-local)',
  dev: 'var(--status-dev)',
  staging: 'var(--status-staging)',
  prod: 'var(--status-prod)',
};

export const TAG_LABEL: Record<EnvTag, string> = {
  local: 'Local',
  dev: 'Dev',
  staging: 'Staging',
  prod: 'Prod',
};
