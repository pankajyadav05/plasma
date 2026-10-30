import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IpcChannel } from '@shared/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalyticsService } from './analytics';
import { resolveTelemetryConfig } from './config';
import { FEATURE_BY_CHANNEL, durationBucket, featureForChannel } from './events';
import { readOrCreateInstallId } from './identity';

interface SentEvent {
  uuid: string;
  event: string;
  distinct_id: string;
  timestamp: string;
  properties: Record<string, unknown>;
}

const INSTALL_ID = 'a'.repeat(64);

function harness(respond: () => Response | Promise<Response>, enabled = true) {
  const batches: SentEvent[][] = [];
  const urls: string[] = [];
  const installId = vi.fn((): string | null => INSTALL_ID);
  const log = { warn: vi.fn(), debug: vi.fn() };
  const service = new AnalyticsService(
    {
      posthogKey: 'phc_test',
      posthogHost: 'https://ph.test',
      common: { appVersion: '1.2.3', platform: 'linux' },
      installId,
      log,
      fetch: (async (url: string, init: RequestInit) => {
        urls.push(url);
        batches.push(JSON.parse(String(init.body)).batch);
        return respond();
      }) as typeof fetch,
    },
    enabled,
  );
  return { service, batches, urls, installId, log };
}

const status = (code: number) => () => new Response(null, { status: code });

function recordTwenty(service: AnalyticsService) {
  for (let i = 0; i < 20; i++) service.record('feature.used', { feature: 'sql.format' });
}

describe('AnalyticsService delivery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drains every buffered event across batches on flush', async () => {
    const { service, batches, urls } = harness(status(200));
    for (let i = 0; i < 45; i++) service.record('feature.used', { feature: 'sql.format' });
    await service.flush();
    expect(batches.map((b) => b.length)).toEqual([20, 20, 5]);
    expect(urls.every((u) => u === 'https://ph.test/batch/')).toBe(true);
    expect(service.hasPending()).toBe(false);
  });

  it('sends the event with its common properties and no person profile', async () => {
    const { service, batches } = harness(status(200));
    service.record('query.executed', { engine: 'postgres', status: 'ok', source: 'editor' });
    await service.flush();
    const [event] = batches[0] as SentEvent[];
    expect(event?.event).toBe('query.executed');
    expect(event?.distinct_id).toBe(INSTALL_ID);
    expect(event?.properties).toEqual({
      engine: 'postgres',
      status: 'ok',
      source: 'editor',
      appVersion: '1.2.3',
      platform: 'linux',
      installId: INSTALL_ID,
      $process_person_profile: false,
      $geoip_disable: true,
    });
  });

  it('keeps a failed batch through a 20-minute outage and resends the same events once after', async () => {
    let healthy = false;
    const { service, batches } = harness(() => new Response(null, { status: healthy ? 200 : 503 }));
    service.start();
    recordTwenty(service);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    healthy = true;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const ids = new Set(batches.map((b) => b.map((e) => e.uuid).join()));
    expect(ids.size).toBe(1);
    expect(service.hasPending()).toBe(false);
    const sendsBefore = batches.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(batches.length).toBe(sendsBefore);
  });

  it('backs off between retries instead of sending on every check', async () => {
    const { service, batches } = harness(status(503));
    service.start();
    recordTwenty(service);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    // A send on every 10-second check would be 60.
    expect(batches.length).toBeLessThan(15);
    await service.shutdown(0);
  });

  it('drops a batch that keeps failing for 30 minutes', async () => {
    const { service, batches, log } = harness(status(503));
    service.start();
    recordTwenty(service);
    await vi.advanceTimersByTimeAsync(40 * 60_000);
    expect(service.hasPending()).toBe(false);
    const sends = batches.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(batches.length).toBe(sends);
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it('retries after a network error, not only a bad status', async () => {
    let calls = 0;
    const { service, batches } = harness(() => {
      calls++;
      if (calls === 1) throw new Error('getaddrinfo ENOTFOUND');
      return new Response(null, { status: 200 });
    });
    service.start();
    recordTwenty(service);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(batches.length).toBe(2);
    expect(service.hasPending()).toBe(false);
  });

  it('drops a batch the endpoint rejects without sending it again', async () => {
    const { service, batches } = harness(status(401));
    service.start();
    recordTwenty(service);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(batches.length).toBe(1);
  });

  it('keeps only the newest events when the buffer is full', async () => {
    const { service, batches } = harness(status(200));
    service.record('connection.lost', {});
    for (let i = 0; i < 1_000; i++) service.record('feature.used', { feature: 'sql.format' });
    await service.flush();
    const events = batches.flat();
    expect(events.length).toBe(1_000);
    expect(events.some((e) => e.event === 'connection.lost')).toBe(false);
  });

  it('gives each event its own uuid', async () => {
    const { service, batches } = harness(status(200));
    recordTwenty(service);
    await service.flush();
    expect(new Set(batches.flat().map((e) => e.uuid)).size).toBe(20);
  });
});

describe('AnalyticsService opt-out', () => {
  it('sends nothing and creates no id while disabled', async () => {
    const { service, batches, installId } = harness(status(200), false);
    service.record('app.launched', { previousExit: 'clean' });
    await service.flush();
    expect(batches).toEqual([]);
    expect(installId).not.toHaveBeenCalled();
    expect(service.hasPending()).toBe(false);
  });

  it('forgets what was buffered when it is turned off', async () => {
    const { service, batches } = harness(status(200));
    recordTwenty(service);
    service.setEnabled(false);
    await service.flush();
    expect(batches).toEqual([]);
    expect(service.hasPending()).toBe(false);
  });

  it('forgets a failed batch when it is turned off mid-send', async () => {
    let release: (r: Response) => void = () => undefined;
    const { service, batches } = harness(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    recordTwenty(service);
    const flushed = service.flush();
    service.setEnabled(false);
    release(new Response(null, { status: 503 }));
    await flushed;
    expect(service.hasPending()).toBe(false);
    service.setEnabled(true);
    await service.flush();
    expect(batches.length).toBe(1);
  });

  it('records nothing when no install id can be saved', async () => {
    const { service, batches, installId } = harness(status(200));
    installId.mockReturnValue(null);
    service.record('app.launched', { previousExit: 'clean' });
    await service.flush();
    expect(batches).toEqual([]);
  });

  it('shuts down within its time limit and leaves nothing pending', async () => {
    const { service } = harness(() => new Promise<Response>(() => undefined));
    recordTwenty(service);
    await service.shutdown(5);
    service.record('app.launched', { previousExit: 'clean' });
    expect(service.hasPending()).toBe(false);
  });
});

describe('resolveTelemetryConfig', () => {
  const key = { PLASMA_POSTHOG_KEY: 'phc_x' };

  it('is on in a packaged build with a key', () => {
    expect(resolveTelemetryConfig(key, true).enabled).toBe(true);
  });

  it('is off without a key, even when forced on', () => {
    expect(resolveTelemetryConfig({ PLASMA_TELEMETRY_ENABLED: 'true' }, true, '').enabled).toBe(
      false,
    );
  });

  it.each([
    ['a dev run', {}, false],
    ['CI', { CI: 'true' }, true],
    ['an isolated profile', { PLASMA_USER_DATA: '/tmp/p' }, true],
    ['DO_NOT_TRACK', { DO_NOT_TRACK: '1' }, true],
    ['the off switch', { PLASMA_TELEMETRY_ENABLED: 'false' }, true],
    ['the off switch as 0', { PLASMA_TELEMETRY_ENABLED: '0' }, true],
  ])('is off for %s', (_name, env, packaged) => {
    expect(resolveTelemetryConfig({ ...key, ...env }, packaged).enabled).toBe(false);
  });

  it('ignores DO_NOT_TRACK=0 and CI=false', () => {
    expect(resolveTelemetryConfig({ ...key, DO_NOT_TRACK: '0', CI: 'false' }, true).enabled).toBe(
      true,
    );
  });

  it('can be forced on for a dev run', () => {
    expect(resolveTelemetryConfig({ ...key, PLASMA_TELEMETRY_ENABLED: '1' }, false).enabled).toBe(
      true,
    );
  });

  it('takes a host override without a trailing slash', () => {
    const config = resolveTelemetryConfig(
      { ...key, PLASMA_POSTHOG_HOST: 'https://eu.test/' },
      true,
    );
    expect(config.posthogHost).toBe('https://eu.test');
  });
});

describe('readOrCreateInstallId', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plasma-telemetry-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates a hashed id once and keeps it', () => {
    const first = readOrCreateInstallId(dir);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(readOrCreateInstallId(dir)).toBe(first);
    expect(readFileSync(join(dir, 'telemetry-id'), 'utf8')).toBe(first);
  });

  it('replaces a corrupt file', () => {
    writeFileSync(join(dir, 'telemetry-id'), 'not an id');
    expect(readOrCreateInstallId(dir)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns null when the id cannot be saved', () => {
    const notADir = join(dir, 'file');
    writeFileSync(notADir, '');
    expect(readOrCreateInstallId(join(notADir, 'nested'))).toBeNull();
  });
});

describe('event allowlists', () => {
  it('every feature channel is a real IPC channel', () => {
    const channels = new Set<string>(Object.values(IpcChannel));
    expect(Object.keys(FEATURE_BY_CHANNEL).filter((c) => !channels.has(c))).toEqual([]);
  });

  it('reports only allowlisted channels', () => {
    expect(featureForChannel(IpcChannel.ImportRun)).toBe('import.run');
    expect(featureForChannel(IpcChannel.ConnectionIntrospect)).toBeUndefined();
    expect(featureForChannel('toString')).toBeUndefined();
  });

  it('buckets durations', () => {
    expect([50, 500, 5_000, 30_000, 90_000].map(durationBucket)).toEqual([
      '<100ms',
      '<1s',
      '<10s',
      '<1m',
      '>=1m',
    ]);
  });
});
