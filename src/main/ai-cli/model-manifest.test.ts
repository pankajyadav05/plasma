import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BUNDLED_MANIFEST,
  MANIFEST_RETRY_MS,
  MANIFEST_TTL_MS,
  MANIFEST_URL,
  type Manifest,
  ManifestSchema,
  createManifestStore,
  resolveManifestUrl,
} from './model-manifest';

const withDate = (updatedAt: string, mutate?: (m: Manifest) => void): Manifest => {
  const m = structuredClone(BUNDLED_MANIFEST);
  m.updatedAt = updatedAt;
  mutate?.(m);
  return m;
};

const json = (body: unknown, ok = true) =>
  ({
    ok,
    status: ok ? 200 : 500,
    headers: new Headers(),
    text: async () => JSON.stringify(body),
  }) as Response;

describe('manifest schema', () => {
  it('the bundled manifest parses and names both providers', () => {
    expect(BUNDLED_MANIFEST.version).toBe(1);
    expect(BUNDLED_MANIFEST.providers['claude-code'].defaults?.chat).toBe('claude-fable-5-1');
    expect(BUNDLED_MANIFEST.providers['claude-code'].models.length).toBeGreaterThan(5);
    expect(BUNDLED_MANIFEST.providers.codex.models.some((m) => m.status === 'legacy')).toBe(true);
  });

  it('refuses duplicate slugs, a missing profile, a missing default, a bad version range', () => {
    const bad = (mutate: (m: Manifest) => void) =>
      ManifestSchema.safeParse(withDate('2026-10-14T00:00:00Z', mutate)).success;
    expect(bad(() => undefined)).toBe(true);
    expect(
      bad((m) => {
        m.providers.codex.models.push({ ...m.providers.codex.models[0]! });
      }),
    ).toBe(false);
    expect(
      bad((m) => {
        m.providers['claude-code'].models[0]!.profile = 'nope';
      }),
    ).toBe(false);
    expect(
      bad((m) => {
        m.providers['claude-code'].defaults = { chat: 'claude-nothing' };
      }),
    ).toBe(false);
    expect(
      bad((m) => {
        m.providers['claude-code'].models[0]!.adapter = {
          claudeCode: { minVersion: '2.1.9', maxVersionExclusive: '2.1.1' },
        };
      }),
    ).toBe(false);
  });

  it('carries no Ultracode / Ultrathink effort and no fast-mode switch', () => {
    const text = readFileSync(join(__dirname, '../../shared/cli-model-manifest.json'), 'utf8');
    expect(text).not.toMatch(/ultracode|ultrathink|fastMode/i);
  });

  it('honours the URL override only for raw.githubusercontent.com or loopback', () => {
    expect(resolveManifestUrl(undefined)).toBe(MANIFEST_URL);
    expect(resolveManifestUrl('http://127.0.0.1:9/m.json')).toBe('http://127.0.0.1:9/m.json');
    expect(resolveManifestUrl('https://raw.githubusercontent.com/x/y/z.json')).toBe(
      'https://raw.githubusercontent.com/x/y/z.json',
    );
    expect(resolveManifestUrl('https://evil.example/m.json')).toBe(MANIFEST_URL);
  });
});

describe('manifest store', () => {
  let dir = '';
  let cache = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plasma-manifest-'));
    cache = join(dir, 'cli-model-manifest.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const remote = withDate('2026-11-01T00:00:00Z', (m) => {
    m.providers['claude-code'].models[0]!.name = 'Remote name';
  });

  it('prefers a good remote copy and writes it to disk', async () => {
    let calls = 0;
    const store = createManifestStore({
      cachePath: cache,
      fetchFn: async () => {
        calls++;
        return json(remote);
      },
    });
    expect((await store.current()).providers['claude-code'].models[0]?.name).not.toBe(
      'Remote name',
    );
    const got = await store.refresh();
    expect(got.providers['claude-code'].models[0]?.name).toBe('Remote name');
    expect((await store.current()).updatedAt).toBe('2026-11-01T00:00:00Z');
    expect(JSON.parse(readFileSync(cache, 'utf8')).manifest.updatedAt).toBe('2026-11-01T00:00:00Z');
    expect(calls).toBe(1);
  });

  it('ignores a remote copy that fails the schema, or an older one', async () => {
    const broken = createManifestStore({
      cachePath: cache,
      fetchFn: async () => json({ version: 1, providers: {} }),
    });
    expect((await broken.refresh()).updatedAt).toBe(BUNDLED_MANIFEST.updatedAt);
    const old = createManifestStore({
      cachePath: cache,
      fetchFn: async () => json(withDate('2020-01-01T00:00:00Z')),
    });
    expect((await old.refresh()).updatedAt).toBe(BUNDLED_MANIFEST.updatedAt);
    const http = createManifestStore({
      cachePath: cache,
      fetchFn: async () => json(remote, false),
    });
    expect((await http.refresh()).updatedAt).toBe(BUNDLED_MANIFEST.updatedAt);
  });

  it('falls back to the last good copy on disk when offline', async () => {
    writeFileSync(cache, JSON.stringify({ fetchedAtMs: 1, manifest: remote }));
    const store = createManifestStore({
      cachePath: cache,
      now: () => 10 * MANIFEST_TTL_MS,
      fetchFn: async () => {
        throw new Error('offline');
      },
    });
    expect((await store.current()).updatedAt).toBe('2026-11-01T00:00:00Z');
    // Offline: a refresh keeps the disk copy and does not throw.
    expect((await store.refresh()).updatedAt).toBe('2026-11-01T00:00:00Z');
  });

  it('a disk copy older than the bundle is dropped; a broken file is ignored', async () => {
    writeFileSync(
      cache,
      JSON.stringify({ fetchedAtMs: 1, manifest: withDate('2020-01-01T00:00:00Z') }),
    );
    const older = createManifestStore({ cachePath: cache });
    expect((await older.current()).updatedAt).toBe(BUNDLED_MANIFEST.updatedAt);
    writeFileSync(cache, '{ not json');
    const broken = createManifestStore({ cachePath: cache });
    expect((await broken.current()).updatedAt).toBe(BUNDLED_MANIFEST.updatedAt);
  });

  it('fetches at most once per hour, and waits 5 minutes after a failure', async () => {
    let t = 1_000_000;
    let calls = 0;
    let fail = true;
    const store = createManifestStore({
      cachePath: cache,
      now: () => t,
      fetchFn: async () => {
        calls++;
        if (fail) throw new Error('offline');
        return json(remote);
      },
    });
    await store.refresh();
    await store.refresh();
    expect(calls).toBe(1);
    t += MANIFEST_RETRY_MS - 1;
    await store.refresh();
    expect(calls).toBe(1);
    t += 2;
    fail = false;
    await store.refresh();
    expect(calls).toBe(2);
    t += MANIFEST_TTL_MS - 1;
    await store.refresh();
    expect(calls).toBe(2);
    t += 2;
    await store.refresh();
    expect(calls).toBe(3);
    await store.refresh(true);
    expect(calls).toBe(4);
  });

  it('never throws offline', async () => {
    const store = createManifestStore({
      cachePath: join(dir, 'no', 'such', 'dir', 'm.json'),
      fetchFn: async () => {
        throw new Error('offline');
      },
    });
    await expect(store.refresh()).resolves.toBeTruthy();
    expect(() => store.refreshInBackground()).not.toThrow();
  });
});
