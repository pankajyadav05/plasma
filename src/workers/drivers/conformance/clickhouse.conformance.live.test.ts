import { clickhouseFixture, clickhouseLiveEnv } from './fixtures/clickhouse';
import { registerSqlConformance } from './sql-suite';

// Needs a server: PLASMA_LIVE_CLICKHOUSE=1 [PLASMA_CLICKHOUSE_HOST/PORT/USER/PASSWORD]
registerSqlConformance(clickhouseFixture(), { enabled: clickhouseLiveEnv().enabled });
