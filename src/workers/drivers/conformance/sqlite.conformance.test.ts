import { sqliteFixture } from './fixtures/sqlite';
import { registerSqlConformance } from './sql-suite';

// Embedded: runs in every `vitest run`.
registerSqlConformance(sqliteFixture(), { enabled: true });
