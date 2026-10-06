import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MODELS_CACHE_TTL_MS,
  MODELS_MAX_BYTES,
  MODELS_URL,
  listLocalModels,
  listOpenRouterModels,
  resolveLocalModelsUrl,
  resolveModelsUrl,
} from './ai-models';

const NOW = Date.UTC(2026, 9, 6);
const created = Math.floor(NOW / 1000) - 86_400;

const item = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: `Acme: ${id}`,
  created,
  context_length: 8000,
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  pricing: { prompt: '0.000001', completion: '0.000002' },
  supported_parameters: ['tools'],
  ...over,
});

let server: Server;
let base = '';
let hits = 0;
let handler: (url: string) => { status?: number; body?: unknown; raw?: string; location?: string };

beforeAll(async () => {
  server = createServer((req, res) => {
    hits++;
    const r = handler(req.url ?? '/');
    if (r.location) {
      res.writeHead(302, { location: r.location });
      res.end();
      return;
    }
    res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
    res.end(r.raw ?? JSON.stringify(r.body ?? {}));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

let dir = '';
let cachePath = '';
beforeEach(async () => {
  hits = 0;
  handler = () => ({ body: { data: [item('acme/a'), item('acme/b:batch')] } });
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = await mkdtemp(join(tmpdir(), 'plasma-models-'));
  cachePath = join(dir, 'ai-models.json');
});

const deps = (now = NOW) => ({ cachePath, url: `${base}/models`, now: () => now });

describe('listOpenRouterModels', () => {
  it('fetches live, filters, and writes the cache', async () => {
    const r = await listOpenRouterModels({}, deps());
    expect(r.source).toBe('live');
    expect(r.fetchedAt).toBe(NOW);
    expect(r.models.map((m) => m.id)).toEqual(['acme/a']);
    const file = JSON.parse(await readFile(cachePath, 'utf8'));
    expect(file.fetchedAt).toBe(NOW);
    expect(file.models).toHaveLength(1);
  });

  it('serves a cache younger than 6 h without a request', async () => {
    await listOpenRouterModels({}, deps());
    const r = await listOpenRouterModels({}, deps(NOW + MODELS_CACHE_TTL_MS - 1000));
    expect(r.source).toBe('cache');
    expect(r.fetchedAt).toBe(NOW);
    expect(hits).toBe(1);
  });

  it('refetches once the cache is 6 h old, and on refresh', async () => {
    await listOpenRouterModels({}, deps());
    expect((await listOpenRouterModels({}, deps(NOW + MODELS_CACHE_TTL_MS))).source).toBe('live');
    expect((await listOpenRouterModels({ refresh: true }, deps(NOW + 1000))).source).toBe('live');
    expect(hits).toBe(3);
  });

  it('falls back to the cache with an error when the fetch fails', async () => {
    await listOpenRouterModels({}, deps());
    handler = () => ({ status: 500, raw: 'boom' });
    const r = await listOpenRouterModels({ refresh: true }, deps(NOW + 1000));
    expect(r.source).toBe('cache');
    expect(r.fetchedAt).toBe(NOW);
    expect(r.models).toHaveLength(1);
    expect(r.error).toContain('500');
  });

  it('returns an empty list with an error when there is no cache', async () => {
    handler = () => ({ status: 503 });
    const r = await listOpenRouterModels({}, deps());
    expect(r).toMatchObject({ models: [], source: 'none', fetchedAt: 0 });
    expect(r.error).toContain('503');
  });

  it('treats an empty or junk body as a failure and keeps the cache', async () => {
    await listOpenRouterModels({}, deps());
    handler = () => ({ raw: 'not json' });
    expect((await listOpenRouterModels({ refresh: true }, deps(NOW + 1))).source).toBe('cache');
    handler = () => ({ body: { data: [] } });
    expect((await listOpenRouterModels({ refresh: true }, deps(NOW + 1))).error).toBeTruthy();
  });

  it('drops one bad item without failing the list', async () => {
    handler = () => ({ body: { data: [item('acme/a'), { id: 5 }, null, item('acme/c')] } });
    const r = await listOpenRouterModels({}, deps());
    expect(r.models.map((m) => m.id)).toEqual(['acme/a', 'acme/c']);
  });

  it('drops expired models, also from a cache written earlier', async () => {
    const soon = Math.floor(NOW / 1000) + 3600;
    handler = () => ({
      body: {
        data: [
          item('acme/gone', { expiration_date: '2026-01-01' }),
          item('acme/soon', { expiration_date: soon }),
        ],
      },
    });
    const live = await listOpenRouterModels({}, deps());
    expect(live.models.map((m) => m.id)).toEqual(['acme/soon']);
    const later = await listOpenRouterModels({}, deps(NOW + 2 * 3600_000));
    expect(later.models).toEqual([]);
  });

  it('ignores a corrupt cache file', async () => {
    await writeFile(cachePath, '{nope');
    expect((await listOpenRouterModels({}, deps())).source).toBe('live');
  });

  it('refuses an oversize body', async () => {
    handler = () => ({ raw: `{"data":"${'x'.repeat(MODELS_MAX_BYTES)}"}` });
    const r = await listOpenRouterModels({}, deps());
    expect(r.source).toBe('none');
    expect(r.error).toContain('too large');
  });

  it('does not follow a redirect', async () => {
    handler = () => ({ location: 'http://127.0.0.1:1/elsewhere' });
    const r = await listOpenRouterModels({}, deps());
    expect(r.source).toBe('none');
    expect(r.error).toBeTruthy();
  });
});

describe('resolveModelsUrl', () => {
  it('honours loopback and openrouter.ai only', () => {
    expect(resolveModelsUrl(undefined)).toBe(MODELS_URL);
    expect(resolveModelsUrl('http://127.0.0.1:9/models')).toBe('http://127.0.0.1:9/models');
    expect(resolveModelsUrl('http://localhost:9/m')).toBe('http://localhost:9/m');
    expect(resolveModelsUrl('https://openrouter.ai/x')).toBe('https://openrouter.ai/x');
    expect(resolveModelsUrl('https://evil.example/models')).toBe(MODELS_URL);
    expect(resolveModelsUrl('http://openrouter.ai/x')).toBe(MODELS_URL);
    expect(resolveModelsUrl('ftp://127.0.0.1/x')).toBe(MODELS_URL);
    expect(resolveModelsUrl('nonsense')).toBe(MODELS_URL);
  });
});

describe('local models', () => {
  it('derives /models from the base url and rejects non-loopback hosts', () => {
    expect(resolveLocalModelsUrl('http://127.0.0.1:11434/v1')).toEqual({
      ok: true,
      url: 'http://127.0.0.1:11434/v1/models',
    });
    expect(resolveLocalModelsUrl('http://localhost:1234/v1/chat/completions/')).toEqual({
      ok: true,
      url: 'http://localhost:1234/v1/models',
    });
    expect(resolveLocalModelsUrl('https://example.com/v1').ok).toBe(false);
    expect(resolveLocalModelsUrl('http://user:pw@127.0.0.1/v1').ok).toBe(false);
    expect(resolveLocalModelsUrl('').ok).toBe(false);
  });

  it('lists the server models without caching', async () => {
    handler = (url) => ({ body: url === '/v1/models' ? { data: [{ id: 'llama3.1' }] } : {} });
    const r = await listLocalModels(`${base}/v1`, { now: () => NOW });
    expect(r.source).toBe('live');
    expect(r.models.map((m) => m.id)).toEqual(['llama3.1']);
  });

  it('says so when the server is unreachable', async () => {
    const r = await listLocalModels('http://127.0.0.1:1/v1');
    expect(r.models).toEqual([]);
    expect(r.error).toContain('Could not reach the local model at http://127.0.0.1:1/v1');
  });

  it('never sends a request to a non-loopback url', async () => {
    let called = false;
    const r = await listLocalModels('https://example.com/v1', {
      fetchFn: (async () => {
        called = true;
        return new Response('{}');
      }) as typeof fetch,
    });
    expect(called).toBe(false);
    expect(r.error).toContain('localhost');
  });
});
