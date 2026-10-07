import { mysqlFixture, mysqlLiveEnv } from './fixtures/mysql';
import { registerSqlConformance } from './sql-suite';

// Needs a server: PLASMA_LIVE_MARIADB=1 [PLASMA_MARIADB_HOST/PORT/USER/PASSWORD]
registerSqlConformance(mysqlFixture('mariadb'), { enabled: mysqlLiveEnv('mariadb').enabled });
