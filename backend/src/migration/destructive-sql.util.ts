/**
 * Matches the destructive DDL operations a schema migration's contract phase could run:
 * dropping a column, dropping a table, or truncating one. Deliberately conservative (a
 * simple keyword match, not a full SQL parser) — false positives just mean an extra
 * confirmation step, while false negatives would defeat the whole safety gate (#971).
 */
const DESTRUCTIVE_SQL_PATTERN = /\bDROP\s+COLUMN\b|\bDROP\s+TABLE\b|\bTRUNCATE\b/i;

/** Returns the subset of `statements` that look like a destructive DDL operation. */
export function findDestructiveStatements(statements: string[]): string[] {
  return statements.filter(sql => DESTRUCTIVE_SQL_PATTERN.test(sql));
}
