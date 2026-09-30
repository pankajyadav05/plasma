import type { ConnectionConfig, OpenSearchOptions } from '@shared/protocol';

/**
 * Connection fields beyond the fixed columns (C28 / O12): folder, bootstrap
 * SQL and OpenSearch endpoint/auth options. The non-secret part is stored as
 * JSON in `connections.extra_json`; the three OpenSearch secrets go to the
 * vault (`os:<id>:*`), so this module never puts a credential in that JSON.
 */

export const OS_SECRET_FIELDS = ['apiKey', 'awsSecretAccessKey', 'awsSessionToken'] as const;
export type OsSecretField = (typeof OS_SECRET_FIELDS)[number];

export function osSecretKey(connectionId: string, field: OsSecretField): string {
  return `os:${connectionId}:${field}`;
}

type Extras = Pick<ConnectionConfig, 'group' | 'bootstrapSql' | 'opensearch'>;

function clean(value: string | undefined): string | undefined {
  const t = value?.trim();
  return t ? t : undefined;
}

/** Public (secret-free) OpenSearch options, defaults dropped. */
function publicOpenSearch(o: OpenSearchOptions | undefined): OpenSearchOptions | undefined {
  if (!o) return undefined;
  const nodes = (o.nodes ?? []).map((n) => n.trim()).filter(Boolean);
  const out: OpenSearchOptions = {
    ...(o.auth && o.auth !== 'basic' ? { auth: o.auth } : {}),
    ...(clean(o.awsRegion) ? { awsRegion: clean(o.awsRegion) } : {}),
    ...(o.awsService && o.awsService !== 'es' ? { awsService: o.awsService } : {}),
    ...(clean(o.awsAccessKeyId) ? { awsAccessKeyId: clean(o.awsAccessKeyId) } : {}),
    ...(clean(o.pathPrefix) ? { pathPrefix: clean(o.pathPrefix) } : {}),
    ...(nodes.length > 0 ? { nodes } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

export function extrasToJson(config: ConnectionConfig): string | null {
  const extras: Extras = {
    ...(clean(config.group) ? { group: clean(config.group) } : {}),
    ...(clean(config.bootstrapSql) ? { bootstrapSql: config.bootstrapSql } : {}),
    ...(config.engine === 'opensearch' && publicOpenSearch(config.opensearch)
      ? { opensearch: publicOpenSearch(config.opensearch) }
      : {}),
  };
  return Object.keys(extras).length > 0 ? JSON.stringify(extras) : null;
}

export function extrasFromJson(json: string | null | undefined): Extras {
  if (!json) return {};
  try {
    const raw = JSON.parse(json) as Extras;
    return {
      ...(typeof raw.group === 'string' && raw.group ? { group: raw.group } : {}),
      ...(typeof raw.bootstrapSql === 'string' && raw.bootstrapSql
        ? { bootstrapSql: raw.bootstrapSql }
        : {}),
      ...(raw.opensearch && typeof raw.opensearch === 'object'
        ? { opensearch: raw.opensearch }
        : {}),
    };
  } catch {
    return {};
  }
}

/** Secrets a save should write; blank values are skipped (= keep the stored one). */
export function osSecretsToStore(
  config: Pick<ConnectionConfig, 'engine' | 'opensearch'>,
): Partial<Record<OsSecretField, string>> {
  if (config.engine !== 'opensearch' || !config.opensearch) return {};
  const out: Partial<Record<OsSecretField, string>> = {};
  for (const f of OS_SECRET_FIELDS) {
    const v = config.opensearch[f];
    if (v) out[f] = v;
  }
  return out;
}

/**
 * Fill blank OpenSearch secrets from the vault (`read`), and — when
 * `presence` is given — add the `has*` flags instead (renderer-safe view).
 */
export function withOpenSearchSecrets(
  config: ConnectionConfig,
  read: (field: OsSecretField) => string | null,
  mode: 'fill' | 'flags',
): ConnectionConfig {
  if (config.engine !== 'opensearch') return config;
  const base: OpenSearchOptions = { ...(config.opensearch ?? {}) };
  if (mode === 'flags') {
    for (const f of OS_SECRET_FIELDS) delete base[f];
    base.hasApiKey = Boolean(read('apiKey'));
    base.hasAwsSecretAccessKey = Boolean(read('awsSecretAccessKey'));
    base.hasAwsSessionToken = Boolean(read('awsSessionToken'));
  } else {
    for (const f of OS_SECRET_FIELDS) {
      if (!base[f]) {
        const stored = read(f);
        if (stored) base[f] = stored;
      }
    }
  }
  return { ...config, opensearch: base };
}
