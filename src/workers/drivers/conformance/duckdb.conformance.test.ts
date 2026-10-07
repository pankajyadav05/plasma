import { duckdbFixture } from './fixtures/duckdb';
import { registerSqlConformance } from './sql-suite';

// Embedded: runs in every `vitest run`.
registerSqlConformance(duckdbFixture(), { enabled: true });
