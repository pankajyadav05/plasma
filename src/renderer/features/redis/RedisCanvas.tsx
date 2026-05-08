import { TabStrip } from '@/features/editor/TabStrip';
import { useActiveTab } from '@/stores/session';
import { RedisAnalyzeView } from './RedisAnalyzeView';
import { RedisCliView } from './RedisCliView';
import { RedisHomeView } from './RedisHomeView';
import { RedisKeyView } from './RedisKeyView';
import { RedisPubsubView } from './RedisPubsubView';
import { RedisSlowlogView } from './RedisSlowlogView';

/**
 * Redis canvas — picks which view to render based on the active tab.
 *
 *   - redis-key      → RedisKeyView (single-key inspector + edit forms)
 *   - redis-cli      → RedisCliView (free-form command terminal)
 *   - redis-pubsub   → RedisPubsubView (live tail of one channel)
 *   - redis-analyze  → RedisAnalyzeView (memory analyzer)
 *   - redis-slowlog  → RedisSlowlogView (SLOWLOG GET table)
 *   - other          → RedisHomeView (server info + getting-started cues)
 */
const REDIS_TAB_KINDS = new Set([
  'redis-key',
  'redis-cli',
  'redis-pubsub',
  'redis-analyze',
  'redis-slowlog',
]);

export function RedisCanvas() {
  const tab = useActiveTab();
  const hasTabs = tab ? REDIS_TAB_KINDS.has(tab.kind) : false;
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      {hasTabs && <TabStrip />}
      <RedisBody />
    </main>
  );
}

function RedisBody() {
  const tab = useActiveTab();
  if (!tab) return <RedisHomeView />;
  if (tab.kind === 'redis-key' && tab.redisKey) {
    return <RedisKeyView keyName={tab.redisKey} />;
  }
  if (tab.kind === 'redis-cli') return <RedisCliView />;
  if (tab.kind === 'redis-pubsub' && tab.redisChannel) {
    return (
      <RedisPubsubView channel={tab.redisChannel} pattern={tab.redisPattern === true} />
    );
  }
  if (tab.kind === 'redis-analyze') return <RedisAnalyzeView />;
  if (tab.kind === 'redis-slowlog') return <RedisSlowlogView />;
  return <RedisHomeView />;
}
