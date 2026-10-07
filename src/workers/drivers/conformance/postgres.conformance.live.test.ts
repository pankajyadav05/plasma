import { POSTGRES_URL, postgresFixture } from './fixtures/postgres';
import { registerSqlConformance } from './sql-suite';

// Needs a server: PLASMA_LIVE_PG=postgres://user:pass@host:port/db
registerSqlConformance(postgresFixture(), { enabled: Boolean(POSTGRES_URL) });
