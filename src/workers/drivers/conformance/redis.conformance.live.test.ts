import { REDIS_URL, registerRedisConformance } from './redis-suite';

// Needs a server: PLASMA_LIVE_REDIS=redis://host:port
registerRedisConformance({ enabled: Boolean(REDIS_URL) });
