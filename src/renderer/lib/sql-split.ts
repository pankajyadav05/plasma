/**
 * Re-export the shared SQL statement splitter so renderer imports stay
 * stable (`@/lib/sql-split`) while workers/main use `@shared/sql-statements`.
 */
export { isSingleSqlStatement, splitSqlStatements } from '@shared/sql-statements';
