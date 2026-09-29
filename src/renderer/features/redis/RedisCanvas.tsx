import { TabStrip } from '@/features/editor/TabStrip';
import { useActiveTab, useSession } from '@/stores/session';
import { REDIS_TAB_KINDS } from '@/stores/session-redis';
import { RedisAnalyzeView } from './RedisAnalyzeView';
import { RedisCliView } from './RedisCliView';
import { RedisHomeView } from './RedisHomeView';
import { RedisKeyView } from './RedisKeyView';
import { RedisPubsubView } from './RedisPubsubView';
import { RedisServerView } from './RedisServerView';
import { RedisSlowlogView } from './RedisSlowlogView';

/**
 * Redis canvas — picks which view to render based on the active tab.
 *
 *   - redis-key      → RedisKeyView (single-key inspector + edit forms)
 *   - redis-cli      → RedisCliView (free-form command terminal)
 *   - redis-pubsub   → RedisPubsubView (live tail of one channel)
 *   - redis-analyze  → RedisAnalyzeView (memory analyzer)
 *   - redis-slowlog  → RedisSlowlogView (SLOWLOG GET table)
 *   - redis-server   → RedisServerView (INFO / CLIENT LIST / CONFIG GET)
 *   - other          → RedisHomeView (server info + getting-started cues)
 */

export function RedisCanvas() {
  const tab = useActiveTab();
  const hasTabs = tab ? REDIS_TAB_KINDS.has(tab.kind) : false;
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--wb-content)] text-[var(--wb-text)]">
      {hasTabs && <TabStrip />}
      <RedisBody />
    </main>
  );
}

function RedisBody() {
  const tab = useActiveTab();
  const sidebarDb = useSession((s) => s.redisDb as number);
  if (!tab) return <RedisHomeView />;
  if (tab.kind === 'redis-key' && tab.redisKey) {
    // Keyed by tab + key + db so switching keys starts from a clean view
    // (selection, string mode, inspected row) instead of flashing stale state.
    const db = tab.redisDb ?? sidebarDb;
    return <RedisKeyView key={`${tab.id}:${db}:${tab.redisKey}`} keyName={tab.redisKey} db={db} />;
  }
  if (tab.kind === 'redis-cli') return <RedisCliView key={tab.id} tabId={tab.id} />;
  if (tab.kind === 'redis-pubsub' && tab.redisChannel) {
    return (
      <RedisPubsubView
        key={tab.id}
        tabId={tab.id}
        channel={tab.redisChannel}
        pattern={tab.redisPattern === true}
      />
    );
  }
  if (tab.kind === 'redis-analyze') return <RedisAnalyzeView key={tab.id} tabId={tab.id} />;
  if (tab.kind === 'redis-server') return <RedisServerView key={tab.id} />;
  if (tab.kind === 'redis-slowlog') return <RedisSlowlogView />;
  return <RedisHomeView />;
}
