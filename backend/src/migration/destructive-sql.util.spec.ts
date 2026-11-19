import { findDestructiveStatements } from './destructive-sql.util';

describe('findDestructiveStatements', () => {
  it('flags DROP COLUMN statements, case-insensitively', () => {
    expect(findDestructiveStatements(['alter table gigs drop column urgent'])).toEqual([
      'alter table gigs drop column urgent',
    ]);
  });

  it('flags DROP TABLE statements', () => {
    expect(findDestructiveStatements(['DROP TABLE stale_sessions'])).toEqual([
      'DROP TABLE stale_sessions',
    ]);
  });

  it('flags TRUNCATE statements', () => {
    expect(findDestructiveStatements(['TRUNCATE audit_log'])).toEqual(['TRUNCATE audit_log']);
  });

  it('does not flag additive DDL', () => {
    expect(
      findDestructiveStatements([
        'ALTER TABLE gigs ADD COLUMN priority INT',
        'CREATE INDEX idx_gigs_priority ON gigs(priority)',
        'UPDATE gigs SET priority = 1 WHERE priority IS NULL',
      ]),
    ).toEqual([]);
  });

  it('only returns the statements that match, preserving order', () => {
    const statements = [
      'ALTER TABLE gigs ADD COLUMN priority_new TEXT',
      'ALTER TABLE gigs DROP COLUMN priority',
      'ALTER TABLE gigs RENAME COLUMN priority_new TO priority',
    ];
    expect(findDestructiveStatements(statements)).toEqual([
      'ALTER TABLE gigs DROP COLUMN priority',
    ]);
  });

  it('returns an empty array for an empty input', () => {
    expect(findDestructiveStatements([])).toEqual([]);
  });
});
