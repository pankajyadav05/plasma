import { OPENSEARCH_URL, registerOpenSearchConformance } from './opensearch-suite';

// Needs a server: PLASMA_LIVE_OS=http://host:port (security plugin disabled)
registerOpenSearchConformance({ enabled: Boolean(OPENSEARCH_URL) });
