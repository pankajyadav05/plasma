/**
 * Plasma's model manifest for the Codex and Claude Code providers.
 *
 * The format, the refresh behaviour and the data originate in T3 Code
 * (https://github.com/pingdotgg/t3code, apps/server/src/provider/ModelManifest.ts
 * and model-manifest.json), MIT, Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY.md.
 *
 * The bundled copy ships with every release. At runtime it is refreshed from the
 * same file on `main`: at most once an hour, at most every 5 minutes after a
 * failure, 10 s timeout. Preference order: remote, then the last good copy on disk
 * (`<userData>/cli-model-manifest.json`), then the bundle. A failed fetch never
 * fails a list, and a remote copy that does not pass the schema is ignored.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import bundledJson from '@shared/cli-model-manifest.json';
import { z } from 'zod';
import { parseSemver } from './semver';

export const MANIFEST_URL =
  'https://raw.githubusercontent.com/pankajyadav05/plasma/main/src/shared/cli-model-manifest.json';
/** How long a fetched manifest stays fresh. */
export const MANIFEST_TTL_MS = 60 * 60 * 1000;
/** Minimum gap between fetches after a failure. */
export const MANIFEST_RETRY_MS = 5 * 60 * 1000;
export const MANIFEST_FETCH_TIMEOUT_MS = 10_000;
const MANIFEST_MAX_BYTES = 1024 * 1024;

const nonEmpty = z.string().trim().min(1);

const OptionSchema = z.object({
  id: nonEmpty,
  label: z.string(),
  description: z.string().optional(),
  isDefault: z.boolean().optional(),
});
const DescriptorSchema = z.discriminatedUnion('type', [
  z.object({
    id: nonEmpty,
    label: z.string(),
    type: z.literal('select'),
    options: z.array(OptionSchema),
    currentValue: z.string().optional(),
  }),
  z.object({ id: nonEmpty, label: z.string(), type: z.literal('boolean') }),
]);

const version = nonEmpty.refine((v) => parseSemver(v) !== null, 'a semantic version');

const ClaudeProfileAdapter = z.object({
  claudeCode: z
    .object({
      /** Effort id the UI shows -> the value `--effort` gets (null: send nothing). */
      effortMap: z.record(nonEmpty, nonEmpty.nullable()).optional(),
      fixedContextWindowTokens: z.number().optional(),
    })
    .optional(),
});

const ModelAdapter = z.object({
  claudeCode: z
    .object({ minVersion: version.optional(), maxVersionExclusive: version.optional() })
    .optional(),
  codex: z.object({ minVersion: version.optional() }).optional(),
});

const ModelSchema = z.object({
  slug: nonEmpty,
  name: nonEmpty,
  aliases: z.array(nonEmpty).optional(),
  status: z.enum(['current', 'legacy']),
  badge: z.literal('new').optional(),
  profile: nonEmpty.optional(),
  adapter: ModelAdapter.optional(),
});

const CatalogSchema = z.object({
  defaults: z.object({ chat: nonEmpty.optional() }).optional(),
  profiles: z.record(
    z.string(),
    z.object({
      capabilities: z.object({ optionDescriptors: z.array(DescriptorSchema) }).optional(),
      adapter: ClaudeProfileAdapter.optional(),
    }),
  ),
  models: z.array(ModelSchema),
});

export const ManifestSchema = z
  .object({
    version: z.literal(1),
    /** ISO date of the last edit: an older copy never outranks a newer one. */
    updatedAt: z.string().optional(),
    providers: z.object({ codex: CatalogSchema, 'claude-code': CatalogSchema }),
  })
  .refine(
    (m) =>
      Object.values(m.providers).every((c) => {
        const slugs = new Set<string>();
        for (const model of c.models) {
          if (slugs.has(model.slug)) return false;
          slugs.add(model.slug);
          if (model.profile !== undefined && !c.profiles[model.profile]) return false;
        }
        return c.defaults?.chat === undefined || slugs.has(c.defaults.chat);
      }),
    { message: 'unique model slugs and existing model and profile references' },
  )
  .refine(
    (m) =>
      m.providers['claude-code'].models.every((model) => {
        const c = model.adapter?.claudeCode;
        if (!c?.minVersion || !c.maxVersionExclusive) return true;
        const lo = parseSemver(c.minVersion);
        const hi = parseSemver(c.maxVersionExclusive);
        return !!lo && !!hi && (lo[0] - hi[0] || lo[1] - hi[1] || lo[2] - hi[2]) < 0;
      }),
    { message: 'a minimum version below the exclusive maximum version' },
  );

export type Manifest = z.infer<typeof ManifestSchema>;
export type ManifestCatalog = Manifest['providers']['codex'];
export type ManifestModel = ManifestCatalog['models'][number];

export const BUNDLED_MANIFEST: Manifest = ManifestSchema.parse(bundledJson);

const CacheFile = z.object({ fetchedAtMs: z.number(), manifest: ManifestSchema });

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

/**
 * `PLASMA_CLI_MODEL_MANIFEST_URL` exists for tests. Only raw.githubusercontent.com
 * or a loopback address is honoured, the same rule as `PLASMA_AI_MODELS_URL`.
 */
export function resolveManifestUrl(override: string | undefined): string {
  if (!override) return MANIFEST_URL;
  try {
    const url = new URL(override);
    if (
      LOOPBACK.includes(url.hostname) &&
      (url.protocol === 'http:' || url.protocol === 'https:')
    ) {
      return override;
    }
    if (url.protocol === 'https:' && url.hostname === 'raw.githubusercontent.com') return override;
  } catch {
    /* fall through */
  }
  return MANIFEST_URL;
}

const updatedAtMs = (m: Manifest): number => {
  const t = m.updatedAt ? Date.parse(m.updatedAt) : 0;
  return Number.isNaN(t) ? 0 : t;
};

export interface ManifestStoreOptions {
  /** Where the last good copy lives (`<userData>/cli-model-manifest.json`). */
  cachePath: string;
  url?: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  bundled?: Manifest;
}

export interface ManifestStore {
  /** The manifest in memory (disk copy or bundle); never fetches. */
  current(): Promise<Manifest>;
  /** After a TTL-gated remote refresh; never throws. */
  refresh(force?: boolean): Promise<Manifest>;
  /** Starts `refresh` and returns at once. */
  refreshInBackground(): void;
}

async function readCapped(res: Response): Promise<unknown> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MANIFEST_MAX_BYTES) throw new Error('too large');
  const text = await res.text();
  if (text.length > MANIFEST_MAX_BYTES) throw new Error('too large');
  return JSON.parse(text);
}

export function createManifestStore(opts: ManifestStoreOptions): ManifestStore {
  const bundled = opts.bundled ?? BUNDLED_MANIFEST;
  const url = opts.url ?? resolveManifestUrl(process.env.PLASMA_CLI_MODEL_MANIFEST_URL);
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  let manifest = bundled;
  let fetchedAtMs: number | null = null;
  let lastAttemptMs: number | null = null;
  let diskLoaded: Promise<void> | null = null;
  let inFlight: Promise<Manifest> | null = null;

  const loadDisk = () => {
    diskLoaded ??= (async () => {
      try {
        const c = CacheFile.parse(JSON.parse(await readFile(opts.cachePath, 'utf8')));
        // A release newer than the cache carries data the cache has not seen.
        if (updatedAtMs(bundled) > updatedAtMs(c.manifest)) return;
        manifest = c.manifest;
        fetchedAtMs = c.fetchedAtMs;
      } catch {
        /* no usable disk copy */
      }
    })();
    return diskLoaded;
  };

  const within = (since: number | null, window: number, t: number) =>
    since !== null && t >= since && t - since < window;

  const doRefresh = async (force: boolean): Promise<Manifest> => {
    await loadDisk();
    const t = now();
    if (!force && within(fetchedAtMs, MANIFEST_TTL_MS, t)) return manifest;
    if (!force && within(lastAttemptMs, MANIFEST_RETRY_MS, t)) return manifest;
    lastAttemptMs = t;
    let fetched: Manifest | null = null;
    try {
      const res = await doFetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(MANIFEST_FETCH_TIMEOUT_MS),
      });
      if (res.ok) fetched = ManifestSchema.parse(await readCapped(res));
    } catch {
      fetched = null;
    }
    // A stale CDN copy must not undo the bundled version gates.
    if (!fetched || updatedAtMs(fetched) < updatedAtMs(manifest)) return manifest;
    manifest = fetched;
    fetchedAtMs = t;
    try {
      await mkdir(dirname(opts.cachePath), { recursive: true });
      const tmp = `${opts.cachePath}.tmp`;
      await writeFile(tmp, JSON.stringify({ fetchedAtMs: t, manifest: fetched }));
      await rename(tmp, opts.cachePath);
    } catch {
      /* a copy that cannot be written is only a missed optimisation */
    }
    return manifest;
  };

  const refresh = (force = false) => {
    inFlight ??= doRefresh(force)
      .catch(() => manifest)
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  return {
    async current() {
      await loadDisk();
      return manifest;
    },
    refresh,
    refreshInBackground() {
      void refresh();
    },
  };
}

let shared: ManifestStore | null = null;

/** The app's store; `userData` is only needed the first time. */
export function manifestStore(userData?: string): ManifestStore {
  shared ??= createManifestStore({
    cachePath: join(userData ?? process.cwd(), 'cli-model-manifest.json'),
  });
  return shared;
}
