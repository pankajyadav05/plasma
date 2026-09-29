import type { WorkerRequest, WorkerResponse } from '@shared/protocol';
import type { RedisDriver } from './redis';

type RedisRequest = Extract<WorkerRequest, { kind: `redis${string}` }>;

/** True for every request the Redis driver handles. */
export function isRedisRequest(req: WorkerRequest): req is RedisRequest {
  return req.kind.startsWith('redis');
}

/**
 * Route one Redis request to the driver and send its response. Kept out
 * of workers/index.ts so Redis request kinds can grow without touching the
 * shared dispatcher. Response kinds must match what main's callWorker
 * expects (see redis-dispatch.test.ts, S4).
 */
export async function dispatchRedis(
  redis: RedisDriver,
  req: RedisRequest,
  send: (res: WorkerResponse) => void,
): Promise<void> {
  switch (req.kind) {
    case 'redisScan': {
      const result = await redis.scan({
        cursor: req.cursor,
        match: req.match,
        count: req.count,
        db: req.db,
        minResults: req.minResults,
        budgetMs: req.budgetMs,
        type: req.type,
      });
      send({ kind: 'redisScan', id: req.id, result });
      return;
    }
    case 'redisGetKey': {
      const result = await redis.getKey(req.key, req.opts ?? {});
      send({ kind: 'redisKey', id: req.id, result });
      return;
    }
    case 'redisDeleteKey':
      await redis.deleteKey(req.key, req.db);
      send({ kind: 'redisAck', id: req.id });
      return;
    case 'redisSetTtl':
      await redis.setTtl(req.key, req.seconds, req.db, req.mode);
      send({ kind: 'redisAck', id: req.id });
      return;
    case 'redisCommand': {
      const result = await redis.command(req.parts, req.db);
      send({ kind: 'redisCommand', id: req.id, result });
      return;
    }
    case 'redisOverview': {
      const info = await redis.refreshOverview();
      send({ kind: 'redisOverview', id: req.id, info });
      return;
    }
    case 'redisAnalyze': {
      const result = await redis.analyze({
        sampleCap: req.sampleCap,
        match: req.match,
        db: req.db,
      });
      send({ kind: 'redisAnalyze', id: req.id, result });
      return;
    }
    case 'redisSlowlog': {
      const entries = await redis.slowlog(req.limit);
      send({ kind: 'redisSlowlog', id: req.id, entries });
      return;
    }
    case 'redisBulkDelete': {
      const result = await redis.bulkDelete(req.keys, req.db);
      send({ kind: 'redisBulkDelete', id: req.id, result });
      return;
    }
    case 'redisDeleteByPattern': {
      const result = await redis.deleteByPattern({
        match: req.match,
        db: req.db,
        dryRun: req.dryRun,
        limit: req.limit,
      });
      send({ kind: 'redisPatternDelete', id: req.id, result });
      return;
    }
    case 'redisCancel':
      redis.cancel();
      send({ kind: 'redisAck', id: req.id });
      return;
    case 'redisWrite':
      await redis.write(req.op, req.db);
      send({ kind: 'redisAck', id: req.id });
      return;
    case 'redisSubscribe':
      await redis.subscribe(req.channel, req.pattern);
      send({ kind: 'redisAck', id: req.id });
      return;
    case 'redisUnsubscribe':
      await redis.unsubscribe(req.channel, req.pattern);
      send({ kind: 'redisAck', id: req.id });
      return;
  }
}

/**
 * Response kind main must pass to callWorker for each Redis request kind.
 * The single source of truth that R1 violated; asserted in tests.
 */
export const REDIS_RESPONSE_KIND = {
  redisScan: 'redisScan',
  redisGetKey: 'redisKey',
  redisDeleteKey: 'redisAck',
  redisSetTtl: 'redisAck',
  redisCommand: 'redisCommand',
  redisOverview: 'redisOverview',
  redisAnalyze: 'redisAnalyze',
  redisSlowlog: 'redisSlowlog',
  redisBulkDelete: 'redisBulkDelete',
  redisDeleteByPattern: 'redisPatternDelete',
  redisCancel: 'redisAck',
  redisWrite: 'redisAck',
  redisSubscribe: 'redisAck',
  redisUnsubscribe: 'redisAck',
} as const satisfies Record<RedisRequest['kind'], WorkerResponse['kind']>;
