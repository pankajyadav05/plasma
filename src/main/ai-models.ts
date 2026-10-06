/**
 * The model list for the assistant's picker. OpenRouter's catalogue is
 * public: nothing about the user (no key, no data) is sent. It is cached in
 * `<userData>/ai-models.json` and served from there for 6 h. A local server
 * (Ollama, LM Studio) is listed live, loopback only, never cached.
 *
 * No Electron or logger import, so the suite can run it against a loopback
 * server and a temp dir.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  type AiModel,
  AiModelSchema,
  type AiModelsResult,
  normalizeLocalModels,
  normalizeOpenRouterModels,
} from '@shared/ai-models';
import { z } from 'zod';

export const MODELS_URL = 'https://openrouter.ai/api/v1/models';
export const MODELS_CACHE_TTL_MS = 6 * 3600_000;
export const MODELS_TIMEOUT_MS = 10_000;
export const MODELS_MAX_BYTES = 5 * 1024 * 1024;

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

/**
 * `PLASMA_AI_MODELS_URL` exists for tests. Only openrouter.ai or a loopback
 * address is honoured, the same rule as `PLASMA_AI_ENDPOINT`.
 */
export function resolveModelsUrl(override: string | undefined): string {
  if (!override) return MODELS_URL;
  try {
    const url = new URL(override);
    const loopback = LOOPBACK.includes(url.hostname);
    if (loopback && (url.protocol === 'http:' || url.protocol === 'https:')) return override;
    if (url.protocol === 'https:' && url.hostname === 'openrouter.ai') return override;
  } catch {
    /* fall through */
  }
  return MODELS_URL;
}

/** `<local base>/models`; null with an error when the URL is not loopback http(s). */
export function resolveLocalModelsUrl(
  raw: string | undefined,
): { ok: true; url: string } | { ok: false; error: string } {
  const text = (raw ?? '').trim();
  if (!text) return { ok: false, error: 'No local model URL set. Add it in Settings, AI.' };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: `"${text}" is not a valid URL for the local model.` };
  }
  if (!LOOPBACK.includes(url.hostname) || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    return {
      ok: false,
      error:
        'The local model URL must be http or https on localhost, 127.0.0.1 or [::1]. Nothing was sent.',
    };
  }
  if (url.username || url.password) {
    return { ok: false, error: 'The local model URL must not contain a user name or password.' };
  }
  const path = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  return { ok: true, url: `${url.origin}${path}/models` };
}

type FetchFn = typeof fetch;

/** Read the body as JSON, refusing more than `MODELS_MAX_BYTES`. */
async function readCappedJson(res: Response): Promise<unknown> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MODELS_MAX_BYTES) throw new Error('The model list is too large.');
  if (!res.body) throw new Error('The model list was empty.');
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MODELS_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error('The model list is too large.');
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(text);
}

async function getJson(url: string, fetchFn: FetchFn): Promise<unknown> {
  const res = await fetchFn(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return readCappedJson(res);
}

const CacheFile = z.object({ fetchedAt: z.number(), models: z.array(z.unknown()) });

async function readCache(
  path: string,
  now: number,
): Promise<{ at: number; models: AiModel[] } | null> {
  try {
    const parsed = CacheFile.parse(JSON.parse(await readFile(path, 'utf8')));
    const models: AiModel[] = [];
    for (const m of parsed.models) {
      const ok = AiModelSchema.safeParse(m);
      // A model that expired while it sat in the cache is gone.
      if (ok.success && (ok.data.expires === null || ok.data.expires * 1000 > now)) {
        models.push(ok.data);
      }
    }
    return models.length > 0 ? { at: parsed.fetchedAt, models } : null;
  } catch {
    return null;
  }
}

async function writeCache(path: string, at: number, models: AiModel[]): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify({ fetchedAt: at, models }));
    await rename(tmp, path);
  } catch {
    /* a cache that cannot be written is only a missed optimisation */
  }
}

function message(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError') return 'The request timed out.';
    const cause = (err as { cause?: { message?: string } }).cause?.message;
    return cause ? `${err.message} (${cause})` : err.message;
  }
  return String(err);
}

export type ListOpenRouterDeps = {
  cachePath: string;
  url?: string;
  now?: () => number;
  fetchFn?: FetchFn;
};

/**
 * OpenRouter's catalogue: from the cache while it is under 6 h old (unless
 * `refresh`), else fetched. When the fetch fails the cache is served with
 * `error` set; with no cache the list is empty.
 */
export async function listOpenRouterModels(
  opts: { refresh?: boolean },
  deps: ListOpenRouterDeps,
): Promise<AiModelsResult> {
  const now = (deps.now ?? Date.now)();
  const cached = await readCache(deps.cachePath, now);
  if (cached && !opts.refresh && now - cached.at < MODELS_CACHE_TTL_MS && now >= cached.at) {
    return { models: cached.models, fetchedAt: cached.at, source: 'cache' };
  }
  try {
    const body = await getJson(deps.url ?? MODELS_URL, deps.fetchFn ?? fetch);
    const models = normalizeOpenRouterModels(body, now);
    if (models.length === 0) throw new Error('The response had no models.');
    await writeCache(deps.cachePath, now, models);
    return { models, fetchedAt: now, source: 'live' };
  } catch (err) {
    const error = message(err);
    if (cached) return { models: cached.models, fetchedAt: cached.at, source: 'cache', error };
    return { models: [], fetchedAt: 0, source: 'none', error };
  }
}

/** A local server's models. No cache; unreachable gives the same wording as a failed chat. */
export async function listLocalModels(
  localUrl: string | undefined,
  deps: { now?: () => number; fetchFn?: FetchFn } = {},
): Promise<AiModelsResult> {
  const now = (deps.now ?? Date.now)();
  const target = resolveLocalModelsUrl(localUrl);
  if (!target.ok) return { models: [], fetchedAt: 0, source: 'none', error: target.error };
  try {
    const body = await getJson(target.url, deps.fetchFn ?? fetch);
    return { models: normalizeLocalModels(body), fetchedAt: now, source: 'live' };
  } catch {
    return {
      models: [],
      fetchedAt: 0,
      source: 'none',
      error: `Could not reach the local model at ${localUrl?.trim() ?? target.url}. Is Ollama (or LM Studio) running?`,
    };
  }
}
