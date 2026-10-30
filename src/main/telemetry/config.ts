/**
 * The PostHog project events go to. A `phc_` key can only write events, so it
 * ships in the build, and an empty key turns analytics off entirely.
 */
const POSTHOG_PROJECT_KEY = 'phc_LU7m38SkvKBfKugNGqMvWJJqkXtohN3xWHtKpBla1NL';
const POSTHOG_HOST = 'https://us.i.posthog.com';

export interface TelemetryConfig {
  /** False when this build or environment must not send anything, whatever the setting says. */
  readonly enabled: boolean;
  readonly posthogKey: string;
  readonly posthogHost: string;
}

function parseFlag(value: string | undefined): boolean | undefined {
  const v = value?.trim().toLowerCase();
  if (!v) return undefined;
  return v !== '0' && v !== 'false' && v !== 'no' && v !== 'off';
}

/**
 * Dev runs, CI and isolated profiles (E2E, the release smoke launch) stay off:
 * each would count as a new install. `PLASMA_TELEMETRY_ENABLED` overrides that
 * either way; `DO_NOT_TRACK` is respected when it is unset.
 */
export function resolveTelemetryConfig(
  env: Readonly<Record<string, string | undefined>>,
  isPackaged: boolean,
  builtInKey: string = POSTHOG_PROJECT_KEY,
): TelemetryConfig {
  const posthogKey = env.PLASMA_POSTHOG_KEY?.trim() || builtInKey;
  const posthogHost = (env.PLASMA_POSTHOG_HOST?.trim() || POSTHOG_HOST).replace(/\/+$/, '');
  const override = parseFlag(env.PLASMA_TELEMETRY_ENABLED);
  const allowed =
    override ??
    (isPackaged && !parseFlag(env.DO_NOT_TRACK) && !parseFlag(env.CI) && !env.PLASMA_USER_DATA);
  return { enabled: allowed && posthogKey !== '', posthogKey, posthogHost };
}
