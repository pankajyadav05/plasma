import { mysqlFixture, mysqlLiveEnv } from './fixtures/mysql';
import { registerSqlConformance } from './sql-suite';

// Needs a server: PLASMA_LIVE_MYSQL=1 [PLASMA_MYSQL_HOST/PORT/USER/PASSWORD]
registerSqlConformance(mysqlFixture('mysql'), { enabled: mysqlLiveEnv('mysql').enabled });
